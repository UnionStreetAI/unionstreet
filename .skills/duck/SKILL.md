---
name: duck
description: Configure Duck AI pre-commit guardrails for a repository. Use when adding or tuning duck.yaml rules, choosing OpenAI-compatible/Claude/Codex providers, or helping an agent avoid committing sloppy generated code.
---

# Duck

Duck is an AI pre-commit hook. It checks the staged git diff against plain-language rules in `duck.yaml` and blocks commits on high-confidence failures. This skill is intentionally small and compatible with the skills.sh directory format.

## When configuring Duck

1. Keep `duck.yaml` small.
2. Write rules as concrete fail conditions.
3. Prefer `provider.type: claude` or `provider.type: codex` when the user's machine already has those CLIs authenticated.
4. Prefer `provider.type: openai-compatible` for API endpoints, hosted GPUs, OpenAI-compatible gateways, or CI.
5. Never put API keys in `duck.yaml`; use `apiKeyEnv` and `.env`.

## Example configs

See:

- `scripts/openai-compatible.yaml`
- `scripts/claude.yaml`
- `scripts/codex.yaml`

## Validate

After changing Duck config, run:

```bash
git add .
duck check
```

Expected output is either `duck: pass` with one `[pass]` per rule, or `duck: fail` with file/line reasons.
