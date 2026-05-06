#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const usHome = await mkdtemp(join(tmpdir(), "union-street-stress-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-stress-work-"));
const AUTHORIZED_READS = 250;
const UNAUTHORIZED_READS = 50;

try {
  process.env.US_HOME = usHome;
  process.env.US_PEER_CALL_STUB = "1";
  process.env.US_STREAM_MODEL_STUB = "1";
  process.env.US_MEMORY_SYNC = "0";
  process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

  console.log("stress setup: federation demo-org");
  await withTimeout("federation setup", run(["bun", "run", "packages/us-cli/src/index.ts", "federation", "demo-org", "--profiles", "--mcp"], {
      cwd: repoRoot,
      env: process.env as Record<string, string>,
    }), 30_000);

  console.log("stress setup: runtime handler");
  const runtime = await import("../packages/server/src/http/index.ts");
  const handler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "stress-token" });
  const paths = [
    "/api/runtime",
    "/api/agents",
    "/api/runtimes",
    "/api/scheduler/jobs",
    "/api/events?limit=250",
    "/api/usage?limit=1000",
    "/api/memory?limit=250",
  ];

  await withTimeout("cors assertions", assertCors(handler), 10_000);
  console.log("stress burst: authorized reads");
  await withTimeout("authorized read burst", burst(handler, paths, AUTHORIZED_READS, "authorized read burst"), 30_000);
  console.log("stress burst: unauthorized reads");
  await withTimeout("unauthorized burst", unauthorizedBurst(handler, paths, UNAUTHORIZED_READS), 10_000);

  console.log("stress run passed");
} finally {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
}

async function assertCors(handler: (request: Request) => Promise<Response>): Promise<void> {
  const local = await handler(new Request("http://runtime.test/api/agents", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173" },
  }));
  assert(local.headers.get("access-control-allow-origin") === "http://localhost:5173", "local dashboard origin should be allowed");

  const hostile = await handler(new Request("http://runtime.test/api/agents", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  }));
  assert(hostile.headers.get("access-control-allow-origin") === null, "untrusted origin must not receive CORS access");
}

async function burst(
  handler: (request: Request) => Promise<Response>,
  paths: string[],
  count: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  let failures = 0;
  for (let offset = 0; offset < count; offset += 50) {
    const batchSize = Math.min(50, count - offset);
    const responses = await Promise.all(Array.from({ length: batchSize }, (_, batchIndex) => {
      const index = offset + batchIndex;
      return handler(new Request(
        `http://runtime.test${paths[index % paths.length]}`,
        {
          headers: {
            authorization: "Bearer stress-token",
            origin: "http://127.0.0.1:5173",
          },
        },
      ));
    }));
    failures += responses.filter((response) => response.status !== 200).length;
  }
  assert(failures === 0, `${label} had ${failures} non-200 responses`);
  console.log(`${label}: ${count} requests in ${Date.now() - started}ms`);
}

async function unauthorizedBurst(
  handler: (request: Request) => Promise<Response>,
  paths: string[],
  count: number,
): Promise<void> {
  let unexpected = 0;
  for (let offset = 0; offset < count; offset += 50) {
    const batchSize = Math.min(50, count - offset);
    const responses = await Promise.all(Array.from({ length: batchSize }, (_, batchIndex) => {
      const index = offset + batchIndex;
      return handler(new Request(`http://runtime.test${paths[index % paths.length]}`));
    }));
    unexpected += responses.filter((response) => response.status !== 401).length;
  }
  assert(unexpected === 0, `unauthorized burst had ${unexpected} non-401 responses`);
  console.log(`unauthorized burst: ${count} requests rejected`);
}

async function run(
  cmd: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    throw new Error(`${cmd.join(" ")} exited ${code}`);
  }
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
