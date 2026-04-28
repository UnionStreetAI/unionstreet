import { describe, expect, test } from "bun:test";
import { parseSlash, REGISTRY, type SlashContext, type OverlayState } from "./slash.ts";

describe("slash command parsing", () => {
  test("parseSlash_WhenTextIsRecognizedCommandShape_ReturnsNameAndTrimmedArg", () => {
    const parsed = [
      parseSlash("/model gpt-5.4"),
      parseSlash("/mcp"),
      parseSlash("/aside    check this"),
    ];

    expect(parsed, "Slash parsing should keep command names separate from optional arguments.").toEqual([
      { name: "model", arg: "gpt-5.4" },
      { name: "mcp", arg: undefined },
      { name: "aside", arg: "check this" },
    ]);
  });

  test("parseSlash_WhenTextIsNotSlashCommand_ReturnsNull", () => {
    const parsed = [
      parseSlash("hello"),
      parseSlash("/"),
      parseSlash("/123"),
      parseSlash("/bad command"),
    ];

    expect(parsed, "Only syntactically valid slash commands should be dispatched.").toEqual([null, null, null, { name: "bad", arg: "command" }]);
  });
});

describe("slash command behavior", () => {
  test("modelCommand_WhenKnownModelArgIsProvided_SelectsModelAndReportsSystemNote", async () => {
    const state = createSlashState();

    await REGISTRY.model!.run({ arg: "gpt-5.4", state });

    expect(state.modelIds, "A known model argument should update the active session model.").toEqual(["gpt-5.4"]);
    expect(state.notes, "Model selection should leave an operator-visible confirmation.").toEqual(["model → gpt-5.4"]);
    expect(state.overlays, "Selecting by explicit model id should not open the picker.").toEqual([]);
  });

  test("modelCommand_WhenUnknownModelArgIsProvided_DoesNotChangeModelAndReportsKnownModels", async () => {
    const state = createSlashState();

    await REGISTRY.model!.run({ arg: "missing-model", state });

    expect(state.modelIds, "Unknown model ids should not mutate the active model.").toEqual([]);
    expect(state.notes[0], "Unknown model errors should include the bad id and known alternatives.").toContain('unknown model "missing-model"');
  });

  test("modelCommand_WhenNoArgIsProvided_OpensModelPickerOverlay", async () => {
    const state = createSlashState();

    await REGISTRY.model!.run({ state });

    expect(state.overlays, "Bare /model should open the model picker.").toEqual([{ kind: "model-picker" }]);
  });

  test("newAndCostCommands_WhenInvoked_DelegateToSessionAndAccountingHandlers", async () => {
    const state = createSlashState();

    await REGISTRY.new!.run({ state });
    await REGISTRY.cost!.run({ state });

    expect(state.newSessionCalls, "/new should create a fresh session through the app state boundary.").toBe(1);
    expect(state.showCostCalls, "/cost should use the session accounting path, not a static note.").toBe(1);
  });

  test("helpCommand_WhenInvoked_ListsRegisteredCommands", async () => {
    const state = createSlashState();

    await REGISTRY.help!.run({ state });

    expect(state.notes, "/help should emit a single command reference note.").toHaveLength(1);
    expect(state.notes[0], "Help output should include the newer orchestration commands.").toContain("/mcp");
    expect(state.notes[0], "Help output should include session accounting.").toContain("/cost");
  });
});

function createSlashState(): SlashContext["state"] & {
  modelIds: string[];
  notes: string[];
  overlays: Array<OverlayState | null>;
  newSessionCalls: number;
  showCostCalls: number;
} {
  return {
    modelId: "gpt-5.4",
    modelIds: [],
    notes: [],
    overlays: [],
    newSessionCalls: 0,
    showCostCalls: 0,
    setModelId(id: string) {
      this.modelIds.push(id);
      this.modelId = id;
    },
    clearTranscript() {},
    async newSession() {
      this.newSessionCalls += 1;
    },
    exit() {},
    setOverlay(overlay: OverlayState | null) {
      this.overlays.push(overlay);
    },
    pushSystemNote(text: string) {
      this.notes.push(text);
    },
    async compact() {},
    async showCost() {
      this.showCostCalls += 1;
    },
  };
}
