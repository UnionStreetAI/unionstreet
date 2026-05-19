/**
 * Rewrites workspace package imports in packages/npm/.pack to relative paths so
 * Bun can resolve them when @unionstreet/us is installed from npm (imports map
 * does not apply to files under .pack/).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** Longest specifiers first so @unionstreet/us-auth/oauth wins over @unionstreet/us-auth. */
export const PACK_IMPORT_TARGETS: Readonly<Record<string, string>> = {
  "@unionstreet/us-auth/oauth": "us-auth/src/oauth/index.ts",
  "@unionstreet/us-auth": "us-auth/src/index.ts",
  "@unionstreet/ai-codex": "ai-codex/src/index.ts",
  "@unionstreet/server": "server/src/index.ts",
  "@unionstreet/sdk": "sdk/src/index.ts",
};

const SPECIFIERS = Object.keys(PACK_IMPORT_TARGETS).sort((a, b) => b.length - a.length);

const IMPORT_RE =
  /(?:from|import\s*\()\s*["'](@unionstreet\/[^"']+)["']/g;

function toImportPath(fromFile: string, packRoot: string, targetRel: string): string {
  const fromDir = dirname(fromFile);
  const targetFile = join(packRoot, targetRel);
  let rel = relative(fromDir, targetFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.tsx?$/, "");
}

export function rewritePackImports(content: string, fromFile: string, packRoot: string): string {
  return content.replace(IMPORT_RE, (match, specifier: string) => {
    const target = PACK_IMPORT_TARGETS[specifier];
    if (!target) {
      throw new Error(`${fromFile}: unsupported pack import ${specifier}`);
    }
    const rel = toImportPath(fromFile, packRoot, target);
    return match.replace(specifier, rel);
  });
}

export async function rewritePackTree(packRoot: string): Promise<number> {
  let files = 0;
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  for await (const file of glob.scan({ cwd: packRoot, onlyFiles: true })) {
    const path = join(packRoot, file);
    const original = await readFile(path, "utf8");
    const rewritten = rewritePackImports(original, path, packRoot);
    if (rewritten !== original) {
      await writeFile(path, rewritten);
      files += 1;
    }
  }
  return files;
}
