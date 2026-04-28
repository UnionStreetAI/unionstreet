/**
 * `us-dev chat [profile]` — mount the opentui chat app.
 *
 * This file owns environment+IO: profile resolution, auth, system-prompt
 * assembly, session-file paths. Everything visual is in `../ui/App.tsx`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  resolveProfile,
  profileExists,
  profilePaths,
  resolveAuthProfiles,
  STARTER_TOOLS,
  normalizeProvider,
  resolveDelegationTargets,
  type OAuthCred,
} from "@unionstreet/us-core";
import { App } from "../ui/App.tsx";
import { makePersister, type ChatRuntime } from "../ui/runtime.ts";
import { resetTerminalModes } from "../terminalModes.ts";

interface ProfileConfigYaml {
  name?: string;
  model?: { provider?: string; id?: string };
  runtime?: { max_steps?: number };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_SUMMARIZER_MODEL = "gpt-5.4-mini";

/**
 * Build a runtime descriptor for a profile. Used at chat startup AND when
 * `@<profile>` switches profiles mid-session.
 *
 * The renderer + exit handler are shared across switches, so they're
 * passed in rather than constructed here.
 */
export async function loadProfileRuntime(opts: {
  name: string;
  source: string;
  persistFor(sessionFile: string): (entry: unknown) => Promise<void>;
  exit(code: number): void;
}): Promise<ChatRuntime> {
  if (!(await profileExists(opts.name))) {
    throw new Error(`Profile "${opts.name}" does not exist.`);
  }
  const paths = profilePaths(opts.name);
  const cfg = (yaml.load(await fs.readFile(paths.config, "utf8")) ?? {}) as ProfileConfigYaml;
  const modelId = cfg.model?.id ?? "gpt-5.4";
  const provider = cfg.model?.provider ?? "codex";
  const maxSteps = cfg.runtime?.max_steps ?? 50;

  const auth = await resolveAuthProfiles(opts.name);
  const tokenCred =
    provider === "codex" || provider === "openai-codex"
      ? auth.merged.providers.codex
      : auth.merged.providers[provider];
  const oauth =
    tokenCred?.kind === "oauth"
      ? (tokenCred as OAuthCred)
      : undefined;
  const authWarning =
    oauth?.expires && oauth.expires < Date.now()
      ? `Token expired for "${opts.name}" provider "${provider}". Re-run auth.`
      : !tokenCred
        ? `No auth credential found for "${opts.name}" provider "${provider}".`
        : undefined;
  if (oauth?.expires && oauth.expires < Date.now()) {
    // Chat should still open so the operator can switch models/providers,
    // inspect the session, or run auth from the TUI flow.
  }

  const systemPrompt = await composeSystemPrompt({
    paths,
    profileName: opts.name,
    modelId,
    provider,
  });
  await fs.mkdir(paths.sessions, { recursive: true });
  const { sessionId, sessionFile } = newSessionPath(opts.name, paths.sessions);

  return {
    profileName: opts.name,
    profileSource: opts.source,
    providerId: provider,
    modelId,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    summarizerModel: DEFAULT_SUMMARIZER_MODEL,
    systemPrompt,
    authWarning,
    // Used by compaction today. Main chat streaming resolves provider auth
    // fresh per call, so non-Codex models do not go through this token.
    token: authWarning ? "" : oauth?.access ?? "",
    sessionId,
    sessionFile,
    maxSteps,
    persist: opts.persistFor(sessionFile),
    exit: opts.exit,
  };
}

export async function chat(profileArg: string | undefined): Promise<void> {
  const resolved = await resolveProfile(profileArg);

  resetTerminalModes();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`us-dev chat` must be run in an interactive terminal.");
  }

  let renderer: Awaited<ReturnType<typeof createUsChatRenderer>> | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  const exit = (code: number) => {
    try {
      root?.unmount();
    } catch {}
    try {
      renderer?.destroy?.();
    } catch {}
    resetTerminalModes();
    process.exit(code);
  };

  const runtime = await loadProfileRuntime({
    name: resolved.name,
    source: resolved.source,
    persistFor: makePersister,
    exit,
  });

  renderer = await createUsChatRenderer();
  root = createRoot(renderer);

  // The App passes a switchProfile callback that re-runs loadProfileRuntime
  // and replaces the runtime in state.
  async function switchProfile(name: string): Promise<ChatRuntime> {
    return loadProfileRuntime({
      name,
      source: "switched",
      persistFor: makePersister,
      exit,
    });
  }

  // For `/resume` — repoint the runtime at an existing session file.
  // Profile/model/auth stay put; we just swap the file we write to.
  async function resumeSession(current: ChatRuntime, sessionFile: string): Promise<ChatRuntime> {
    const id = sessionFile.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    return {
      ...current,
      sessionId: id,
      sessionFile,
      persist: makePersister(sessionFile),
    };
  }

  async function newSession(current: ChatRuntime): Promise<ChatRuntime> {
    const paths = profilePaths(current.profileName);
    await fs.mkdir(paths.sessions, { recursive: true });
    const { sessionId, sessionFile } = newSessionPath(current.profileName, paths.sessions);
    const next = {
      ...current,
      sessionId,
      sessionFile,
      persist: makePersister(sessionFile),
    };
    await next.persist({
      kind: "session_meta",
      provider: current.providerId,
      model: current.modelId,
      ts: Date.now(),
    });
    return next;
  }

  root.render(
    <App
      runtime={runtime}
      switchProfile={switchProfile}
      resumeSession={resumeSession}
      newSession={newSession}
    />,
  );
  renderer.start();
}

async function createUsChatRenderer() {
  installOpenTuiStartupGuards();
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    // Terminal mouse modes are currently too fragile across crashes/resumes:
    // if a previous run leaves them enabled, the user's shell receives
    // printable tails like `35;6;42M` and the TUI appears totally cooked.
    // Keep the chat keyboard-first until we can isolate mouse in a safer
    // renderer wrapper.
    useMouse: false,
    enableMouseMovement: false,
  });
  return renderer;
}

let openTuiStartupGuardsInstalled = false;

function installOpenTuiStartupGuards() {
  if (openTuiStartupGuardsInstalled) return;
  openTuiStartupGuardsInstalled = true;
  const proto = CliRenderer.prototype as any;
  proto.ensureNativePaletteState = function ensureNativePaletteStateDisabledForUsChat() {};
}

function newSessionPath(profileName: string, sessionsDir: string): { sessionId: string; sessionFile: string } {
  const sessionId = `${profileName}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return { sessionId, sessionFile: join(sessionsDir, `${sessionId}.jsonl`) };
}

interface SystemPromptInput {
  paths: ReturnType<typeof profilePaths>;
  profileName: string;
  modelId: string;
  provider: string;
}

async function composeSystemPrompt(input: SystemPromptInput): Promise<string> {
  const sections: string[] = [];
  for (const [label, path] of [
    ["IDENTITY", input.paths.identity],
    ["SOUL", input.paths.soul],
    ["AGENTS", input.paths.agents],
    ["USER", input.paths.user],
    ["TOOLS", input.paths.tools],
    ["MEMORY", input.paths.memory],
  ] as const) {
    try {
      const raw = (await fs.readFile(path, "utf8")).trim();
      if (raw) sections.push(`<${label}>\n${raw}\n</${label}>`);
    } catch {
      // file missing — skip
    }
  }

  const base = await buildHarnessContext(input);
  return [base, ...sections].join("\n\n");
}

/**
 * The base system prompt. Tells the agent what the US harness is, what
 * tools it has, what peers exist, and the conventions it should follow.
 *
 * This is the agent's self-awareness. Tool *schemas* tell it WHAT each
 * tool does; this section tells it WHERE IT IS, WHO IT IS, and WHO ELSE
 * IS HERE.
 */
async function buildHarnessContext(input: SystemPromptInput): Promise<string> {
  const delegationTargets = await resolveDelegationTargets(input.profileName);
  const otherPeers = delegationTargets.map((target) => target.profile);

  const toolList = STARTER_TOOLS.map((t) => t.definition.name).join(", ");

  const peersSection =
    otherPeers.length > 0
      ? `Visible peers from your org position: ${delegationTargets.map((target) => `\`@${target.profile}\` (${target.relation}${target.depth > 1 ? ` depth ${target.depth}` : ""})`).join(", ")}.`
      : `You are the only profile right now. The user can spin up new peers with \`@\`-create.`;

  return `# You are running inside the Union Street ("us") agent harness.

## Identity
- Your profile name is **@${input.profileName}**.
- Your model is **${input.modelId}** via **${normalizeProvider(input.provider)}**.
- You are a sovereign peer agent. ${peersSection}

## What this harness is
"us" is a minimal multi-agent harness. Every profile is a sovereign peer with
its own identity (SOUL.md, IDENTITY.md, AGENTS.md), its own session memory,
and its own tools. Peers communicate via \`delegate\` and \`report\`:
\`delegate\` pushes work to an allowed peer, while \`report\` sends truth,
blockers, and completed work upward to your manager.

Delegation is Lash-aware: every \`delegate\` call carries a \`trace\`
(cross-peer correlation), a \`thread\` (receiver-side continuity), and a
command chain. Federation controls who you can see: normally your manager
and direct reports; org-root agents can drive work down the whole tree.

## Tools you have
- ${toolList.split(", ").filter((t) => t !== "delegate" && t !== "report").join(", ")}: filesystem + shell. Use them — don't describe what you'd do.
- **delegate(peer, message | prompt | payload | envelope)**: send a message
  or structured Lash-shaped payload to another peer agent and read
  their response. Use when another peer's identity, knowledge, or specialty
  fits the question better than yours. They answer from their OWN
  SOUL/IDENTITY/MEMORY — you're not impersonating them, you're consulting
  them. Their response comes back as a Lash-correlated tool result for you
  to use.
- **report(message | prompt | payload | envelope)**: send a concise
  status/finding/blocker report upward to your manager. Use it when truth
  needs to flow back up the chain.

## How the user interacts
The user is in a chat TUI with these affordances:
- \`/\` opens the slash-command menu (\`/help\`, \`/model\`, \`/clear\`, \`/compact\`, \`/aside\`, \`/exit\`).
- \`/aside <q>\` opens an ephemeral fork — those messages do **not** reach you.
- \`/compact\` summarizes older history into a memory anchor; older messages
  may have been replaced by a \`# COMPACTION ANCHOR\` system block — trust it
  as the authoritative summary of what came before.
- \`@<peer>\` switches the active profile; \`@ + create new profile\` makes a new one.
- \`$<skill>\` will eventually invoke a skill (not implemented yet).

## Conventions
- Keep replies concise. Markdown is rendered (bold, italic, headings, code,
  links). Use it sparingly — terminals are not the web.
- When you don't know, say so.
- Prefer doing (tool calls) over describing.
- Your context will be auto-compacted when it fills up; treat the anchor as
  ground truth on prior facts.`;
}
