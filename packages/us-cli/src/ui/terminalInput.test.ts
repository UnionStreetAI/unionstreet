import { describe, expect, test } from "bun:test";
import { cleanTextareaValue, stripTerminalMousePackets } from "./terminalInput.ts";

describe("terminal input sanitization", () => {
  test("stripTerminalMousePackets_WhenOpenTuiMouseSequencesLeakIntoInput_RemovesOnlyPackets", () => {
    const raw = "hello\x1b[<35;6;42M world [<64;12;3m <65;2;9M 35;6;42M done";

    const clean = stripTerminalMousePackets(raw);

    expect(clean, "Mouse tracking escape packets should be stripped without deleting surrounding typed text.").toBe("hello world    done");
  });

  test("cleanTextareaValue_WhenSanitizedTextDiffers_UpdatesTextareaAndReturnsCleanValue", () => {
    const textarea = {
      plainText: "ask 35;6;42M question",
      writes: [] as string[],
      setText(text: string) {
        this.writes.push(text);
        this.plainText = text;
      },
    };

    const clean = cleanTextareaValue(textarea);

    expect(clean, "Cleaned textarea values should be returned to the submit path.").toBe("ask  question");
    expect(textarea.writes, "The visible input should be repaired so artifacts do not remain onscreen.").toEqual(["ask  question"]);
  });

  test("cleanTextareaValue_WhenTextareaIsMissing_ReturnsEmptyString", () => {
    const clean = cleanTextareaValue(null);

    expect(clean, "Missing textarea refs should be treated as empty input instead of throwing during TUI startup.").toBe("");
  });
});
