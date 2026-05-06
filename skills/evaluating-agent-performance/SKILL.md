---
name: evaluating-agent-performance
description: Evaluate Union Street agent and fleet behavior using traces, memory events, usage records, reports, live runs, and stress tests. Use when assessing whether agents did useful work or information flowed correctly.
license: MIT
compatibility: Requires Union Street event, memory, usage, and Lash traces.
---

# Evaluating Agent Performance

Judge behavior, not just pass/fail tests.

## Evaluation Surface

- Did the head agent choose useful delegation paths?
- Did managers call the right direct reports?
- Did reports flow upward with evidence?
- Did memory record wakes, tool results, and final reports?
- Did agents loop, over-delegate, invent peers, or ignore chain of command?
- Were token usage and model costs plausible for the work done?

## Commands

```sh
bun run us events query --trace <trace> --limit 200
bun run us events query --type usage.record --limit 200
bun run check:fast
bun run check:adversarial
```

For live fleet tests, record model/provider, concurrency, trace id, agent count, runtime, and memory mode.

## Reference Config

Use `references/performance-report.yaml` as the minimum useful org-run report shape.
