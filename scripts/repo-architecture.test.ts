import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = process.cwd();
const staleServerSplitPatterns = [
  "@unionstreet/us-core",
  "@unionstreet/us-runtime",
  "packages/us-core",
  "packages/us-runtime",
  "us-core",
  "us-runtime",
];

const scannedGlobs = [
  "package.json",
  "packages/**/*.json",
  "packages/**/*.ts",
  "packages/**/*.tsx",
  "scripts/**/*.ts",
  "docs/**/*.md",
  "README.md",
  "docker/Dockerfile.*",
];

describe("repo architecture guardrails", () => {
  test("package graph exposes server as the unified agent/runtime package", async () => {
    const packages = await readdir(join(repoRoot, "packages"));

    expect(packages, "The old core/runtime split should not exist as workspace packages after the server consolidation.").not.toContain("us-core");
    expect(packages, "The old core/runtime split should not exist as workspace packages after the server consolidation.").not.toContain("us-runtime");
    expect(packages, "The unified server package must be the product/runtime owner.").toContain("server");

    const serverPackage = JSON.parse(await readFile(join(repoRoot, "packages/server/package.json"), "utf8"));
    const cliPackage = JSON.parse(await readFile(join(repoRoot, "packages/us-cli/package.json"), "utf8"));

    expect(serverPackage.name, "The server package should be the public package identity for agents, runs, plugins, providers, and HTTP.").toBe("@unionstreet/server");
    expect(cliPackage.dependencies["@unionstreet/server"], "The CLI must consume the unified server package instead of reaching for legacy core/runtime packages.").toBe("workspace:*");
    expect(Object.keys(cliPackage.dependencies).filter((name) => name === "@unionstreet/server"), "The CLI dependency graph should only include one server edge.").toHaveLength(1);
  });

  test("source tree has no stale core/runtime package references", async () => {
    const files = await filesForGlobs(scannedGlobs);
    const offenders: string[] = [];

    for (const file of files) {
      if (file === "scripts/repo-architecture.test.ts") continue;
      const raw = await readFile(join(repoRoot, file), "utf8");
      for (const pattern of staleServerSplitPatterns) {
        if (raw.includes(pattern)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders, "Stale core/runtime references make the package graph drift back into the old split.").toEqual([]);
  });

  test("test command runs isolated test files instead of one shared process", async () => {
    const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const runner = await readFile(join(repoRoot, "scripts/test-files.ts"), "utf8");

    expect(rootPackage.scripts.test, "Filesystem-heavy server tests must run through the isolated file runner.").toBe("bun run scripts/test-files.ts");
    expect(runner, "The isolated runner should spawn each discovered test file in a fresh Bun process.").toContain('Bun.spawn(["bun", "test", file]');
  });
});

async function filesForGlobs(patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan({ cwd: repoRoot, absolute: false, onlyFiles: true })) {
      if (await isReadableFile(file)) files.add(file);
    }
  }
  return [...files].sort();
}

async function isReadableFile(file: string): Promise<boolean> {
  try {
    return (await stat(join(repoRoot, file))).isFile();
  } catch {
    return false;
  }
}
