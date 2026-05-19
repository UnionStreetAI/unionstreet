#!/usr/bin/env bun
/**
 * Copies workspace package sources into packages/npm/.pack for the single npm tarball.
 * Dev continues to use packages/{server,sdk,...} directly; only publish uses .pack.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { rewritePackTree } from "./rewrite-pack-imports.ts";

const repoRoot = join(import.meta.dir, "..");
const packRoot = join(repoRoot, "packages/npm/.pack");

const modules = ["server", "us-auth", "ai-codex", "sdk", "us-cli"] as const;

await rm(packRoot, { recursive: true, force: true });
await mkdir(packRoot, { recursive: true });

for (const name of modules) {
  const src = join(repoRoot, "packages", name, "src");
  const dest = join(packRoot, name, "src");
  await cp(src, dest, { recursive: true, force: true });
}

let pruned = 0;
const testGlob = new Bun.Glob("**/*.{test,spec}.{ts,tsx}");
for await (const file of testGlob.scan({ cwd: packRoot, onlyFiles: true })) {
  await rm(join(packRoot, file));
  pruned += 1;
}

const rewritten = await rewritePackTree(packRoot);

console.log(
  `staged ${modules.length} modules → packages/npm/.pack (pruned ${pruned} test files, rewrote imports in ${rewritten} files)`,
);
