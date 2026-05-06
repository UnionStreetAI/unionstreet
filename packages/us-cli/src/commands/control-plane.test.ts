import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-cli-control-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-cli-control-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("@unionstreet/server");
const { init } = await import("./init.ts");
const { profileList, profileUse } = await import("./profile.ts");
const { schedulerCommand } = await import("./scheduler.ts");
const { eventsCommand } = await import("./events.ts");
const { runtimeEnsure, runtimeStatus } = await import("./runtime.ts");
const { mcpCommand } = await import("./mcp.ts");
const { fleetCommand } = await import("./fleet.ts");
const { loadProfileRuntime } = await import("./chat.tsx");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org.slice(0, 5)) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
  const coo = await core.readAgentPack("coo");
  await core.writeAgentPack("coo", {
    ...coo,
    pulse: { enabled: true, cadence: "every 30m", instructions: "heartbeat check" },
    schedule: [
      {
        id: "monday-sync",
        name: "Monday sync",
        cron: "0 9 * * MON",
        timezone: "UTC",
        prompt: "Run Monday sync.",
        deliverables: ["status"],
      },
    ],
  });
  await core.initProfile("cli-noauth", { role: "agent" });
  await core.setProfileModel("cli-noauth", "model-without-credentials", "provider-without-credentials");
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

describe("CLI control-plane commands", () => {
  test("initCommand_WhenProfileDoesNotExist_CreatesAtomicAgentPackAndProfileFiles", async () => {
    const output = await captureOutput(() => init("sales-agent", { role: "sales", capability: ["crm", "reporting"] }));
    const pack = await core.readAgentPack("sales-agent");

    expect(output, "init should tell operators which profile path was created.").toContain('Profile "sales-agent"');
    expect(pack.id, "init must create the atomic agent.yaml pack alongside legacy profile files.").toBe("sales-agent");
    expect(pack.identity.roles, "init should preserve requested capabilities as agent identity roles.").toEqual(["crm", "reporting"]);
    expect(pack.lash.structured, "New profiles should default to structured Lash-capable coordination.").toBe("preferred");
  });

  test("profileCommands_WhenProfilesExist_ListAndPinDefaultProfile", async () => {
    await profileUse("coo");

    const output = await captureOutput(() => profileList());
    const config = await core.readGlobalConfig();

    expect(config.default_profile, "profile use should persist the selected default in global config.").toBe("coo");
    expect(output, "profile list should render the selected default profile for human verification.").toContain("coo");
    expect(output, "profile list should include initialized peer profiles, not just the default.").toContain("vp-eng");
  });

  test("schedulerCommand_WhenDueTickRuns_ClaimsRunAndCanPrintRuns", async () => {
    const dueAt = Date.UTC(2026, 3, 27, 9, 1);

    const dueOutput = await captureOutput(() => schedulerCommand("due", { profile: "@coo", now: dueAt }));
    const tickOutput = await captureOutput(() => schedulerCommand("tick", { profile: "@coo", now: dueAt }));
    const runsOutput = await captureOutput(() => schedulerCommand("runs"));

    expect(dueOutput, "scheduler due should normalize @profile filters and show the due schedule job.").toContain("schedule:coo:monday-sync");
    expect(tickOutput, "scheduler tick should claim every due job, including the always-on pulse and the explicit schedule.").toContain("claimed 2 scheduler runs");
    expect(runsOutput, "scheduler runs should expose persisted schedule run history for audit and debugging.").toContain("schedule:coo:monday-sync");
    expect(runsOutput, "scheduler runs should expose persisted pulse run history for heartbeat auditability.").toContain("pulse:coo");
  });

  test("eventsCommand_WhenEventsExist_FiltersHumanAndJsonOutput", async () => {
    await core.writeEvent({
      type: "audit.test",
      actor: "@coo",
      target: "@vp-eng",
      trace: "trace-cli-events",
      outcome: "success",
      reason: "CLI command test",
    });

    const human = await captureOutput(() => eventsCommand("query", { actor: "@coo", trace: "trace-cli-events", limit: 5 }));
    const json = await captureOutput(() => eventsCommand("query", { actor: "coo", trace: "trace-cli-events", json: true }));
    const parsed = JSON.parse(json);

    expect(human, "events query should show normalized actor and target handles in human output.").toContain("@coo");
    expect(human, "events query should include trace ids so operators can stitch a run timeline.").toContain("trace:trace-cli-events");
    expect(parsed[0].actor, "events query --json should produce machine-readable filtered event rows.").toBe("coo");
    expect(parsed[0].target, "events query --json should normalize target handles without @ prefixes.").toBe("vp-eng");
  });

  test("runtimeCommands_WhenProfileExists_ExposeAndEnsureConcreteWorkspaceContract", async () => {
    const statusOutput = await captureOutput(() => runtimeStatus("coo"));
    const ensureOutput = await captureOutput(() => runtimeEnsure("coo"));
    const events = await core.queryEvents({ type: "runtime.workspace.ensure", actor: "coo", limit: 1 });

    expect(statusOutput, "runtime status should render the selected profile's runtime contract.").toContain("@coo");
    expect(statusOutput, "runtime status should include workspace details, not just a placeholder.").toContain("workspace");
    expect(ensureOutput, "runtime ensure should confirm workspace materialization.").toContain("workspace ensured");
    expect(events[0]?.actor, "runtime ensure should emit a control-plane audit event for the agent.").toBe("coo");
  });

  test("loadProfileRuntime_WhenConfiguredProviderHasNoCredential_StillBuildsChatRuntimeWithAuthWarning", async () => {
    const persisted: unknown[] = [];

    const runtime = await loadProfileRuntime({
      name: "cli-noauth",
      source: "test",
      persistFor: () => async (entry: unknown) => {
        persisted.push(entry);
      },
      exit: () => {},
    });

    expect(runtime.profileName, "Chat runtime should resolve the requested profile even before auth exists.").toBe("cli-noauth");
    expect(runtime.authWarning, "TUI startup should surface missing provider credentials instead of failing to render.").toContain("No auth credential found");
    expect(runtime.token, "Missing auth should leave the token empty so later model calls fail explicitly.").toBe("");
    expect(runtime.systemPrompt, "Chat runtime should compose the profile prompt from the agent files.").toContain("# SOUL");
    expect(persisted, "Building chat runtime should not write session turns before the user sends a message.").toEqual([]);
  });

  test("fleetCommand_WhenPlanIsValidatedAndApplied_MaterializesGeneratedAgents", async () => {
    const fleetFile = join(workdir, "cli-fleet-plan.yaml");
    await Bun.write(fleetFile, [
      "version: 1",
      "kind: union-street.fleet-plan",
      "name: cli_fleet",
      "mission: Operate a tiny CLI-generated org.",
      "root: cli_fleet_root",
      "generatedBy: coo",
      "agents:",
      "  - id: cli_fleet_root",
      "    displayName: CLI Fleet Root",
      "    title: COO",
      "    groups: [executives]",
      "    roles: [executive]",
      "    soul: Run the generated CLI fleet.",
      "    model: { provider: codex, id: gpt-5.4 }",
      "  - id: cli_fleet_eng",
      "    displayName: CLI Fleet Engineering",
      "    title: VP Engineering",
      "    manager: cli_fleet_root",
      "    groups: [engineering]",
      "    roles: [vp]",
      "    mcp: [github]",
      "    soul: Turn the generated fleet's engineering priorities into work.",
      "    model: { provider: codex, id: gpt-5.4 }",
    ].join("\n"));

    const validateOutput = await captureOutput(() => fleetCommand("validate", fleetFile));
    const applyOutput = await captureOutput(() => fleetCommand("apply", fleetFile));
    const pack = await core.readAgentPack("cli_fleet_eng");
    const federation = await core.readFederationConfig();

    expect(validateOutput, "fleet validate should render a human review summary before any writes happen.").toContain("validation ok");
    expect(applyOutput, "fleet apply should tell operators which generated profiles were materialized.").toContain("@cli_fleet_eng");
    expect(
      pack.identity.manager,
      "CLI fleet apply must write atomic agent packs with the validated manager edge.",
    ).toBe("cli_fleet_root");
    expect(
      federation.grants.some((grant) => grant.id === "fleet:cli_fleet:cli_fleet_eng:mcp" && grant.servers.includes("github")),
      "CLI fleet apply must convert requested MCP access into federation grants instead of dashboard-only state.",
    ).toBe(true);
  });

  test("schedulerCommand_WhenNowIsInvalid_FailsWithActionableMessage", async () => {
    const promise = schedulerCommand("status", { now: "definitely-not-a-date" });

    await expect(
      promise,
      "Invalid scheduler time input should fail before scanning jobs so CLI users can correct the flag.",
    ).rejects.toThrow("Invalid --now value");
  });

  test("mcpCommand_WhenRemoteDeviceOAuthCallbackIsProvided_SavesAgentScopedTokenWithoutInteractivePrompt", async () => {
    const tokenRequests: string[] = [];
    process.env.US_TEST_MCP_CALLBACK = "https://remote.example.com/mcp/callback?code=remote-device-code";
    const tokenServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text();
        tokenRequests.push(body);
        return Response.json({
          access_token: "linear-access-token",
          refresh_token: "linear-refresh-token",
          expires_in: 3600,
          scope: "issues:read",
          token_type: "Bearer",
        });
      },
    });
    try {
      const output = await captureOutput(() => mcpCommand("auth", "linear", {
        profile: "coo",
        oauth: true,
        authUrl: "https://linear.example.com/oauth/authorize",
        tokenUrl: `${tokenServer.url.origin}/token`,
        clientId: "union-street-cli",
        redirectUri: "https://remote.example.com/mcp/callback",
        scope: "issues:read",
        callbackEnv: "US_TEST_MCP_CALLBACK",
      }));
      const credential = await core.getMcpCredential("coo", "linear");

      expect(output, "MCP OAuth should still print a success message for remote-device auth flows.").toContain("saved OAuth token");
      expect(
        tokenRequests[0],
        "Remote-device OAuth exchange must submit the pasted code, redirect URI, client id, and PKCE verifier to the token endpoint.",
      ).toContain("code=remote-device-code");
      expect(tokenRequests[0], "Remote-device OAuth exchange must preserve the configured redirect URI.").toContain("redirect_uri=https%3A%2F%2Fremote.example.com%2Fmcp%2Fcallback");
      expect(tokenRequests[0], "Remote-device OAuth exchange must send a PKCE verifier, not a static client secret-only flow.").toContain("code_verifier=");
      expect(
        credential,
        "Successful remote-device OAuth must persist an agent-scoped MCP credential for later runtime discovery.",
      ).toMatchObject({
        kind: "oauth",
        access: "linear-access-token",
        refresh: "linear-refresh-token",
        scope: "issues:read",
        token_type: "Bearer",
      });
    } finally {
      delete process.env.US_TEST_MCP_CALLBACK;
      tokenServer.stop(true);
    }
  });

  test("usDevPrompt_WhenBuiltinToolRuns_PersistsGoldenJsonlTranscriptShape", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const cli = join(repoRoot, "packages/us-cli/src/index.ts");
    const promptHome = await mkdtemp(join(tmpdir(), "union-street-cli-prompt-test-"));
    const promptWorkdir = await mkdtemp(join(tmpdir(), "union-street-cli-prompt-work-"));
    const promptEnv = {
      ...process.env,
      US_HOME: promptHome,
      HOME: promptWorkdir,
      US_MEMORY_SYNC: "0",
      US_STREAM_MODEL_STUB: "1",
      US_USAGE_DISABLE_MODELS_DEV_COSTS: "1",
    };

    try {
      const initProc = Bun.spawn(["bun", "run", cli, "init", "coo", "--role", "coo", "--capability", "executive"], {
        cwd: promptWorkdir,
        env: promptEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [initStdout, initStderr, initCode] = await Promise.all([
        new Response(initProc.stdout).text(),
        new Response(initProc.stderr).text(),
        initProc.exited,
      ]);

      const proc = Bun.spawn(["bun", "run", cli, "coo", "-p", "please use ls tool"], {
        cwd: promptWorkdir,
        env: promptEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const sessionFile = await findSessionFileContaining(promptHome, "coo", "please use ls tool");
      const raw = await readFile(sessionFile, "utf8");
      const rows = raw.trim().split("\n").map((line) => JSON.parse(line));

      expect(initCode, `us init coo should exit successfully; stdout=${initStdout} stderr=${initStderr}`).toBe(0);
      expect(code, `us coo -p should exit successfully; stdout=${stdout} stderr=${stderr}`).toBe(0);
      expect(stdout, "The non-interactive prompt should print the final assistant response to stdout.").toContain("stub response");
      expect(stderr, "Tool execution should be visible on stderr without corrupting stdout transcript text.").toContain("[tool:ls]");
      expect(sessionFile, "The CLI -p path must create a durable session file containing the prompt.").toContain("/profiles/coo/sessions/");
      expect(
        rows.map((row) => row.kind ?? row.role),
        "Golden CLI -p JSONL shape must preserve meta, user, assistant tool-call turn, tool result, and final assistant turn order.",
      ).toEqual(["session_meta", "user", "assistant", "tool", "assistant"]);
      expect(rows[0], "Session metadata must persist provider/model so /resume remembers the selected model.").toMatchObject({
        kind: "session_meta",
        provider: "codex",
        model: "gpt-5.4",
      });
      expect(rows[2].tool_calls[0].name, "The assistant tool-call row must persist the executed function name.").toBe("ls");
      expect(rows[3].name, "The tool result row must carry the tool name for rendered tool-call history.").toBe("ls");
      expect(rows[4].usage.total, "The final assistant row must persist token usage for /cost and accounting.").toBe(2);
    } finally {
      await rm(promptHome, { recursive: true, force: true });
      await rm(promptWorkdir, { recursive: true, force: true });
    }
  });
});

async function findSessionFileContaining(home: string, profile: string, needle: string): Promise<string> {
  const dir = join(home, "profiles", profile, "sessions");
  const files = await readdir(dir);
  for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
    const full = join(dir, file);
    const raw = await readFile(full, "utf8");
    if (raw.includes(needle)) return full;
  }
  throw new Error(`No ${profile} session contained "${needle}". Files: ${files.join(", ")}`);
}
