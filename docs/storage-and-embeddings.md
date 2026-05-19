# Storage and Embeddings (Proposal)

> Status: **proposal / direction**, not yet implemented.
> Audience: Union Street labs runtime contributors.
>
> This document captures a direction shift away from Postgres + pgvector toward
> a SQLite-first local memory substrate, and specifies the embedding /
> semantic-search story that goes with it.

## Why Change

Today the runtime asks operators for:

- Bun 1.3+
- Node 20+
- Postgres 16/17 with pgvector
- `uv`
- Honcho-style shared memory infra

Postgres + pgvector + uv is a serious install bar. The local-first agent
tooling cohort that Union Street is positioned alongside (Claude Code, Codex,
OpenCode, Aider, Continue, Pieces, Hermes Agent, etc.) has converged on
**SQLite as the local store**:

- one file on disk, no daemon
- single-writer is a feature, not a bug, for a per-machine runtime
- trivially `cp`-able, `tar`-able, `rm`-able
- inspectable with `sqlite3` from any shell
- no `brew install`, no service to start, no port conflicts

Postgres in a "local-first" pitch is a contradiction. The moment a README
says `brew install postgresql@17 pgvector`, the project stops being local-first
and becomes self-hosted. Different audience, different vibe, much narrower
top-of-funnel for a labs project.

This document proposes:

1. SQLite as the default (and only) bundled store for the labs runtime.
2. `sqlite-vec` + FTS5 + RRF as the semantic-search substrate.
3. A tiered embedding stack with a sub-50MB bundled default and a single
   OpenAI-compatible escape hatch for everything else.
4. Postgres and Honcho remain available as **plugins**, not defaults.

## Storage: SQLite, Per-Profile, One File Per Concern

```
~/.unionstreet/
  profiles/<name>/
    agent.db          SQLite (WAL)  — agent/federation/profile state
    memory.db         SQLite (WAL)  — source chunks + sqlite-vec + FTS5
    events.jsonl      append-only   — events, usage, sessions, scheduler
    .mcp.json         per-agent MCP creds
    skills/           profile-scoped skills
```

Design notes:

- WAL mode on for all SQLite databases.
- `events.jsonl` stays as append-only JSONL (already the format described in
  the README). It is not a database — it is a tail-friendly log.
- One database per concern (agent state vs. memory) so backups, retention
  policies, and corruption blast-radius stay independent.
- The entire profile is a directory. Backups are `tar`. Resets are `rm -rf`.
  Sharing is sending the directory to someone else.

## Vector Storage: `sqlite-vec` + FTS5 + RRF

`sqlite-vec` (Alex Garcia) is the SQLite equivalent of pgvector. Loadable
extension, virtual-table API, ships as a single `.dylib`/`.so`/`.dll`. At
local-agent scale (tens of thousands to low hundreds of thousands of vectors)
it is more than fast enough.

```sql
CREATE VIRTUAL TABLE memory_vec_v1 USING vec0(
  embedding float[384]
);
```

**Hybrid retrieval is mandatory, not optional.** SQLite has FTS5 built in
(BM25 over text). For local-agent corpora — code, identifiers, names, short
session turns — lexical match is doing real work that pure vector search
misses. Use both, fuse with Reciprocal Rank Fusion:

```
query
  │
  ├─▶ FTS5  (BM25 over text)        ─┐
  │                                   ├─▶ RRF ─▶ top-k
  └─▶ vec0  (cosine over embeddings) ─┘
```

FTS5 is free — it is in every SQLite build. There is no reason not to ship
hybrid retrieval as the default.

## Named Memories per Agent

Different content has different chunking and retrieval needs. Don't unify
them into one collection.

| memory      | content                              | chunking            |
| ----------- | ------------------------------------ | ------------------- |
| sessions    | conversation turns / summaries       | per turn / summary  |
| corpus      | files the agent has read             | semantic / AST      |
| skills      | skill markdown                       | per heading         |
| delegations | structured Lash results + summaries  | per result          |

Each named memory is its own pair of tables (source + vec). Retrieval is
always scoped: `recall("how did we configure auth?", in: "skills")`.

## Embedding Stack

The bundled default must work on a fresh machine after `bun install`. No
brew, no Ollama install, no API keys.

### Default: `bge-small-en-v1.5` (int8) via fastembed

- 33M params, 384 dim
- ~35MB on disk after int8 quantization
- pure Bun/Node, ONNX runtime, no native build step
- transformer-quality semantic search out of the box

### Auto-promote: Ollama if detected

On startup, probe `http://localhost:11434/v1/embeddings`. If reachable and
`nomic-embed-text` (or `mxbai-embed-large`) is available, prefer it as the
active embedder for new content. Free upgrade for the large fraction of
target users who already run Ollama. Existing vectors stay untouched (see
Re-embedding section).

### Escape hatch: OpenAI-compatible custom provider

One config shape covers OpenAI, Voyage, Cohere, Mistral, Together, Fireworks,
DeepInfra, Nomic Atlas, Azure OpenAI, Cloudflare Workers AI, Ollama, LM Studio,
vLLM, TGI, llama.cpp server, and basically every embedding endpoint shipped
in the last two years:

```jsonc
// ~/.unionstreet/profiles/<name>/embedders.json
{
  "default": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.voyageai.com/v1",
    "apiKey": "env:VOYAGE_API_KEY",
    "model": "voyage-3",
    "dim": 1024,
    "normalize": true
  }
}
```

### Optional: static embeddings for "fast mode"

`potion-base-8M` (Minish Lab, Model2Vec) is ~30MB, has no transformer
forward pass at inference, and embeds tens of thousands of strings per second
on CPU. Quality is below transformer models but it is excellent as a
first-stage retriever in a hybrid pipeline. Offer as `provider: "model2vec"`,
opt-in.

### Reference table

| Model                          | Params | Size (int8) | Style       | Use case                              |
| ------------------------------ | ------ | ----------- | ----------- | ------------------------------------- |
| `potion-base-2M`               | 2M     | ~8MB        | static      | extreme constraint, first-pass only   |
| `potion-base-8M`               | 8M     | ~30MB       | static      | fast first-stage, pair with reranker  |
| `bge-micro-v2`                 | 17M    | ~17MB       | transformer | smallest model with "real" quality    |
| `snowflake-arctic-embed-xs`    | 23M    | ~25MB       | transformer | beats MiniLM-L6, modern               |
| **`bge-small-en-v1.5`**        | 33M    | ~35MB       | transformer | **bundled default**                   |
| `nomic-embed-text-v1.5`        | 137M   | larger      | transformer | Ollama default, Matryoshka truncation |

## Named Embedders + Per-Purpose Routing

Cheap to support, big payoff for sophisticated users:

```jsonc
{
  "default": { "provider": "fastembed", "model": "bge-small-en-v1.5", "dim": 384 },
  "high":    { "provider": "openai-compatible", "baseUrl": "...", "model": "voyage-3", "dim": 1024 },
  "fast":    { "provider": "model2vec", "model": "potion-base-8M", "dim": 256 },

  "routes": {
    "sessions":    "fast",
    "skills":      "high",
    "corpus":      "high",
    "delegations": "default"
  }
}
```

Most users will never edit `routes`. Defaults work.

## The Re-embedding Story (Non-Negotiable Rules)

Switching embedders later is the part most projects botch. The constraints:

1. **Source text is sacred. Vectors are derived.** The schema must store the
   original text and chunking metadata in normal tables. The vec table is an
   *index*, never the source of truth. If you delete text after embedding,
   you can never re-embed. This is a one-way mistake the runtime must
   prevent.

2. **Tag every vector with embedder identity.** Provider + model + dim +
   normalize flag, captured per vec table. This is what makes "switch
   embedder" detectable instead of silently catastrophic.

3. **Never mix vector spaces in one table.** sqlite-vec tables have a fixed
   dim, and even if dims matched, cosine similarity across two different
   models is meaningless. New embedder = new vec table.

4. **Detect mismatches and refuse loudly.** If config says `voyage-3 / 1024`
   but the active vec table is `bge-small / 384`, the runtime must not
   auto-embed-on-the-fly into the wrong table. It must error:
   *"Embedder changed. Run `us embed reembed`."*

### `us embed reembed --to <embedder>`

```
╭──────────────────────────────╮
│ source_chunks (text+meta)    │  ← unchanged, sacred
╰────────────┬─────────────────╯
             │
   ╭─────────┴──────────╮
   ▼                    ▼
╭──────────────╮   ╭──────────────╮
│ vec_v1       │   │ vec_v2       │
│ bge-small    │   │ voyage-3     │
│ dim 384      │   │ dim 1024     │
│ status: live │   │ status:build │
╰──────────────╯   ╰──────────────╯
                          │
                   build complete
                          │
                          ▼
                   atomic pointer swap:
                   "default" → vec_v2
                   vec_v1 retained
                   for rollback
```

Behaviors:

- **Resumable.** Track `(chunk_id, embedder_id, status)` in a `reembed_jobs`
  table. Restart picks up where it left off.
- **Batched.** Respects provider rate limits. Concurrency configurable.
- **Atomic swap.** No read window where queries hit a half-built index.
- **Old index retained.** `us embed rollback` works for at least N days /
  embeddings before garbage collection.
- **Cost preview.** `us embed reembed --dry-run` shows token count, estimated
  cost (per provider's pricing table), estimated time. People have been
  bitten by surprise embedding bills; do not do that to them.

## Setup UX

`us init` flow asks one question with three doors:

```
How should this profile generate embeddings?

  1. Bundled (works offline, no setup)
        bge-small-en-v1.5 · 384d · ~35MB
  2. Ollama (auto-detected, free, local, faster)
        nomic-embed-text · 768d
  3. Custom (OpenAI-compatible API)
        baseUrl, apiKey, model, dim

  → 1
```

- Default to (1).
- Auto-promote to (2) if Ollama responds on `localhost:11434`.
- (3) is for power users; explain the re-embed implication right there in the
  prompt: *"Switching embedder later requires re-embedding all stored
  content. Run `us embed reembed` after changing."*

## Memory as a Tool, Not Shared State (Honcho Replacement)

Today the README describes Honcho-backed peering for shared context. The
local-first direction makes the same problem go away with a more elegant
answer that aligns with the Lash thesis: **peers don't share storage —
peers share search tools.**

```
╭───────────────╮         ╭───────────────╮
│ agent: coder  │         │ agent: pm     │
│ memory.db     │◀──MCP──▶│ memory.db     │
│ (SQLite+vec)  │  search │ (SQLite+vec)  │
╰───────────────╯         ╰───────────────╯
```

Each agent has its own local SQLite memory. To use another agent's
knowledge, call its `memory.search` MCP tool. No shared database, no
replication, no consistency model. The memory boundary matches the agent
boundary, which matches the MCP credential boundary that already exists.

This is *more* aligned with "delegation as protocol event" than Honcho ever
was. Memory becomes a callable, scoped, auditable surface. Every
cross-agent recall shows up in the trace.

Honcho becomes one optional plugin among many for operators who genuinely
want shared mutable state.

## The Embedder Is Part of the Trace

Every memory write event records which embedder produced the vector. Every
recall event records which index was queried. When someone debugs "why
didn't my agent find this?" three months later, the answer is in the trace,
not in their head. This costs almost nothing to capture from day one and
gives `ustate` real material to surface ("retrievals against stale
embedder", "recall hit rate dropped after embedder switch", etc.).

## Package Shape

```
@unionstreet/memory               SQLite + sqlite-vec + FTS5 + RRF
@unionstreet/embed                provider interface + fastembed default
                                  + Ollama auto-detect
                                  + openai-compatible client

@unionstreet/embed-openai         (plugin, optional)
@unionstreet/embed-voyage         (plugin, optional, sugar over openai-compat)
@unionstreet/embed-model2vec      (plugin, optional, "fast mode")
@unionstreet/memory-honcho        (plugin, optional, shared mutable memory)
@unionstreet/memory-postgres      (plugin, optional, for self-hosted ops)
```

Five small packages. No daemons. No `brew`. Semantic search works on a
fresh machine after `bun install`. Ollama users get a speed boost
automatically. Cloud embeddings are one plugin away. Shared memory is one
plugin away. Postgres is still possible for operators who genuinely want it
— it just isn't the labs default.

## What This Removes from `bun run doctor`

Before:

- Bun, Node, Git, **Postgres 16/17, pgvector, uv**

After:

- Bun, Node, Git

That is the install bar that gets people to actually try the labs runtime.

## Open Questions

- Per-agent embedder overrides? Cheap to support given per-agent MCP creds
  already exist. Probably defer to v2.
- Reranker support? `bge-reranker-base` is small enough to bundle, materially
  improves recall@k. Treat as a separate concern, same plugin contract shape
  as embedders.
- Litestream / LiteFS for SQLite replication if/when an operator wants
  distributed labs runs? Out of scope for v1; the labs default is one
  machine.
- Migration path for any existing Postgres-based profiles? Most likely
  "export script + import script" rather than live migration, given
  pre-alpha status.

## Non-Goals

- Replacing Postgres for operators who genuinely want it. The
  `@unionstreet/memory-postgres` plugin exists for that case.
- Production multi-tenant memory. That belongs downstream (DocIO or another
  consumer of the labs runtime), not in the labs default.
- Beating Postgres + pgvector at scale. The labs runtime is for local agent
  organizations; if you have ten million vectors, you have outgrown the
  labs target.
