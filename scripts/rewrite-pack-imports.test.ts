import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rewritePackImports } from "./rewrite-pack-imports.ts";

const packRoot = join(import.meta.dir, "..", "packages/npm/.pack");

describe("rewritePackImports", () => {
  test("rewrites workspace imports to relative paths", () => {
    // Arrange
    const fromFile = join(packRoot, "us-cli/src/index.ts");
    const source = `import { x } from "@unionstreet/server";\nconst y = await import("@unionstreet/ai-codex");`;

    // Act
    const out = rewritePackImports(source, fromFile, packRoot);

    // Assert
    expect(out).toContain('from "../../server/src/index"');
    expect(out).toContain('import("../../ai-codex/src/index")');
    expect(out).not.toContain("@unionstreet/");
  });
});
