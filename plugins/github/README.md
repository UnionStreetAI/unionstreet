# GitHub Plugin

GitHub CLI workflow plugin for Union Street. This test plugin borrows the useful
parts of open-source Claude Code GitHub workflows: command-shaped PR review,
confidence-filtered findings, focused review agents, release note drafting, and
safe local git hygiene.

## Capabilities

- PR review with high-confidence findings only.
- Issue triage with labels, ownership hints, and next actions.
- Release note drafting from merged pull requests and tags.
- Repository hygiene checks before committing or opening a PR.
- GitHub CLI access through `gh` and local `git`.
- No GitHub MCP dependency; this plugin is intentionally CLI-first.
- A custom `github_pr_summary` tool that gathers PR metadata with `gh` and local
  diff context with `git`.

## Requirements

- GitHub CLI (`gh`) for repository-local fallback workflows.
- `GITHUB_TOKEN`, `GH_TOKEN`, or an authenticated `gh` session with the minimum
  scopes needed for the requested workflow.

## Safety Defaults

The skills default to read-only analysis. Write actions such as posting comments,
applying labels, or creating pull requests should be proposed first unless
`allowWriteActions` is explicitly enabled in plugin config.

## Borrowed Shape

This plugin intentionally follows the patterns in Anthropic's open-source Claude
Code plugins:

- `commit-commands`: git status, branch, commit, push, and PR workflow shape.
- `code-review`: PR review with multiple perspectives and confidence filtering.
- `pr-review-toolkit`: focused review specialists for tests, comments, error
  handling, type design, code quality, and simplification.
