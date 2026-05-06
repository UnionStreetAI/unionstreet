/**
 * Profile scaffolding and load helpers.
 */
import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import { profilePaths } from "./paths.ts";
import { EMPTY_AUTH_PROFILES } from "./auth-profiles.ts";

export interface InitOptions {
  /** Pre-fill IDENTITY.md role/capability declarations. */
  role?: string;
  capabilities?: string[];
}

const SOUL_TEMPLATE = `# SOUL

You are a helpful, curious agent with your own identity and memory. You speak
plainly and ask follow-up questions when something is ambiguous. You are part
of a network of peers — when a task is better suited to another peer, you
delegate rather than guess.

# Style

- Concise. No filler.
- When you don't know, say so.
- Prefer concrete examples over abstract description.
`;

const IDENTITY_TEMPLATE = (name: string, role?: string, capabilities?: string[]) => `# IDENTITY

name: ${name}
role: ${role ?? "general"}
capabilities:
${(capabilities ?? ["chat"]).map((c) => `  - ${c}`).join("\n")}
`;

const AGENTS_TEMPLATE = `# AGENTS

How this profile coordinates with other peers. Edit freely — this file is read
into the system prompt under Project Context.

- Delegate exploratory or research-heavy work to peers with the \`researcher\`
  role.
- Always propagate the lash \`trace\` ID through delegation calls.
- When a peer returns, leave a short note under MEMORY.md if the result is
  worth remembering.
`;

const USER_TEMPLATE = `# USER

Notes about the human operator (if any). The agent reads this once per session
to ground its tone, addressing, and any standing preferences.

(empty — fill in when you're ready)
`;

const TOOLS_TEMPLATE = `# TOOLS

Local tool conventions for this profile. Notes to self about which tools to
prefer for what, any sharp edges, etc.

(empty)
`;

const MEMORY_TEMPLATE = `# MEMORY

Long-term curated memory for this profile. Daily logs accumulate under
\`memory/YYYY-MM-DD.md\`; this file is for the things you want loaded every
session.

(empty)
`;

const CONFIG_YAML_TEMPLATE = (name: string) =>
  yaml.dump({
    name,
    model: {
      // Default to Codex if the user has authed it, else fall back to anthropic api key.
      // The CLI will resolve this against auth-profiles.json at chat-time.
      // Note: bare "gpt-5" is not exposed via ChatGPT-account Codex auth;
      // use a Codex-published model id (gpt-5.4 / gpt-5.5 / gpt-5.x-codex).
      provider: "codex",
      id: "gpt-5.4",
    },
    runtime: {
      max_steps: 50,
      head: {
        mode: "embedded",
        provider: "local",
        honcho: {
          baseUrl: "http://127.0.0.1:8000",
          workspaceId: "local",
        },
      },
      compute: {
        provider: "local",
        target: "host",
        cpu: "shared",
        memory: "host",
      },
      storage: {
        provider: "local",
        persistent: true,
        encryption: "provider-managed",
      },
      ingress: {
        provider: "local",
        url: "http://127.0.0.1:0",
        public: false,
        auth: "federation-jwt",
        receives: ["mcp", "lash", "webhook", "control"],
      },
      workspace: {
        provider: "local",
        scope: "agent",
        workdir: ".",
        persistent: true,
        network: "egress",
      },
    },
    routing: {
      // channel routing rules; fill in via `us channel link ...`
      telegram: [],
      slack: [],
      discord: [],
      email: [],
    },
    plugins: [],
  });

const AGENT_PACK_TEMPLATE = (name: string, role?: string, capabilities?: string[]) =>
  yaml.dump({
    version: 1,
    id: name,
    soul: "./SOUL.md",
    model: {
      primary: { provider: "codex", id: "gpt-5.4" },
      fallback: [{ provider: "codex", id: "gpt-5.4-mini" }],
    },
    identity: {
      profile: name,
      subject: `agent:${name}`,
      displayName: name,
      title: role ?? "General Agent",
      directReports: [],
      groups: [],
      roles: capabilities?.length ? capabilities : [role ?? "agent"],
    },
    oidc: {
      issuer: "urn:union-street:local",
      subject: `agent:${name}`,
      audiences: ["urn:union-street:agents"],
      claims: {
        profile: "us_profile",
        groups: "us_groups",
        roles: "us_roles",
        principals: "us_principals",
      },
    },
    lash: {
      thread: `lash:${name}/${name}`,
      delegate: "none",
      report: "none",
      structured: "preferred",
    },
    pulse: {
      enabled: false,
      cadence: "every 30m",
      instructions: `Inspect open work for @${name}, then report only material findings.`,
    },
    schedule: [],
    runtime: {
      environment: "local/host",
      compute: "local",
      storage: "local",
      workspace: ".",
      secrets: [`profile:${name}`],
    },
    toolkit: {
      cli: ["delegate", "report", "read", "write", "shell"],
      mcp: [],
      plugins: [],
      permissions: ["memory:read", "memory:write"],
    },
    memory: {
      provider: "honcho",
      peerProfile: name,
      sharedNamespaces: ["institutional"],
    },
  }, { lineWidth: 100 });

const ENV_TEMPLATE = `# Profile-local environment overrides.
# Anything secret belongs in auth-profiles.json instead.
`;

async function writeIfAbsent(path: string, content: string, mode?: number): Promise<boolean> {
  try {
    await fs.access(path);
    return false;
  } catch {
    await fs.writeFile(path, content, mode != null ? { mode } : undefined);
    return true;
  }
}

export interface InitResult {
  paths: ReturnType<typeof profilePaths>;
  created: string[];
  alreadyExisted: string[];
}

/**
 * Idempotent. Skips files that already exist; reports both lists.
 */
export async function initProfile(name: string, opts: InitOptions = {}): Promise<InitResult> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      `invalid profile name "${name}" — use lowercase letters, digits, underscores, dashes (start with a letter), max 64 chars`,
    );
  }
  const paths = profilePaths(name);
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.sessions, { recursive: true });
  await fs.mkdir(paths.skills, { recursive: true });

  const writes: Array<[string, string, number?]> = [
    [paths.soul, SOUL_TEMPLATE],
    [paths.identity, IDENTITY_TEMPLATE(name, opts.role, opts.capabilities)],
    [paths.agents, AGENTS_TEMPLATE],
    [paths.user, USER_TEMPLATE],
    [paths.tools, TOOLS_TEMPLATE],
    [paths.memory, MEMORY_TEMPLATE],
    [paths.config, CONFIG_YAML_TEMPLATE(name)],
    [paths.agentPack, AGENT_PACK_TEMPLATE(name, opts.role, opts.capabilities)],
    [paths.env, ENV_TEMPLATE],
    [paths.authProfiles, JSON.stringify(EMPTY_AUTH_PROFILES, null, 2), 0o600],
  ];

  const created: string[] = [];
  const alreadyExisted: string[] = [];
  for (const [p, content, mode] of writes) {
    const wrote = await writeIfAbsent(p, content, mode);
    (wrote ? created : alreadyExisted).push(p);
  }

  return { paths, created, alreadyExisted };
}

/**
 * Read + mutate + write a profile's config.yaml. Round-trips through
 * js-yaml; comments/formatting are not preserved (treat config as data,
 * not a hand-edited file).
 */
export async function updateProfileConfig(
  name: string,
  mutator: (cfg: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const path = profilePaths(name).config;
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object") current = parsed as Record<string, unknown>;
  } catch {
    // missing file → treat as empty
  }
  const next = await mutator(current);
  await fs.writeFile(path, yaml.dump(next));
  return next;
}

/** Convenience: persist `model.id` (and optional `model.provider`). */
export async function setProfileModel(
  name: string,
  modelId: string,
  provider?: string,
): Promise<void> {
  await updateProfileConfig(name, (cfg) => {
    const model =
      typeof cfg.model === "object" && cfg.model !== null
        ? { ...(cfg.model as Record<string, unknown>) }
        : ({} as Record<string, unknown>);
    model.id = modelId;
    if (provider) model.provider = provider;
    return { ...cfg, model };
  });
}

export async function profileExists(name: string): Promise<boolean> {
  const paths = profilePaths(name);
  try {
    const st = await fs.stat(paths.root);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function listProfiles(): Promise<string[]> {
  const { PROFILES_DIR } = await import("./paths.ts");
  try {
    const entries = await fs.readdir(PROFILES_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^[a-z][a-z0-9_-]*$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
