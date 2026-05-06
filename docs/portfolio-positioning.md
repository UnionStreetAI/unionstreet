# Portfolio Positioning

Union Street should read like a senior-engineering portfolio project: a real, inspectable system that demonstrates product judgment, systems design, TypeScript depth, developer tooling, testing discipline, and AI-infrastructure taste.

## Resume Headline

**Union Street** — local-first multi-agent runtime and control plane for explicit agent organizations, with profile-scoped tools, memory, schedules, delegation, runtime contracts, audit events, OpenAPI, SDK, CLI, and dashboard.

## What It Proves

- **Systems architecture:** separates control plane, runtime contracts, federation, tools, memory, and provider integrations instead of building a single opaque chat wrapper.
- **Product judgment:** focuses on operationally useful agent teams: identity, permissions, delegation, schedules, auditability, and local-first development.
- **Full-stack execution:** ships a Bun/TypeScript monorepo with CLI, server package, typed SDK, React dashboard, docs, Docker assets, and plugin contracts.
- **Testing discipline:** maintains fast/full/live validation batteries, targeted unit tests, CLI smoke tests, dashboard build checks, and adversarial/runtime guardrails.
- **Security instincts:** treats credentials, MCP access, private URLs, bearer auth, path validation, JSON limits, and event redaction as first-class concerns.
- **Developer-experience focus:** exposes `us` commands for setup, auth, profile management, chat, prompt runs, federation, runtime, MCP, events, scheduler, fleet, and plugins.

## Recruiter-Friendly Project Bullets

Use variants of these in resume/LinkedIn/GitHub profile copy:

- Built **Union Street**, a local-first multi-agent runtime/control plane in TypeScript for profile-scoped agents, MCP tools, schedules, memory, delegation, and audit trails.
- Designed a **Bun monorepo** with CLI, runtime server, typed SDK, React dashboard, plugin manifests, OpenAPI export, Docker runtime assets, and Terraform-shaped provider contracts.
- Implemented guardrails for **agent identity, federation, MCP credential scope, private URL rejection, bearer-auth runtime APIs, JSON request limits, and recursive secret redaction**.
- Created a validation battery covering **typechecking, isolated tests, prompt/event/scheduler smoke runs, dashboard build, CLI smoke, and runtime/provider regressions**.
- Modeled explicit agent organizations with **principals, managers, direct reports, runtime targets, tool grants, memory policies, schedules, pulse behavior, and Lash delegation events**.

## GitHub Landing Page Checklist

To make the repository sell Max immediately:

1. **Hero:** one sentence: “A local-first control plane for agent organizations.”
2. **Screenshot/GIF:** dashboard + CLI flow in the first viewport.
3. **Architecture diagram:** control plane → profiles/federation → MCP/tools → runtime providers → events/memory.
4. **Try-it path:** fastest no-credential demo command and expected output.
5. **Proof metrics:** codebase size, package layout, passing `check:fast`, number of tests/features.
6. **Design tradeoffs:** explain why local-first, explicit delegation, profile-scoped tools, and auditable JSONL events matter.
7. **Resume bullets:** include a “For recruiters” or “What this demonstrates” section.
8. **Roadmap:** small credible next steps, not moonshot vapor.

## Suggested Near-Term Portfolio Builds

### 1. Demo Mode With No External Credentials

Goal: anyone can run one command and see value.

```sh
bun run us demo
```

It should create a temporary demo org, start the runtime API, render a CLI transcript, and print the dashboard URL.

### 2. Public Screenshot + GIF Pack

Goal: make the GitHub README visually legible in five seconds.

Capture:

- dashboard command center
- agent fleet graph
- CLI `us federation demo-org --profiles`
- CLI `us runtime status coo`
- event log showing delegation/report flow

### 3. Architecture Page

Goal: show senior-level design ability.

Add one diagram and one narrative: control plane contracts, runtime boundary, security model, plugin model, and testing model.

### 4. Recruiter Case Study

Goal: make Max’s resume stronger outside GitHub.

Create `docs/case-study.md` with:

- problem
- constraints
- architecture
- hard parts
- tradeoffs
- validation
- next steps

### 5. Public CI Badge And Release Hygiene

Goal: make it look alive and professional.

Add GitHub Actions for `bun install --frozen-lockfile && bun run check:fast`, README badge, and tagged pre-alpha releases.

## Current Verified Snapshot

Local inspection on this machine found:

- **537 tracked source/docs/config files** counted by `pygount` excluding dependency/build folders.
- **40,315 code lines** across TypeScript, TSX, JSON, CSS, YAML, Terraform, and HTML.
- **144 TypeScript files** and **22 TSX files**.
- `bun run check:fast` passed locally after installing Bun 1.3.13.

## Positioning Decision

Do **not** frame this as “another agent framework.” Frame it as:

> The missing ops layer for agent teams: identity, delegation, scoped tools, runtime contracts, schedules, memory, events, and auditability.

That tells hiring managers Max can build beyond demos: he can reason about product, architecture, security, tests, and operability.
