---
name: repo-hygiene
description: Check GitHub repository state before commit, push, or pull request creation.
---

# GitHub Repository Hygiene

Use this skill when asked to prepare a branch for commit, push, pull request, or
maintainer review.

## Workflow

1. Inspect `git status`, current branch, upstream, remotes, and changed files.
2. Check for accidental secrets, env files, generated artifacts, lockfile drift,
   and unrelated changes.
3. Compare branch commits against the base branch.
4. Summarize what is ready, what is risky, and what should be excluded.
5. Draft commit or PR text only after understanding the full diff.

## Safety Rules

- Do not include `.env`, credential files, private keys, or machine-local config.
- Do not stage unrelated user changes without explicit instruction.
- Prefer draft PRs until CI and review status are known.
- Use `gh` only after confirming the repository remote targets GitHub.

## Output

Return:

- branch state;
- changed file groups;
- risk flags;
- recommended test command;
- draft commit message or PR body when requested.
