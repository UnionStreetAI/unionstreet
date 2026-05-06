import { describe, expect, test } from "bun:test";
import { createLashThread, nextLashContext } from "./lash-context.ts";

describe("lash context", () => {
  test("createLashThread_WhenGivenTargetAndTrace_ReturnsResumableTargetThread", () => {
    const targetAgent = "vp-eng";
    const traceId = "trace_test";

    const thread = createLashThread(targetAgent, traceId);

    expect(
      thread.id,
      "A Lash thread id must combine target and trace so delegated work can resume the same target-specific conversation.",
    ).toBe(`${targetAgent}/${traceId}`);
    expect(
      thread.resume,
      "Delegation should resume or create target threads instead of starting disconnected report channels.",
    ).toBe("resume_or_create");
    expect(
      thread.turn,
      "A newly created Lash thread must start at turn zero before the first delegated message is appended.",
    ).toBe(0);
  });

  test("nextLashContext_WhenDelegatingDownChain_IncrementsTurnsAndAppendsHops", () => {
    const first = nextLashContext({ caller: "coo", target: "vp-eng", trace: "trace_test" });

    const second = nextLashContext({
      caller: "vp-eng",
      target: "dir-eng-infra",
      trace: first.trace,
      thread: first.thread,
      chain: first.chain,
    });

    expect(
      first.thread.turn,
      "The first delegated Lash context should advance the target thread to turn one.",
    ).toBe(1);
    expect(
      second.thread.turn,
      "A second delegated Lash context must preserve the thread and advance to turn two rather than resetting.",
    ).toBe(2);
    expect(
      second.chain.map((hop) => `${hop.from}->${hop.to}`),
      "The delegation chain must preserve each hop in order so reports can flow back through the same command path.",
    ).toEqual(["coo->vp-eng", "vp-eng->dir-eng-infra"]);
  });
});
