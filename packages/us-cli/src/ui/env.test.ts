import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactPath, detectEnv } from "./env.ts";

const workdir = await mkdtemp(join(tmpdir(), "union-street-cli-env-test-"));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("environment detection", () => {
  test("compactPath_WhenPathIsInsideHome_ReplacesHomeWithTilde", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/tester";

    const compact = compactPath("/Users/tester/project/src");

    process.env.HOME = originalHome;
    expect(compact, "Status bars should avoid rendering long home-prefixed paths.").toBe("~/project/src");
  });

  test("detectEnv_WhenPackageJsonAndBunLockExist_ReturnsNodeManagerWithoutThrowing", async () => {
    await writeFile(join(workdir, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(workdir, "bun.lock"), "");
    const originalAws = process.env.AWS_PROFILE;
    const originalVenv = process.env.VIRTUAL_ENV;
    process.env.AWS_PROFILE = "prod";
    process.env.VIRTUAL_ENV = "/tmp/venvs/union-street";

    const env = await detectEnv(workdir);

    process.env.AWS_PROFILE = originalAws;
    process.env.VIRTUAL_ENV = originalVenv;
    expect(env.cwd, "Environment detection should return the cwd it inspected.").toBe(workdir);
    expect(env.node, "Node detector should choose bun when a bun lockfile is present.").toEqual({ manager: "bun" });
    expect(env.aws, "AWS profile should be surfaced from the environment for operator context.").toEqual({ profile: "prod" });
    expect(env.python, "Python venv display should use the basename only.").toEqual({ venv: "union-street" });
  });
});
