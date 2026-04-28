import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { STARTER_TOOLS, toolByName, toolDefinitions } from "./index.ts";

const cwd = await mkdtemp(join(tmpdir(), "union-street-tools-test-"));
const tools = toolByName(STARTER_TOOLS);

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function tool(name: string) {
  const found = tools.get(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("starter tools", () => {
  test("toolDefinitions_WhenStarterToolsArePublished_ExposeStrictFunctionSchemasForModelUse", () => {
    const definitions = toolDefinitions(STARTER_TOOLS);

    expect(
      definitions.map((definition) => definition.name).sort(),
      "The model-visible starter tool surface should include filesystem, shell, and Lash coordination tools.",
    ).toEqual(["bash", "delegate", "edit", "grep", "ls", "read", "report", "write"]);
    expect(
      definitions.every((definition) => definition.type === "function" && definition.parameters.type === "object"),
      "Every starter tool must be exported as an OpenAI-compatible function schema.",
    ).toBe(true);
    expect(
      definitions.filter((definition) => definition.name !== "report").every((definition) => definition.parameters.additionalProperties === false),
      "Starter tool schemas should reject accidental extra arguments so agent behavior stays deterministic.",
    ).toBe(true);
  });

  test("writeAndReadTools_WhenNestedFileIsWritten_ReadBackFullAndSlicedContent", async () => {
    const write = tool("write");
    const read = tool("read");

    const writeResult = await write.execute({ path: "notes/status.txt", content: "alpha\nbeta\ngamma\n" }, { cwd });
    const full = await read.execute({ path: "notes/status.txt" }, { cwd });
    const sliced = await read.execute({ path: "notes/status.txt", offset: 2, limit: 1 }, { cwd });

    expect(writeResult, "write should create parent directories and report the byte count it persisted.").toContain("wrote 17 bytes");
    expect(full, "read without a slice should return the complete UTF-8 file content.").toBe("alpha\nbeta\ngamma\n");
    expect(sliced, "read with offset/limit should return stable 1-indexed line-numbered slices for agent context.").toBe("2\tbeta");
  });

  test("lsTool_WhenDirectoryContainsFilesAndSubdirectories_ReturnsSortedDirectoryMarkedEntries", async () => {
    await tool("write").execute({ path: "tree/zeta.txt", content: "z" }, { cwd });
    await tool("write").execute({ path: "tree/alpha/file.txt", content: "a" }, { cwd });

    const listing = await tool("ls").execute({ path: "tree" }, { cwd });

    expect(
      listing.split("\n"),
      "ls output should be sorted and should mark directories with a trailing slash so models can distinguish navigation from file reads.",
    ).toEqual(["alpha/", "zeta.txt"]);
  });

  test("editTool_WhenSubstringIsAmbiguous_RefusesSingleReplacementUntilReplaceAllIsExplicit", async () => {
    await tool("write").execute({ path: "edit/plan.md", content: "todo\nkeep\ntodo\n" }, { cwd });

    const ambiguous = await tool("edit").execute({ path: "edit/plan.md", old: "todo", new: "done" }, { cwd });
    const replaced = await tool("edit").execute({ path: "edit/plan.md", old: "todo", new: "done", replace_all: true }, { cwd });
    const content = await readFile(join(cwd, "edit", "plan.md"), "utf8");

    expect(ambiguous, "edit should not guess when the old string appears more than once.").toContain("appears multiple times");
    expect(replaced, "replace_all should make bulk replacement intentional and count the edits.").toContain("2 replacements");
    expect(content, "replace_all should update every matching occurrence while preserving unrelated text.").toBe("done\nkeep\ndone\n");
  });

  test("grepTool_WhenNoMatchExists_ReturnsRecoverableNoMatchesMessage", async () => {
    await tool("write").execute({ path: "grep/notes.txt", content: "alpha\nbeta\n" }, { cwd });

    const output = await tool("grep").execute({ path: "grep", pattern: "delta" }, { cwd });

    expect(output, "grep misses should be a recoverable model-readable result, not a thrown exception.").toBe("(no matches)");
  });

  test("bashTool_WhenCommandTimesOut_ReportsTimeoutAndExitInsteadOfHanging", async () => {
    const output = await tool("bash").execute({ command: "sleep 1", timeout_ms: 100 }, { cwd });

    expect(output, "bash timeout should kill the subprocess and mark the result as timed out.").toContain("TIMED OUT");
    expect(output, "bash timeout output should still include an exit header for auditability.").toContain("exit");
  });

  test("delegateAndReportTools_WhenRequiredPromptIsMissing_ReturnActionableErrorsBeforeMcpCalls", async () => {
    const delegate = await tool("delegate").execute({ peer: "vp-eng" }, { cwd, callingPeer: "coo" });
    const report = await tool("report").execute({}, { cwd, callingPeer: "vp-eng" });

    expect(delegate, "delegate should validate message/prompt/payload/envelope before waking another peer.").toBe("error: provide `message`, `prompt`, `payload`, or `envelope`");
    expect(report, "report should validate message/prompt/payload/envelope before resolving a manager.").toBe("error: provide `message`, `prompt`, `payload`, or `envelope`");
  });
});
