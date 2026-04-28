/**
 * Smoke test: stream a one-shot reply from Codex using the user's stored token.
 *
 * Usage:
 *   bun run packages/ai-codex/scripts/smoke.ts [model]
 *
 * Reads ~/.us/auth-profiles.json directly to keep this self-contained.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamCodex } from "../src/index.ts";

const usHome = process.env.US_HOME ?? join(homedir(), ".us");
const authPath = join(usHome, "auth-profiles.json");
const file = JSON.parse(readFileSync(authPath, "utf8"));
const codex = file.providers?.codex;
if (!codex || codex.kind !== "oauth") {
  console.error(`No codex OAuth credential at ${authPath}. Run \`us-dev auth codex\`.`);
  process.exit(1);
}

const model = process.argv[2] ?? "gpt-5";
const messages = [
  { role: "user" as const, content: "In one short sentence: what is the capital of France?" },
];

console.log(`Asking ${model} via Codex (account-tokens, no API key)…\n`);

let bytes = 0;
const t0 = Date.now();
for await (const ev of streamCodex({
  token: codex.access,
  model,
  system: "You are a terse oracle. Answer in one sentence.",
  messages,
  textVerbosity: "low",
})) {
  if (ev.type === "text-delta") {
    process.stdout.write(ev.text);
    bytes += ev.text.length;
  } else if (ev.type === "finish") {
    console.log(`\n\n[finish: ${ev.reason}, ${bytes} chars in ${Date.now() - t0}ms]`);
  } else if (ev.type === "error") {
    console.error(`\n[ERROR] ${ev.error}`);
    process.exit(2);
  }
}
