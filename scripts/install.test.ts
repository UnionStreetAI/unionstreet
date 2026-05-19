import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const installSh = join(repoRoot, "scripts/install.sh");

describe("install.sh", () => {
  test("passes bash syntax check", async () => {
    // Arrange
    const proc = Bun.spawn(["bash", "-n", installSh], { stdout: "pipe", stderr: "pipe" });

    // Act
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    // Assert
    expect(code, stderr).toBe(0);
  });

  test("prints help", async () => {
    // Arrange
    const proc = Bun.spawn(["bash", installSh, "--help"], { stdout: "pipe", stderr: "pipe" });

    // Act
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

    // Assert
    expect(code).toBe(0);
    expect(stdout).toContain("unionstreet.ai/install.sh");
    expect(stdout).toContain("US_VERSION");
  });

  test("documents unionstreet.ai and npm package", async () => {
    // Arrange
    const script = await readFile(installSh, "utf8");

    // Act
    const hasPackage = script.includes("@unionstreet/us");
    const hasInstallUrl = script.includes("unionstreet.ai/install");
    const hasBunInstaller = script.includes("bun.sh/install");

    // Assert
    expect(hasPackage).toBe(true);
    expect(hasInstallUrl).toBe(true);
    expect(hasBunInstaller).toBe(true);
  });
});
