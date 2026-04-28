#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const cli = join(repoRoot, "packages/us-cli/src/index.ts");
const packages = ["ai-codex", "us-auth", "us-core", "us-runtime", "us-cli", "us-dashboard"];
const args = new Set(process.argv.slice(2));
const skipTypecheck = args.has("--skip-typecheck");
const skipTests = args.has("--skip-tests");

if (!skipTypecheck) {
  for (const pkg of packages) {
    await run(["bun", "run", "--cwd", `packages/${pkg}`, "typecheck"]);
  }
}

if (!skipTests) {
  await run(["bun", "test"]);
}

const usHome = await mkdtemp(join(tmpdir(), "union-street-smoke-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-routes-"));
try {
  const smokeEnv = { US_HOME: usHome, US_PEER_CALL_STUB: "1" };

  await cliRun(["--help"], smokeEnv, workdir);
  await cliRun(["--version"], smokeEnv, workdir);

  await cliRun(["auth", "status"], smokeEnv, workdir);
  await cliRun(["profile", "list"], smokeEnv, workdir);
  await cliRun(["runtime", "status"], smokeEnv, workdir);
  await cliRun(["federation", "status"], smokeEnv, workdir);
  await cliRun(["federation", "jwks"], smokeEnv, workdir);

  await cliRun(["init", "coo", "--role", "coo", "--capability", "executive"], smokeEnv, workdir);
  await cliRun(["init", "analyst", "--role", "analyst"], smokeEnv, workdir);
  await assertFileIncludes(join(usHome, "profiles/coo/agent.yaml"), ["id: coo", "subject: agent:coo"]);
  await cliRun(["auth", "status", "coo"], smokeEnv, workdir);
  await cliRun(["profile", "list"], smokeEnv, workdir);
  await cliRun(["profile", "use", "coo"], smokeEnv, workdir);
  await cliRun(["coo", "-p", "say hi"], smokeEnv, workdir, { expectedCode: 1 });
  await cliRun(["-p", "say hi from default"], smokeEnv, workdir, { expectedCode: 1 });
  await cliRun(["runtime", "status", "coo"], smokeEnv, workdir);
  await cliRun(["runtime", "ensure", "coo"], smokeEnv, workdir);

  const defaultToken = await cliRun(["federation", "token", "coo"], smokeEnv, workdir, { stdout: "pipe" });
  assertJwt(defaultToken.stdout, "default federation token");
  const mcpToken = await cliRun(["federation", "token", "coo", "--mcp-target", "analyst"], smokeEnv, workdir, { stdout: "pipe" });
  assertJwt(mcpToken.stdout, "target-scoped MCP token");

  await cliRun(["federation", "demo-org", "--profiles", "--mcp"], smokeEnv, workdir);
  await assertFileIncludes(join(usHome, "profiles/coo/agent.yaml"), ["delegate: descendants", "vp-eng", "issuer: urn:union-street:demo-enterprise"]);
  await assertFileIncludes(join(usHome, "profiles/vp-eng/agent.yaml"), ["manager: coo", "github", "subject: agent:vp-eng"]);
  await cliRun(["profile", "list"], smokeEnv, workdir);
  await cliRun(["federation", "status"], smokeEnv, workdir);
  await cliRun(["federation", "status", "coo"], smokeEnv, workdir);
  await cliRun(["federation", "status", "vp-eng"], smokeEnv, workdir);
  await cliRun(["coo", "mcp", "auth", "linear", "--api-key", "linear-coo-token"], smokeEnv, workdir);
  await cliRun(["mcp", "auth", "github", "--profile", "mgr-eng-platform", "--api-key", "github-manager-token"], smokeEnv, workdir);
  const cooMcpStatus = await cliRun(["coo", "mcp", "status", "linear"], smokeEnv, workdir, { stdout: "pipe" });
  assertTextIncludes(cooMcpStatus.stdout, ["linear", "granted", "profile/api_key"]);
  const managerMcpStatus = await cliRun(["mcp", "status", "github", "--profile", "mgr-eng-platform"], smokeEnv, workdir, { stdout: "pipe" });
  assertTextIncludes(managerMcpStatus.stdout, ["github", "granted", "profile/api_key"]);
  await cliRun(["runtime", "status"], smokeEnv, workdir);
  await cliRun(["runtime", "ensure", "vp-eng"], smokeEnv, workdir);

  const demoToken = await cliRun(["federation", "token", "vp-eng", "--audience", "union-street-demo"], smokeEnv, workdir, { stdout: "pipe" });
  assertJwt(demoToken.stdout, "demo audience federation token");
  await cliRun(["federation", "jwks"], smokeEnv, workdir);
  await harnessAssertions(usHome);

  await cliRun(["auth", "bogus"], smokeEnv, workdir, { expectedCode: 2 });
  await cliRun(["profile", "use", "missing"], smokeEnv, workdir, { expectedCode: 1 });
  await cliRun(["runtime", "ensure"], smokeEnv, workdir, { expectedCode: 2 });
  await cliRun(["federation", "token"], smokeEnv, workdir, { expectedCode: 2 });
  await cliRun(["federation", "verify", "okta"], smokeEnv, workdir, { expectedCode: 2 });
  await cliRun(["mcp-agent"], smokeEnv, workdir, { expectedCode: 2 });
} finally {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
}

async function assertFileIncludes(path: string, needles: string[]): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    const raw = await readFile(path, "utf8");
    const missing = needles.filter((needle) => !raw.includes(needle));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  } catch (error) {
    console.error(`Expected ${path} to include ${needles.join(", ")}: ${(error as Error).message}`);
    process.exit(1);
  }
}

interface RunOptions {
  cwd?: string;
  expectedCode?: number;
  stdout?: "inherit" | "pipe";
}

async function cliRun(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  options: Omit<RunOptions, "cwd"> = {},
): Promise<{ stdout: string; stderr: string }> {
  return run(["bun", "run", cli, ...args], env, { ...options, cwd });
}

async function run(
  cmd: string[],
  env: Record<string, string> = {},
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  console.log(`\n$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    cwd: options.cwd ?? repoRoot,
    stdout: options.stdout ?? "inherit",
    stderr: options.stdout === "pipe" ? "pipe" : "inherit",
  });
  const stdout = options.stdout === "pipe" ? await new Response(proc.stdout).text() : "";
  const stderr = options.stdout === "pipe" ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  const expected = options.expectedCode ?? 0;
  if (code !== expected) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.error(`Expected exit ${expected}, got ${code}`);
    process.exit(code || 1);
  }
  return { stdout, stderr };
}

function assertJwt(value: string, label: string): void {
  const token = value.trim();
  if (!/^[^.]+\.[^.]+\.[^.]+$/.test(token)) {
    console.error(`${label} did not look like a JWT`);
    process.exit(1);
  }
}

function assertTextIncludes(value: string, needles: string[]): void {
  for (const needle of needles) {
    assert(value.includes(needle), `expected output to include "${needle}", got ${value}`);
  }
}

async function harnessAssertions(usHome: string): Promise<void> {
  console.log("\n$ harness end-to-end assertions");
  process.env.US_HOME = usHome;
  process.env.US_PEER_CALL_STUB = "1";
  const core = await import("../packages/us-core/src/index.ts");
  const secretPath = join(usHome, "secrets/local.env");
  const receivedMemoryEvents: unknown[] = [];
  const sinkServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      receivedMemoryEvents.push(await request.json());
      return Response.json({ ok: true });
    },
  });
    await core.writeGlobalConfig({
      default_profile: "coo",
      memory: {
      sync: {
        enabled: true,
        provider: "honcho",
        url: `${sinkServer.url.origin}/ingest`,
        workspaceId: "smoke-workspace",
          timeoutMs: 2_000,
        },
      },
      secrets: {
        providers: {
          local: {
            type: "env_file",
            path: "$US_HOME/secrets/local.env",
          },
        },
        entries: {
          "salesforce-prod-read": {
            provider: "local",
            env: {
              SALESFORCE_CLIENT_ID: "US_SALESFORCE_CLIENT_ID",
              SALESFORCE_CLIENT_SECRET: "US_SALESFORCE_CLIENT_SECRET",
            },
            audience: {
              groups: ["go-to-market"],
              roles: ["director"],
            },
          },
          "github-engineering-write": {
            provider: "local",
            env: {
              GITHUB_TOKEN: "US_GITHUB_ENGINEERING_TOKEN",
            },
            audience: {
              groups: ["engineering"],
              roles: ["director", "manager"],
            },
          },
        },
      },
    });
    await mkdir(dirname(secretPath), { recursive: true });
    await writeFile(secretPath, [
      "US_SALESFORCE_CLIENT_ID=salesforce-client",
      "US_SALESFORCE_CLIENT_SECRET=salesforce-secret",
      "US_GITHUB_ENGINEERING_TOKEN=github-token",
      "",
    ].join("\n"), { mode: 0o600 });

  try {
    const syncCfg = await core.resolveMemorySyncConfig("vp-eng");
    assert(syncCfg.enabled === true, "memory sync should be enabled by default/config");
    assert(syncCfg.url === `${sinkServer.url.origin}/ingest`, "memory sync should use configured alternative URL");

    const cooPack = await core.readAgentPack("coo");
    assert(cooPack.oidc.issuer === "urn:union-street:demo-enterprise", "coo pack should use demo OIDC issuer");
    assert(cooPack.identity.directReports.length === 4, "coo should have four direct reports");
    assert(cooPack.lash.delegate === "descendants", "coo should be able to delegate through descendants");

    const vpPack = await core.readAgentPack("vp-eng");
    assert(vpPack.identity.manager === "coo", "vp-eng should report to coo");
    assert(vpPack.model.primary.provider === "codex", "vp-eng model provider should come from agent pack");
    assert(vpPack.model.primary.id === "gpt-5.4", "vp-eng model id should come from agent pack");

    const salesDirectorPack = await core.readAgentPack("dir-gtm-sales");
    await core.writeAgentPack("dir-gtm-sales", {
      ...salesDirectorPack,
      runtime: { ...salesDirectorPack.runtime, secrets: ["salesforce-prod-read", "github-engineering-write"] },
    });
    const engManagerPack = await core.readAgentPack("mgr-eng-platform");
    await core.writeAgentPack("mgr-eng-platform", {
      ...engManagerPack,
      runtime: { ...engManagerPack.runtime, secrets: ["github-engineering-write", "salesforce-prod-read"] },
    });

    const salesSecrets = await core.resolveSecretGrantsForAgent("dir-gtm-sales");
    assert(secretAllowed(salesSecrets, "salesforce-prod-read"), "sales director should receive Salesforce secret grant");
    assert(!secretAllowed(salesSecrets, "github-engineering-write"), "sales director should not receive engineering GitHub grant");
    const engSecrets = await core.resolveSecretGrantsForAgent("mgr-eng-platform");
    assert(secretAllowed(engSecrets, "github-engineering-write"), "engineering manager should receive GitHub secret grant");
    assert(!secretAllowed(engSecrets, "salesforce-prod-read"), "engineering manager should not receive Salesforce grant");

    const salesRuntime = await core.ensureAgentWorkspace("dir-gtm-sales");
    assert(Boolean(salesRuntime.secretsPath), "sales director workspace should get materialized secrets");
    const salesEnv = await readFile(salesRuntime.secretsPath!, "utf8");
    assert(salesEnv.includes("SALESFORCE_CLIENT_ID=\"salesforce-client\""), "sales env should contain Salesforce client id");
    assert(!salesEnv.includes("GITHUB_TOKEN"), "sales env should not contain GitHub token");

    const engRuntime = await core.ensureAgentWorkspace("mgr-eng-platform");
    assert(Boolean(engRuntime.secretsPath), "engineering manager workspace should get materialized secrets");
    const engEnv = await readFile(engRuntime.secretsPath!, "utf8");
    assert(engEnv.includes("GITHUB_TOKEN=\"github-token\""), "engineering env should contain GitHub token");
    assert(!engEnv.includes("SALESFORCE_CLIENT"), "engineering env should not contain Salesforce secrets");

    const cooLinearCred = await core.getMcpCredentialStatus("coo", "linear");
    assert(cooLinearCred.configured && cooLinearCred.source === "profile", "coo should have agent-scoped Linear MCP auth");
    const managerGithubCred = await core.getMcpCredentialStatus("mgr-eng-platform", "github");
    assert(managerGithubCred.configured && managerGithubCred.source === "profile", "engineering manager should have agent-scoped GitHub MCP auth");
    const salesGithubCred = await core.getMcpCredentialStatus("dir-gtm-sales", "github");
    assert(!salesGithubCred.configured, "sales director should not inherit engineering manager MCP auth");

    const mcpServers = [
      { name: "github", source: "smoke", enabled: true, transport: "remote" as const, url: "https://mcp.example.com/github", auth: "oauth" as const },
      { name: "linear", source: "smoke", enabled: true, transport: "remote" as const, url: "https://mcp.example.com/linear", auth: "oauth" as const },
      { name: "stripe", source: "smoke", enabled: true, transport: "remote" as const, url: "https://mcp.example.com/stripe", auth: "oauth" as const },
    ];
    const cooMcp = await core.resolveMcpGrantsForAgent("coo", mcpServers);
    assert(cooMcp.get("linear")?.allowed === true, "coo should be granted executive Linear MCP access");
    const managerMcp = await core.resolveMcpGrantsForAgent("mgr-eng-platform", mcpServers);
    assert(managerMcp.get("github")?.allowed === true, "engineering manager should be granted GitHub MCP access");
    assert(managerMcp.get("linear")?.allowed === false, "engineering manager should not be granted Linear MCP access");

    await assertDelegation(core, "coo", "vp-eng", true, "direct_report");
    await assertDelegation(core, "coo", "mgr-eng-platform", true, "descendant");
    await assertDelegation(core, "vp-eng", "coo", true, "manager");
    await assertDelegation(core, "vp-eng", "dir-eng-infra", true, "direct_report");
    await assertDelegation(core, "vp-eng", "mgr-eng-platform", false);
    await assertDelegation(core, "dir-eng-infra", "mgr-eng-platform", true, "direct_report");
    await assertDelegation(core, "dir-eng-infra", "dir-eng-product", false);
    await assertDelegation(core, "mgr-eng-platform", "dir-eng-infra", true, "manager");
    await assertDelegation(core, "mgr-eng-platform", "vp-eng", false);
    await assertDelegation(core, "coo", "coo", false);

    const identity = await core.resolveAgentPrincipal("vp-eng");
    assert(identity.subject === "agent:vp-eng", "resolved identity should use pack OIDC subject");
    assert(identity.groups.includes("engineering"), "resolved identity should include pack/federation groups");
    assert(identity.principals.includes("group:engineering"), "resolved identity should include group principal");

    const token = await core.mintFederatedAgentToken("vp-eng", { audience: ["union-street-demo"], ttlSeconds: 60 });
    const claims = await core.verifyFederatedAgentToken(token, { audience: "union-street-demo" });
    assert(claims.iss === "urn:union-street:demo-enterprise", "agent token should use pack issuer");
    assert(claims.sub === "agent:vp-eng", "agent token should use pack subject");
    assert(claims.us_profile === "vp-eng", "agent token should include profile claim");
    await assertRejects(
      () => core.verifyFederatedAgentToken(token, { audience: core.federatedAgentMcpAudience("vp-eng") }),
      "audience mismatch",
    );

    const targetToken = await core.mintFederatedAgentToken("vp-eng", {
      audience: [core.federatedAgentMcpAudience("dir-eng-infra")],
      ttlSeconds: 60,
    });
    await core.verifyFederatedAgentToken(targetToken, { audience: core.federatedAgentMcpAudience("dir-eng-infra") });
    await assertRejects(
      () => core.verifyFederatedAgentToken(targetToken, { audience: core.federatedAgentMcpAudience("coo") }),
      "audience mismatch",
    );

    await core.writeAgentPack("vp-eng", {
      ...vpPack,
      oidc: { ...vpPack.oidc, issuer: "urn:union-street:wrong-issuer" },
    });
    await assertRejects(() => core.verifyFederatedAgentToken(token, { audience: "union-street-demo" }), "issuer mismatch");
    await core.writeAgentPack("vp-eng", vpPack);

    const beforeRemoteEvents = receivedMemoryEvents.length;
    const delegateResult = await core.callLashPeerTool({
      targetPeer: "vp-eng",
      method: "delegate",
      arguments: {
        from: "coo",
        prompt: "Review platform readiness and report material blockers upward.",
        thread: core.createLashThread("vp-eng", "trace_smoke_delegate"),
        trace: "trace_smoke_delegate",
      },
    });
    assertResultIncludes(delegateResult, ["@vp-eng woke via delegate from @coo", "model=codex/gpt-5.4"]);

    const reportResult = await core.callLashPeerTool({
      targetPeer: "vp-eng",
      method: "report",
      arguments: {
        from: "dir-eng-infra",
        payload: { status: "green", blockerCount: 0 },
        thread: core.createLashThread("vp-eng", "trace_smoke_report"),
        trace: "trace_smoke_report",
      },
    });
    assertResultIncludes(reportResult, ["@vp-eng woke via report from @dir-eng-infra", "Structured report payload"]);
    const remoteKinds = receivedMemoryEvents.slice(beforeRemoteEvents).map(memoryEventKind);
    assert(remoteKinds.includes("lash.wake"), "remote memory sink should receive Lash wake events");
    assert(remoteKinds.includes("session.message"), "remote memory sink should receive session messages");
    assert(remoteKinds.includes("session.meta"), "remote memory sink should receive session metadata");

    const deniedDelegate = await core.callLashPeerTool({
      targetPeer: "mgr-eng-platform",
      method: "delegate",
      arguments: {
        from: "vp-eng",
        prompt: "Skip the director and go straight to the manager.",
        thread: core.createLashThread("mgr-eng-platform", "trace_smoke_denied_delegate"),
        trace: "trace_smoke_denied_delegate",
      },
    });
    assertResultIncludes(deniedDelegate, ["can only delegate"]);

    const deniedReport = await core.callLashPeerTool({
      targetPeer: "dir-eng-infra",
      method: "report",
      arguments: {
        from: "vp-eng",
        prompt: "Reporting downward should fail.",
        thread: core.createLashThread("dir-eng-infra", "trace_smoke_denied_report"),
        trace: "trace_smoke_denied_report",
      },
    });
    assertResultIncludes(deniedReport, ["can only report to its direct manager"]);

    const wrongToken = await core.mintFederatedAgentToken("coo", {
      audience: [core.federatedAgentMcpAudience("coo")],
      ttlSeconds: 60,
    });
    const deniedToken = await core.callLashPeerTool({
      targetPeer: "vp-eng",
      method: "delegate",
      arguments: {
        from: "coo",
        caller_token: wrongToken,
        prompt: "This has the wrong MCP audience.",
        thread: core.createLashThread("vp-eng", "trace_smoke_wrong_aud"),
        trace: "trace_smoke_wrong_aud",
      },
    });
    assertResultIncludes(deniedToken, ["invalid federated caller token", "audience mismatch"]);

    await core.writeGlobalConfig({
      default_profile: "coo",
      memory: { sync: { enabled: false, url: `${sinkServer.url.origin}/disabled`, workspaceId: "smoke-workspace" } },
    });
    const disabledCount = receivedMemoryEvents.length;
    await core.callLashPeerTool({
      targetPeer: "vp-eng",
      method: "delegate",
      arguments: {
        from: "coo",
        prompt: "This should stay local because remote memory sync is disabled.",
        thread: core.createLashThread("vp-eng", "trace_smoke_sync_disabled"),
        trace: "trace_smoke_sync_disabled",
      },
    });
    assert(receivedMemoryEvents.length === disabledCount, "disabled memory sync should not send remote events");

    const sessionsDir = join(usHome, "profiles/vp-eng/sessions");
    const sessionFiles = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: sessionsDir }));
    assert(sessionFiles.length >= 2, "Lash wakeups should create target peer session files");
    const sessionBodies = await Promise.all(sessionFiles.map((file) => readFile(join(sessionsDir, file), "utf8")));
    assert(sessionBodies.some((body) => body.includes("\"kind\":\"lash_wake\"")), "session log should include lash wake records");
    assert(sessionBodies.some((body) => body.includes("\"role\":\"assistant\"")), "session log should include stubbed assistant responses");
    const memoryEvents = await readFile(join(usHome, "profiles/vp-eng/memory/events.jsonl"), "utf8");
    assert(memoryEvents.includes("\"kind\":\"lash.wake\""), "local memory events should include lash wake records");
    assert(memoryEvents.includes("trace_smoke_sync_disabled"), "local memory events should still record sync-disabled wakes");
  } finally {
    sinkServer.stop(true);
  }
}

async function assertDelegation(
  core: typeof import("../packages/us-core/src/index.ts"),
  from: string,
  to: string,
  allowed: boolean,
  relation?: string,
): Promise<void> {
  const decision = await core.canDelegateTo(from, to);
  assert(decision.allowed === allowed, `expected @${from} -> @${to} allowed=${allowed}, got ${decision.allowed}: ${decision.reason}`);
  if (relation) assert(decision.relation === relation, `expected @${from} -> @${to} relation=${relation}, got ${decision.relation}`);
}

async function assertRejects(fn: () => Promise<unknown>, messageNeedle: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = (error as Error).message;
    assert(message.includes(messageNeedle), `expected rejection to include "${messageNeedle}", got "${message}"`);
    return;
  }
  throw new Error(`expected promise to reject with "${messageNeedle}"`);
}

function assertResultIncludes(result: unknown, needles: string[]): void {
  const text = stringifyResult(result);
  for (const needle of needles) {
    assert(text.includes(needle), `expected Lash result to include "${needle}", got ${text}`);
  }
}

function stringifyResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const item = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  const parts = [
    ...(item.content ?? []).map((entry) => entry.text ?? JSON.stringify(entry)),
    item.structuredContent ? JSON.stringify(item.structuredContent) : "",
    JSON.stringify(result),
  ];
  return parts.join("\n");
}

function memoryEventKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as { event?: { kind?: string } };
  return envelope.event?.kind;
}

function secretAllowed(secrets: Array<{ id: string; allowed: boolean }>, id: string): boolean {
  return secrets.some((secret) => secret.id === id && secret.allowed);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
