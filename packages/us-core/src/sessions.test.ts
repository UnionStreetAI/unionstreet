import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ANCHOR_MARKER } from "./compaction.ts";
import { readSession } from "./sessions.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session compaction replay", () => {
  test("readSession_WhenCompactionEntryHasSummary_RebuildsAnchorMessageAndTranscriptTurn", async () => {
    const file = await writeSession([
      { role: "user", content: "start", ts: 1 },
      {
        kind: "compaction",
        anchor_id: "anchor-1",
        summary: "## Goal\n- continue safely",
        dropped_count: 4,
        tokens_before: 10_000,
        tokens_after: 2_000,
        ts: 2,
      },
      { role: "user", content: "after", ts: 3 },
    ]);

    const replay = await readSession("coo", file);

    expect(
      replay.messages,
      "Compaction replay must insert a system anchor into model context at the exact point where old messages were summarized.",
    ).toEqual([
      { role: "user", content: "start" },
      { role: "system", content: `${ANCHOR_MARKER}\n\n## Goal\n- continue safely` },
      { role: "user", content: "after" },
    ]);
    expect(
      replay.turns.find((turn) => turn.kind === "compaction"),
      "Compaction replay must also recreate a UI transcript turn so operators can see where history was compressed.",
    ).toMatchObject({
      kind: "compaction",
      droppedCount: 4,
      tokensBefore: 10_000,
      tokensAfter: 2_000,
      summary: "## Goal\n- continue safely",
    });
  });

  test("readSession_WhenOldCompactionEntryHasNoSummary_UsesVisiblePlaceholderAnchor", async () => {
    const file = await writeSession([
      { kind: "compaction", anchor_id: "anchor-legacy", dropped_count: 2, tokens_before: 1_000, tokens_after: 250, ts: 1 },
    ]);

    const replay = await readSession("coo", file);

    expect(
      replay.messages[0],
      "Legacy compaction records without inline summaries must still produce an explicit anchor instead of silently dropping the compaction point.",
    ).toEqual({
      role: "system",
      content: `${ANCHOR_MARKER}\n\n(summary not persisted in this session — older format)`,
    });
  });

  test("readSession_WhenSessionMetaRecordsModel_RemembersLastModelAcrossCompaction", async () => {
    const file = await writeSession([
      { kind: "session_meta", provider: "openai", model: "gpt-5.4", ts: 1 },
      { kind: "compaction", anchor_id: "anchor-1", summary: "summary", dropped_count: 1, tokens_before: 10, tokens_after: 5, ts: 2 },
      { kind: "session_meta", provider: "anthropic", model: "claude-opus-4-7", ts: 3 },
    ]);

    const replay = await readSession("coo", file);

    expect(
      replay.model,
      "Resuming a compacted session must restore the last recorded provider/model, not the first one seen before compaction.",
    ).toEqual({ provider: "anthropic", id: "claude-opus-4-7" });
  });
});

async function writeSession(rows: Array<Record<string, unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "union-street-session-test-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
