/**
 * The starter tool surface — pi-shaped minimum.
 *
 *   bash, read, ls, grep, write, edit
 *
 * Each tool is a `UsTool` — a JSON Schema input + an async `execute` that
 * returns a string (which becomes the function_call_output sent back to the
 * model). Errors are caught and returned as text — never thrown — so the
 * model can recover.
 */
import { promises as fs } from "node:fs";
import { join, resolve as resolvePath, isAbsolute } from "node:path";
import { spawn } from "bun";
import type { ToolDefinition } from "@unionstreet/ai-codex";
import type { LashThread } from "@lashprotocol/lash";
import { resolveDelegationTargets } from "../federation.ts";
import { callLashPeerTool } from "../lash-mcp.ts";
import {
  lashEnvelopeValue,
  parseLashEnvelope,
  parseLashThread,
  type LashChainHop,
} from "../lash-context.ts";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export interface UsToolContext {
  /**
   * Working directory for relative-path tools. Defaults to `process.cwd()`
   * but normally a profile sets this to its workspace.
   */
  cwd: string;
  /** Optional AbortSignal cooperatively passed to long-running tools. */
  signal?: AbortSignal;
  /**
   * The profile that's running this agent loop. Used by `delegate` to
   * attribute peer-to-peer calls in the system prompt.
   */
  callingPeer?: string;
  /** Lash trace for cross-agent command correlation. */
  trace?: string;
  /** Lash thread for receiver-side continuity. */
  thread?: LashThread;
  /** Ordered chain of peer delegation hops. */
  chain?: LashChainHop[];
}

export interface UsTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: UsToolContext): Promise<string>;
}

// ---------- bash ----------

const bashTool: UsTool = {
  definition: {
    type: "function",
    name: "bash",
    description:
      "Execute a shell command via /bin/sh -c. Returns combined output truncated to 50KB. Use for anything filesystem/network/process related not covered by a more specific tool.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_ms: {
          type: "integer",
          description: "Hard timeout in ms (default 60000, max 300000).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const command = String(args.command ?? "");
    if (!command) return "error: command is required";
    const requested = Number(args.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS);
    const timeout = Math.min(Math.max(requested, 100), 300_000);

    const proc = spawn(["/bin/sh", "-c", command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);

    const exit = proc.exitCode ?? -1;
    const head = `exit ${exit}${timedOut ? " (TIMED OUT)" : ""}\n`;
    return truncate(head + sectionedOutput(stdout, stderr), MAX_OUTPUT_BYTES);
  },
};

// ---------- read ----------

const readTool: UsTool = {
  definition: {
    type: "function",
    name: "read",
    description:
      "Read a file. Optionally slice by line range. Returns up to 50KB; use offset/limit for larger files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path." },
        offset: { type: "integer", description: "1-indexed start line." },
        limit: { type: "integer", description: "Number of lines to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const path = resolveUnder(ctx.cwd, String(args.path ?? ""));
    if (!path) return "error: path is required";
    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch (e) {
      return `error: ${(e as NodeJS.ErrnoException).code ?? "read failed"}: ${path}`;
    }
    const offset = Number.isInteger(args.offset) ? Math.max(1, Number(args.offset)) : 1;
    const limit = Number.isInteger(args.limit) ? Math.max(1, Number(args.limit)) : undefined;
    if (offset !== 1 || limit !== undefined) {
      const lines = content.split("\n");
      const end = limit ? offset - 1 + limit : lines.length;
      const slice = lines.slice(offset - 1, end);
      return truncate(slice.map((l, i) => `${offset + i}\t${l}`).join("\n"), MAX_OUTPUT_BYTES);
    }
    return truncate(content, MAX_OUTPUT_BYTES);
  },
};

// ---------- ls ----------

const lsTool: UsTool = {
  definition: {
    type: "function",
    name: "ls",
    description: "List directory entries (one per line, with trailing slash for directories).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path. Default '.'." },
      },
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const path = resolveUnder(ctx.cwd, String(args.path ?? "."));
    if (!path) return "error: path resolution failed";
    let entries;
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch (e) {
      return `error: ${(e as NodeJS.ErrnoException).code ?? "readdir failed"}: ${path}`;
    }
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return truncate(lines.join("\n"), MAX_OUTPUT_BYTES);
  },
};

// ---------- grep ----------

const grepTool: UsTool = {
  definition: {
    type: "function",
    name: "grep",
    description:
      "Search file contents recursively. Uses ripgrep when available, falls back to grep -rE. Returns matching lines with file:line: prefix.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern." },
        path: { type: "string", description: "Directory or file (default '.')." },
        glob: {
          type: "string",
          description: "Optional glob filter (e.g. '*.ts'). Only used if rg is available.",
        },
        case_insensitive: { type: "boolean", description: "Default false." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return "error: pattern is required";
    const path = resolveUnder(ctx.cwd, String(args.path ?? "."));
    if (!path) return "error: path resolution failed";
    const ci = Boolean(args.case_insensitive);
    const glob = args.glob ? String(args.glob) : undefined;

    const hasRg = await commandExists("rg");
    const cmd = hasRg
      ? ["rg", "-n", "--no-heading", ci ? "-i" : null, glob ? `--glob=${glob}` : null, "--", pattern, path].filter(Boolean) as string[]
      : ["grep", "-rEn", ci ? "-i" : null, "--", pattern, path].filter(Boolean) as string[];

    const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const exit = proc.exitCode ?? -1;
    if (exit !== 0 && !stdout) {
      // grep/rg exit 1 on no matches — that's OK
      if (exit === 1) return "(no matches)";
      return `error: exit ${exit}: ${stderr.trim() || "(no stderr)"}`;
    }
    return truncate(stdout || "(no matches)", MAX_OUTPUT_BYTES);
  },
};

// ---------- write ----------

const writeTool: UsTool = {
  definition: {
    type: "function",
    name: "write",
    description:
      "Write a file (full overwrite). Creates parent dirs. Use `edit` to modify existing files surgically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const path = resolveUnder(ctx.cwd, String(args.path ?? ""));
    if (!path) return "error: path is required";
    const content = String(args.content ?? "");
    try {
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, content);
    } catch (e) {
      return `error: ${(e as NodeJS.ErrnoException).code ?? "write failed"}: ${path}`;
    }
    return `wrote ${content.length} bytes to ${path}`;
  },
};

// ---------- edit ----------

const editTool: UsTool = {
  definition: {
    type: "function",
    name: "edit",
    description:
      "Replace exactly one occurrence of `old` with `new` in the file at `path`. Errors if `old` is missing or appears multiple times. Set `replace_all: true` to override.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path." },
        old: { type: "string", description: "Exact substring to find." },
        new: { type: "string", description: "Replacement substring." },
        replace_all: { type: "boolean", description: "Replace every occurrence." },
      },
      required: ["path", "old", "new"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const path = resolveUnder(ctx.cwd, String(args.path ?? ""));
    if (!path) return "error: path is required";
    const oldStr = String(args.old ?? "");
    const newStr = String(args.new ?? "");
    if (!oldStr) return "error: `old` is required and non-empty";
    if (oldStr === newStr) return "error: `old` and `new` are identical — no-op";

    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch (e) {
      return `error: ${(e as NodeJS.ErrnoException).code ?? "read failed"}: ${path}`;
    }
    const replaceAll = Boolean(args.replace_all);

    if (!replaceAll) {
      const first = content.indexOf(oldStr);
      if (first < 0) return `error: \`old\` not found in ${path}`;
      const next = content.indexOf(oldStr, first + oldStr.length);
      if (next >= 0)
        return `error: \`old\` appears multiple times in ${path}; pass replace_all:true or include more context to disambiguate`;
      const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
      await fs.writeFile(path, updated);
      return `edit ok: 1 replacement in ${path}`;
    }

    const count = content.split(oldStr).length - 1;
    if (count === 0) return `error: \`old\` not found in ${path}`;
    const updated = content.split(oldStr).join(newStr);
    await fs.writeFile(path, updated);
    return `edit ok: ${count} replacements in ${path}`;
  },
};

// ---------- delegate ----------

const delegateTool: UsTool = {
  definition: {
    type: "function",
    name: "delegate",
    description:
      "Send a message to another peer agent in this Union Street harness and read their response. Use when another peer's identity, knowledge, or specialty is better suited to the question — they answer from their OWN SOUL/IDENTITY/MEMORY, not yours. Their response comes back to you as a tool result; you can then summarize, follow up, or chain to another peer.",
    parameters: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description:
            "The target peer's profile name (without `@`). Must be one of the peers listed in your system prompt.",
        },
        message: {
          type: "string",
          description:
            "What to ask or tell the peer. They don't see your conversation — be self-contained: include enough context for them to answer well.",
        },
        prompt: {
          type: "string",
          description:
            "Plain prompt alias for message. Useful for CLI-style `-p <peer> <prompt>` flows.",
        },
        payload: {
          type: "object",
          description:
            "Structured payload to send to the peer over its Lash MCP tool surface.",
        },
        envelope: {
          type: "object",
          description:
            "Structured Lash envelope to continue. Its trace/thread are preserved and its value/continuation/error is delivered to the peer.",
        },
        thread: {
          type: "object",
          description:
            "Lash thread object for MCP-style callers. If omitted, the harness creates or resumes one.",
        },
        trace: {
          type: "string",
          description:
            "Optional Lash trace id to continue. Omit this unless you are intentionally continuing an existing delegation chain.",
        },
      },
      required: ["peer"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const peer = String(args.peer ?? "").replace(/^@+/, "").trim();
    const input = normalizeLashToolInput(args, "delegation");
    if (!peer) return "error: `peer` is required";
    if (!input.ok) return input.error;

    const callingPeer = ctx.callingPeer ?? "unknown-peer";
    if (peer === callingPeer) return "error: cannot delegate to yourself";

    const result = await callLashPeerTool({
      targetPeer: peer,
      method: "delegate",
      arguments: mcpPeerArgs(args, callingPeer, input, ctx),
    });

    const structured = parseLashEnvelope(result.structuredContent);
    if (structured?.kind === "error") return `error: ${structured.error.message}`;
    return [
      `lash trace: ${structured?.trace ?? "?"} · thread: ${structured?.thread.id ?? "?"} · mcp delegate`,
      `@${peer} responded:`,
      "",
      toolResultText(result),
    ].join("\n");
  },
};

// ---------- report ----------

const reportTool: UsTool = {
  definition: {
    type: "function",
    name: "report",
    description:
      "Report status, findings, blockers, or completed work upward to your manager in the federation org chart. This is the truth-flows-up companion to delegate: it uses the same Lash trace/thread chain and only works when you have a manager.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The concise report to send upward. Include conclusions, uncertainty, blockers, and any requested decision.",
        },
        prompt: {
          type: "string",
          description:
            "Plain prompt alias for message. Useful for CLI-style `-p <manager> <prompt>` flows.",
        },
        payload: {
          type: "object",
          description:
            "Structured report payload sent over the manager's Lash MCP tool surface.",
        },
        envelope: {
          type: "object",
          description:
            "Structured Lash envelope to report upward. Its trace/thread are preserved and its value/continuation/error is delivered to the manager.",
        },
        thread: {
          type: "object",
          description:
            "Lash thread object for MCP-style callers. If omitted, the harness creates or resumes one.",
        },
        trace: {
          type: "string",
          description:
            "Optional Lash trace id to continue. Omit this unless you are intentionally continuing an existing reporting chain.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const input = normalizeLashToolInput(args, "report");
    if (!input.ok) return input.error;

    const callingPeer = ctx.callingPeer ?? "unknown-peer";
    const manager = (await resolveDelegationTargets(callingPeer)).find((target) => target.relation === "manager");
    if (!manager) return `error: @${callingPeer} has no visible manager to report to`;

    const result = await callLashPeerTool({
      targetPeer: manager.profile,
      method: "report",
      arguments: mcpPeerArgs(args, callingPeer, input, ctx),
    });

    const structured = parseLashEnvelope(result.structuredContent);
    if (structured?.kind === "error") return `error: ${structured.error.message}`;
    return [
      `lash trace: ${structured?.trace ?? "?"} · thread: ${structured?.thread.id ?? "?"} · mcp report -> @${manager.profile}`,
      `@${manager.profile} acknowledged:`,
      "",
      toolResultText(result),
    ].join("\n");
  },
};

// ---------- registry ----------

export const STARTER_TOOLS: UsTool[] = [
  bashTool,
  readTool,
  lsTool,
  grepTool,
  writeTool,
  editTool,
  delegateTool,
  reportTool,
];

export function toolDefinitions(tools: UsTool[]): ToolDefinition[] {
  return tools.map((t) => t.definition);
}

export function toolByName(tools: UsTool[]): Map<string, UsTool> {
  return new Map(tools.map((t) => [t.definition.name, t]));
}

// ---------- helpers ----------

type NormalizedLashToolInput =
  | { ok: true; prompt: string; trace?: string; thread?: LashThread }
  | { ok: false; error: string };

function normalizeLashToolInput(
  args: Record<string, unknown>,
  label: "delegation" | "report",
): NormalizedLashToolInput {
  const envelope = parseLashEnvelope(args.envelope);
  const thread = parseLashThread(args.thread) ?? envelope?.thread;
  const trace = readNonEmptyString(args.trace) ?? envelope?.trace;

  if (envelope) {
    const value = lashEnvelopeValue(envelope);
    return {
      ok: true,
      prompt: [
        `Structured Lash ${label} from @${envelope.from}.`,
        `kind: ${envelope.kind}`,
        "",
        stringifyPayload(value),
      ].join("\n"),
      trace,
      thread,
    };
  }

  const prompt = readNonEmptyString(args.message) ?? readNonEmptyString(args.prompt);
  if (prompt) return { ok: true, prompt, trace, thread };

  if (args.payload !== undefined) {
    return {
      ok: true,
      prompt: [`Structured ${label} payload:`, "", stringifyPayload(args.payload)].join("\n"),
      trace,
      thread,
    };
  }

  return { ok: false, error: "error: provide `message`, `prompt`, `payload`, or `envelope`" };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mcpPeerArgs(
  rawArgs: Record<string, unknown>,
  from: string,
  input: Extract<NormalizedLashToolInput, { ok: true }>,
  ctx: UsToolContext,
) {
  const envelope = parseLashEnvelope(rawArgs.envelope);
  const base = {
    from,
    trace: input.trace ?? ctx.trace,
    thread: input.thread ?? ctx.thread,
  };
  if (envelope) return { ...base, envelope };
  if (rawArgs.payload !== undefined) return { ...base, payload: rawArgs.payload };
  return { ...base, prompt: input.prompt };
}

function toolResultText(result: { content?: unknown[]; structuredContent?: unknown }): string {
  const structured = parseLashEnvelope(result.structuredContent);
  if (structured) {
    const value = lashEnvelopeValue(structured);
    return stringifyPayload(value);
  }
  const firstText = result.content?.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  return firstText?.text ?? stringifyPayload(result.structuredContent ?? result);
}

function resolveUnder(cwd: string, p: string): string {
  if (!p) return "";
  return isAbsolute(p) ? p : resolvePath(cwd, p);
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // simple byte-level truncate; don't worry about utf8 boundary at v1
  return s.slice(0, maxBytes) + `\n\n[output truncated to ${maxBytes} bytes]`;
}

function sectionedOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `[stdout]\n${stdout}\n[stderr]\n${stderr}`;
  if (stderr) return `[stderr]\n${stderr}`;
  return stdout;
}

async function commandExists(cmd: string): Promise<boolean> {
  const proc = spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode === 0;
}
