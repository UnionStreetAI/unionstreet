import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const npmPackage = join(repoRoot, "packages/npm/package.json");

describe("npm packaging", () => {
  test("only @unionstreet/us is published from packages/npm", async () => {
    // Arrange
    const pkg = JSON.parse(await readFile(npmPackage, "utf8"));

    // Act
    const isPublicUnionStreetUs =
      pkg.name === "@unionstreet/us" && pkg.private !== true && pkg.bin.us === "bin/us";

    // Assert
    expect(isPublicUnionStreetUs).toBe(true);
    expect(existsSync(join(repoRoot, "packages/npm/bin/us"))).toBe(true);
    expect(pkg.exports["./server"]).toContain(".pack/server");
    expect(pkg.exports["./sdk"]).toContain(".pack/sdk");
  });

  test("workspace libraries are private and not separately published", async () => {
    // Arrange
    const privateLibs = ["server", "sdk", "us-auth", "ai-codex", "us-cli", "us-dashboard"];

    // Act
    const flags = await Promise.all(
      privateLibs.map(async (dir) => {
        const pkg = JSON.parse(await readFile(join(repoRoot, "packages", dir, "package.json"), "utf8"));
        return pkg.private === true;
      }),
    );

    // Assert
    expect(flags.every(Boolean)).toBe(true);
  });

  test("stage-npm-package copies all module sources", async () => {
    // Arrange
    const proc = Bun.spawn(["bun", "run", join(repoRoot, "scripts/stage-npm-package.ts")], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Act
    const code = await proc.exited;

    // Assert
    expect(code).toBe(0);
    for (const mod of ["server", "us-auth", "ai-codex", "sdk", "us-cli"]) {
      expect(
        existsSync(join(repoRoot, "packages/npm/.pack", mod, "src/index.ts")),
        `${mod} src should be staged`,
      ).toBe(true);
    }
    expect(
      existsSync(join(repoRoot, "packages/npm/.pack/server/src/agent-pack.test.ts")),
      "test files should not ship in the npm tarball",
    ).toBe(false);
  });
});
