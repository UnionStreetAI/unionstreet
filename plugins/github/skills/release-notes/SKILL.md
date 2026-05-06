---
name: release-notes
description: Draft release notes from merged GitHub pull requests, commits, and tags.
---

# GitHub Release Notes

Use this skill when asked to draft release notes, changelogs, or maintainer
summaries from GitHub history.

## Workflow

1. Identify the repository, previous tag, target tag, and branch range.
2. Gather merged PRs, notable commits, authors, labels, linked issues, and
   breaking-change markers through `gh pr list`, `gh release view`, and `git log`.
3. Group changes into user-facing categories: added, changed, fixed, security,
   performance, docs, and internal.
4. Prefer PR titles and descriptions, but rewrite them into clear release prose.
5. Call out migrations, config changes, new environment variables, and known
   risks separately.

## Output

Produce release notes with:

- headline summary;
- grouped changes;
- breaking changes or migrations;
- contributors;
- verification or deployment notes when available.
