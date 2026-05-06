---
name: pr-review
description: Review GitHub pull requests with high-confidence, actionable findings and a concise test-risk summary.
---

# GitHub PR Review

Use this skill when asked to review a GitHub pull request, inspect a branch
before opening a PR, or produce review feedback suitable for a PR comment.

## Workflow

1. Identify the repository and PR or branch.
2. Read PR metadata, changed files, and the diff through `gh` and local `git`.
   Prefer `gh pr view --json ...`, `gh pr diff`, and `git diff`.
3. Check whether review should be skipped: closed PR, draft PR, generated-only
   changes, or a previously posted equivalent review.
4. Review only changed behavior unless the surrounding context is needed to prove
   a finding.
5. Score each possible finding from 0 to 100.
6. Keep only findings at or above the configured threshold, defaulting to 80.
7. Report findings first, then test gaps, then a short summary.

## Review Lenses

- Correctness bugs introduced by the diff.
- Security and secret handling regressions.
- Missing or weak error handling.
- Test gaps for changed behavior.
- Type or schema changes that weaken invariants.
- Documentation or comment drift caused by the change.

## Output

Use file and line references whenever available. Each finding should include:

- severity;
- confidence score;
- affected path and line;
- why it matters;
- smallest reasonable fix.

If no high-confidence findings remain after filtering, say that clearly and
mention residual test or review risk.
