---
name: token-accounting
description: Inspect, configure, and reason about Union Street token usage, model accounting modes, free providers, and usage records. Use when debugging cost, throughput, or token-heavy fleet behavior.
license: MIT
compatibility: Requires Union Street usage events and model/provider config.
---

# Token Accounting

Track usage as operating telemetry. Cost may be zero for free/custom providers, but tokens still measure behavior.

## Workflow

1. Inspect model provider and accounting mode in auth/model config.
2. Query usage events:
   `bun run us events query --type usage.record --limit 200`
3. Separate:
   - input tokens
   - output tokens
   - reasoning tokens
   - cache read/write
   - total tokens
   - cost source/accounting mode
4. For stress tests, report tokens per layer and per useful output, not just totals.

## Rule

Do not rename this to auditing-cost. Token accounting is broader than billable cost.

## Reference Config

Use `references/usage-record.yaml` for the fields a report should preserve.
