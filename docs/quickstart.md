# Quickstart

This is the shortest useful path through Union Street.

## 1. Install

```sh
curl -fsSL https://unionstreet.ai/install.sh | bash
```

During pre-alpha, the GitHub source URL is also useful:

```sh
curl -fsSL https://raw.githubusercontent.com/UnionStreetAI/unionstreet/main/scripts/install.sh | bash
```

Union Street uses Bun. The installer ensures Bun is present and installs the
`us` CLI.

## 2. Check the host

```sh
us doctor
```

`doctor` checks the basics: Bun, Node, Git, Postgres/pgvector, `uv`, and the
local memory substrate. Fix anything red, then run it again.

## 3. Create a starter profile

```sh
us setup coo
```

`setup` creates a ready starter profile and checks plugin/runtime readiness. To
inspect without writing files:

```sh
us setup --check
```

## 4. Open the TUI

```sh
us tui coo
```

You can also run one prompt without the TUI:

```sh
us coo -p "Summarize your current profile and runtime state."
```

## 5. Inspect what exists

```sh
us profile list
us federation status
us federation status coo
us runtime status coo
```

At this point you have one addressable agent with a profile, identity, runtime
shape, memory policy, and CLI entrypoint.

## 6. Add a tiny fleet

For more than one agent, use a reviewable plan:

```sh
us onboard create \
  --name local-product-company \
  --mission "Run a focused agent organization" \
  --department engineering:Engineering \
  --department operations:Operations \
  --out fleet.yaml
```

Validate before applying:

```sh
us fleet validate fleet.yaml
us fleet apply fleet.yaml --replace
```

Then inspect:

```sh
us profile list
us federation status coo
```

## 7. Install the operating skill for agents

If an AI agent is helping you operate the repo, give it the root skill:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-union-street
```

That tells the agent how to set up Union Street, edit fleet plans, validate
changes, scope MCP tools, inspect federation, and leave a reviewable trail.

## Next

- [Agent Organizations](agent-organizations.md)
- [Identity](identity.md)
- [Tools](tools.md)
