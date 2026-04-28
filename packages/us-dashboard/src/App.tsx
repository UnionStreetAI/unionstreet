import {
  Activity,
  BrainCircuit,
  CalendarDays,
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Command,
  Cpu,
  FileCheck2,
  Folder,
  LaptopMinimal,
  MessageSquare,
  Mic,
  Moon,
  Network,
  Orbit,
  Plug,
  PlugZap,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ScrollText,
  Stethoscope,
  Square,
  Sun,
  Terminal,
  Webhook,
  Workflow,
} from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { AgentFleet } from "./components/agent-fleet";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ModelSelector, type DashboardModelGroup, type ModelSelection } from "./components/model-selector";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";

type Theme = "dark" | "light";
type AgentStatus = "live" | "idle" | "blocked";
type ChatTurn =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; agent: string; text: string; streaming: boolean; ts: number }
  | { kind: "system"; id: string; text: string; ts: number }
  | { kind: "tool"; id: string; name: string; args: string; result: string | null; ts: number }
  | { kind: "compaction"; id: string; droppedCount: number; tokensBefore: number; tokensAfter: number; summary: string; ts: number };

export interface Agent {
  id: string;
  title: string;
  manager?: string;
  group: string;
  model: string;
  runtime: string;
  status: AgentStatus;
  activeThread?: string;
}

interface EventRow {
  time: string;
  actor: string;
  event: string;
  detail: string;
}

const agents: Agent[] = [
  { id: "coo", title: "COO", group: "executives", model: "GPT-5.4", runtime: "local/host", status: "live", activeThread: "lash:coo/vp-eng" },
  { id: "vp-ops", title: "VP Operations", manager: "coo", group: "operations", model: "Claude Opus 4.7", runtime: "local/host", status: "idle" },
  { id: "vp-eng", title: "VP Engineering", manager: "coo", group: "engineering", model: "GPT-5.3 Codex", runtime: "local/host", status: "live", activeThread: "lash:vp-eng/dir-eng-infra" },
  { id: "vp-gtm", title: "VP Go-to-Market", manager: "coo", group: "go-to-market", model: "GPT-5.4", runtime: "local/host", status: "idle" },
  { id: "vp-finance", title: "VP Finance", manager: "coo", group: "finance", model: "Claude Sonnet 4.5", runtime: "local/host", status: "idle" },
  { id: "dir-eng-infra", title: "Director Infrastructure", manager: "vp-eng", group: "engineering", model: "GPT-5.3 Codex Spark", runtime: "docker/container", status: "live", activeThread: "lash:dir-eng-infra/mgr-eng-platform" },
  { id: "dir-eng-product", title: "Director Product", manager: "vp-eng", group: "engineering", model: "GPT-5.4 Mini", runtime: "local/host", status: "idle" },
  { id: "mgr-eng-platform", title: "Manager Platform", manager: "dir-eng-infra", group: "engineering", model: "Gemma 4 31B IT", runtime: "daytona/sandbox", status: "blocked" },
];

const events: EventRow[] = [
  { time: "00:42:18", actor: "coo", event: "delegate", detail: "Sent runtime deployment review to vp-eng" },
  { time: "00:42:21", actor: "vp-eng", event: "wake", detail: "Resumed Lash thread lash:vp-eng/dir-eng-infra" },
  { time: "00:42:24", actor: "dir-eng-infra", event: "tool", detail: "mcp/github repos.read allowed by engineering grant" },
  { time: "00:42:31", actor: "mgr-eng-platform", event: "blocked", detail: "Environment provider missing ingress_url output" },
  { time: "00:42:39", actor: "vp-eng", event: "report", detail: "Reported blocker upward to coo" },
];

const grants = [
  { group: "executives", servers: "github, linear, slack", tools: "*", approval: "required" },
  { group: "engineering", servers: "github", tools: "repos.*, pull_requests.*, issues.*", approval: "not required" },
  { group: "operations", servers: "linear, slack", tools: "tickets.*, messages.*", approval: "not required" },
  { group: "finance", servers: "stripe, quickbooks", tools: "*.read, reports.*", approval: "required" },
];

const environments = [
  { provider: "local", compute: "host", storage: "~/.us/workspaces", ingress: "127.0.0.1", state: "ready" },
  { provider: "docker", compute: "container", storage: "volume:/workspace", ingress: "host route", state: "configured" },
  { provider: "kubernetes", compute: "pod", storage: "pvc:/workspace", ingress: "ingress", state: "terraform" },
  { provider: "daytona", compute: "sandbox", storage: "workspace volume", ingress: "https endpoint", state: "terraform" },
];

const plugins = [
  { name: "runtime-local", category: "Environment", status: "installed", scope: "first-party", detail: "host compute, local storage, loopback ingress" },
  { name: "runtime-docker", category: "Environment", status: "available", scope: "first-party", detail: "container compute with volume workspace" },
  { name: "runtime-daytona", category: "Environment", status: "available", scope: "first-party", detail: "cloud sandbox workspace provider" },
  { name: "openrouter", category: "Models", status: "configured", scope: "provider", detail: "OpenAI-compatible model discovery" },
  { name: "github", category: "MCP", status: "granted", scope: "federated", detail: "repos, pull requests, issues" },
  { name: "slack", category: "Channel", status: "granted", scope: "federated", detail: "messages and channel read access" },
  { name: "honcho", category: "Memory", status: "local", scope: "head node", detail: "memory lifecycle and workspace state" },
];

const providers = [
  { name: "Codex / OpenAI", kind: "oauth", status: "connected", models: "GPT-5.4, GPT-5.3 Codex", baseUrl: "chatgpt.com/backend-api" },
  { name: "Anthropic", kind: "oauth", status: "connected", models: "Claude Opus 4.7, Sonnet 4.5", baseUrl: "api.anthropic.com" },
  { name: "OpenRouter", kind: "api key", status: "configured", models: "Qwen, DeepSeek, GLM, GPT", baseUrl: "openrouter.ai/api/v1" },
  { name: "Thurgood Gemma", kind: "api key", status: "configured", models: "Gemma 4 31B IT", baseUrl: "gemma.thurgood.cloud" },
  { name: "OpenCode Zen", kind: "api key", status: "available", models: "Big Pickle, Claude Haiku 4.5", baseUrl: "api.opencode.ai/v1" },
];

const memories = [
  { agent: "coo", store: "honcho", entries: 128, status: "syncing", last: "promoted delegation rubric" },
  { agent: "vp-eng", store: "local", entries: 74, status: "ready", last: "runtime provider requirements" },
  { agent: "dir-eng-infra", store: "local", entries: 41, status: "ready", last: "kubernetes ingress contract" },
  { agent: "mgr-eng-platform", store: "honcho", entries: 19, status: "blocked", last: "missing environment output" },
];

const memoryEntries = [
  {
    id: "mem-coo-delegation-rubric",
    agent: "coo",
    store: "honcho",
    type: "promoted fact",
    scope: "executives",
    confidence: 0.94,
    updated: "2026-04-27 08:42",
    source: "report:runtime-deployment-review",
    tags: ["delegation", "lash", "policy"],
    text: "Delegation should preserve manager/direct-report boundaries. COO can fan work down to VPs and receive reports upward, but lower agents should only see their manager and direct reports.",
  },
  {
    id: "mem-vpeng-runtime-contract",
    agent: "vp-eng",
    store: "local",
    type: "working note",
    scope: "engineering",
    confidence: 0.88,
    updated: "2026-04-27 08:35",
    source: "chat:us-chat-coo-0427",
    tags: ["runtime", "sandbox", "terraform"],
    text: "Every runtime provider needs compute, storage, workspace path, and an ingress URL that can receive HTTP/S requests from the head node.",
  },
  {
    id: "mem-infra-k8s-ingress",
    agent: "dir-eng-infra",
    store: "local",
    type: "constraint",
    scope: "engineering",
    confidence: 0.81,
    updated: "2026-04-27 08:28",
    source: "tool:runtime.status",
    tags: ["kubernetes", "ingress", "provider"],
    text: "Kubernetes runtime contract is present, but implementation should keep ingress provider-neutral and expose a health endpoint for wake/report callbacks.",
  },
  {
    id: "mem-platform-daytona-blocker",
    agent: "mgr-eng-platform",
    store: "honcho",
    type: "blocker",
    scope: "engineering",
    confidence: 0.91,
    updated: "2026-04-27 08:31",
    source: "audit:00:42:31",
    tags: ["daytona", "blocked", "ingress"],
    text: "Daytona provider is blocked until terraform output includes ingress_url and workspace storage metadata.",
  },
  {
    id: "mem-coo-dashboard-priority",
    agent: "coo",
    store: "honcho",
    type: "preference",
    scope: "head-node",
    confidence: 0.76,
    updated: "2026-04-27 08:50",
    source: "chat:dashboard-design",
    tags: ["dashboard", "control-plane", "ui"],
    text: "Dashboard should expose control-plane primitives without turning every internal concept into a top-level sidebar item.",
  },
];

const reports = [
  { title: "Runtime deployment review", agent: "vp-eng", route: "coo <- vp-eng", status: "ready", detail: "Cloud runtime contract is stable; Daytona outputs still pending." },
  { title: "Platform blocker escalation", agent: "dir-eng-infra", route: "coo <- vp-eng <- dir-eng-infra", status: "blocked", detail: "Manager Platform environment provider missing ingress_url." },
  { title: "Ops/SRE service pulse", agent: "vp-ops", route: "coo <- vp-ops", status: "scheduled", detail: "Next scheduled reliability report is queued for Friday." },
  { title: "Finance controls summary", agent: "vp-finance", route: "coo <- vp-finance", status: "draft", detail: "Approval matrix waiting for paid-tool policy notes." },
];

const scheduledSyncs = [
  {
    id: "runtime-readiness",
    day: "Mon",
    time: "09:00",
    duration: "45m",
    title: "Runtime readiness sync",
    topic: "Cloud sandbox provider contract",
    agents: ["coo", "vp-eng", "dir-eng-infra"],
    lash: "coo -> vp-eng -> dir-eng-infra",
    command: 'us vp-eng -p "Sync with infra on runtime readiness and report blockers upward."',
    deliverables: ["provider gap list", "terraform contract notes", "blocking decisions"],
    status: "scheduled",
  },
  {
    id: "gtm-launch",
    day: "Tue",
    time: "11:30",
    duration: "30m",
    title: "GTM launch check",
    topic: "Provider onboarding copy and docs",
    agents: ["vp-gtm", "dir-gtm-marketing", "mgr-gtm-content"],
    lash: "vp-gtm -> dir-gtm-marketing -> mgr-gtm-content",
    command: 'us vp-gtm -p "Run launch readiness sync and return docs deliverables."',
    deliverables: ["launch checklist", "docs delta", "owner handoff"],
    status: "draft",
  },
  {
    id: "finance-controls",
    day: "Wed",
    time: "14:00",
    duration: "60m",
    title: "Finance controls review",
    topic: "Approval boundaries for paid tools",
    agents: ["coo", "vp-finance", "dir-finance-revops"],
    lash: "coo -> vp-finance -> dir-finance-revops",
    command: 'us vp-finance -p "Review paid-tool approvals and summarize required guardrails."',
    deliverables: ["approval matrix", "risk summary", "policy patch"],
    status: "scheduled",
  },
  {
    id: "ops-sre",
    day: "Fri",
    time: "10:00",
    duration: "30m",
    title: "Ops/SRE service pulse",
    topic: "Head node health and wake reliability",
    agents: ["vp-ops", "dir-ops-platform", "mgr-ops-sre"],
    lash: "vp-ops -> dir-ops-platform -> mgr-ops-sre",
    command: 'us vp-ops -p "Sync on head node reliability and escalate any operational risks."',
    deliverables: ["health report", "incident risks", "next mitigation"],
    status: "scheduled",
  },
];

const initialChatTurns: ChatTurn[] = [
  {
    kind: "system",
    id: "sys-chat-session",
    text: "session us-chat-coo-0427 resumed · provider openai/gpt-5.4 · Lash trace ready",
    ts: Date.now() - 180000,
  },
  {
    kind: "user",
    id: "user-runtime-readiness",
    text: "Review current environment readiness and tell me what needs attention before we wire this to live APIs.",
    ts: Date.now() - 170000,
  },
  {
    kind: "assistant",
    id: "assistant-runtime-readiness",
    agent: "coo",
    text: "Environment shape is stable: `head`, `compute`, `storage`, `ingress`, and `workspace` all have a clear contract. The next real edge is replacing dashboard fixtures with `us-runtime` endpoints while preserving Lash trace continuity in browser-originated prompts.",
    streaming: false,
    ts: Date.now() - 160000,
  },
  {
    kind: "tool",
    id: "tool-runtime-status",
    name: "runtime.status",
    args: JSON.stringify({ profile: "coo", includeAgents: true }, null, 2),
    result: "local/host ready\ndocker configured\ndaytona terraform pending\nkubernetes ingress contract present",
    ts: Date.now() - 150000,
  },
  {
    kind: "assistant",
    id: "assistant-runtime-next",
    agent: "coo",
    text: "Recommended next action: add read-only `/api/agents`, `/api/org`, `/api/environments`, and `/api/events`, then make this composer call the same non-interactive prompt route as `us-dev [agent] -p`.",
    streaming: false,
    ts: Date.now() - 140000,
  },
];

const modelGroups: DashboardModelGroup[] = [
  {
    id: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", context: "400k", recent: true },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", context: "400k", recent: true },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", context: "400k" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", context: "400k" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", context: "1M", recent: true },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: "200k" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: "200k" },
    ],
  },
  {
    id: "thurgood-gemma",
    label: "Thurgood Gemma",
    models: [
      { id: "gemma-4-31b-it", name: "Gemma 4 31B IT", context: "128k", recent: true },
    ],
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    models: [
      { id: "big-pickle", name: "Big Pickle", context: "free" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: "200k" },
    ],
  },
];

const navSections = [
  {
    label: "Control",
    items: [
      { label: "Overview", icon: Activity },
      { label: "Chat", icon: MessageSquare },
    ],
  },
  {
    label: "Flow",
    items: [
      { label: "Calendar", icon: CalendarDays },
      { label: "Reports", icon: FileCheck2 },
      { label: "Memory", icon: Database },
    ],
  },
  {
    label: "Org",
    items: [
      { label: "Agents", icon: Network },
      { label: "MCP", icon: McpIcon },
      { label: "Plugins", icon: Plug },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Providers", icon: Orbit },
      { label: "Webhooks", icon: Webhook },
      { label: "Environments", icon: LaptopMinimal },
    ],
  },
];

const utilityNav = [
  { label: "Audit Logs", icon: ScrollText },
  { label: "Doctor", icon: Stethoscope },
];

export function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [activeTab, setActiveTab] = useState("Overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const statusCounts = useMemo(() => ({
    live: agents.filter((agent) => agent.status === "live").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    blocked: agents.filter((agent) => agent.status === "blocked").length,
  }), []);

  return (
    <div className={`dashboard ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} data-theme={theme}>
      <aside className="sidebar">
        <div className="brand">
          <LogoMark />
          <div className="brand-copy">
            <div className="brand-name">Union Street</div>
            <div className="brand-meta">Head node</div>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <nav className="nav">
          {navSections.map((section) => (
            <div className="nav-section" key={section.label}>
              <div className="nav-label">{section.label}</div>
              {section.items.map((item) => (
                <button
                  key={item.label}
                  className={`nav-item ${activeTab === item.label ? "active" : ""}`}
                  onClick={() => setActiveTab(item.label)}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <item.icon size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <nav className="sidebar-utility" aria-label="Utilities">
          {utilityNav.map((item) => (
            <button
              key={item.label}
              className={`nav-item ${activeTab === item.label ? "active" : ""}`}
              onClick={() => setActiveTab(item.label)}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="health-line">
            <span className="pulse" />
            <span>head node live</span>
          </div>
          <div className="mono-muted">127.0.0.1:5174</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="crumbs">
            <span>US</span>
            <ChevronRight size={14} />
            <b>{activeTab}</b>
          </div>
          <div className="search">
            <Search size={14} />
            <span>Search agents, sessions, grants</span>
            <kbd>⌘K</kbd>
          </div>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
        </header>

        <section className="content">
          {activeTab === "Chat" ? (
            <ChatPage />
          ) : activeTab === "Calendar" ? (
            <SchedulePage />
          ) : activeTab === "Reports" ? (
            <ReportsPage />
          ) : activeTab === "Agents" ? (
            <AgentFleet agents={agents} modelGroups={modelGroups} initialView="graph" />
          ) : activeTab === "Providers" ? (
            <ProvidersPage />
          ) : activeTab === "Plugins" ? (
            <PluginsPage />
          ) : activeTab === "Memory" ? (
            <MemoryPage />
          ) : activeTab === "Audit Logs" ? (
            <AuditLogsPage />
          ) : activeTab === "Doctor" ? (
            <DoctorPage />
          ) : (
            <>
          <div className="page-head">
            <div>
              <p className="eyebrow">OIDC-native agent harness</p>
              <h1>Head node management</h1>
              <p className="lede">Local operator view into federation, Lash threads, MCP grants, and environment placement.</p>
            </div>
            <div className="actions">
              <Button variant="secondary"><Terminal size={15} />Open TUI</Button>
              <Button variant="laser"><Command size={15} />New session</Button>
            </div>
          </div>

          <Tabs>
            <TabsList>
              {["Live", "Federation", "Environments"].map((label) => (
                <TabsTrigger key={label} active={label === "Live"}>{label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <section className="kpi-grid">
            <Kpi label="Agents" value={String(agents.length)} delta={`${statusCounts.live} live`} />
            <Kpi label="Lash threads" value="12" delta="5 active" />
            <Kpi label="MCP grants" value={String(grants.length)} delta="2 require approval" />
            <Kpi label="Environments" value={String(environments.length)} delta="local default" />
          </section>

          <section className="dashboard-grid">
            <Card className="span-8">
              <CardHeader>
                <div>
                  <CardTitle>Agent fleet</CardTitle>
                  <CardDescription>Profiles resolved through local federation and runtime config.</CardDescription>
                </div>
                <Badge tone="laser">live</Badge>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Model</TableHead>
                  <TableHead>Environment</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((agent) => (
                      <TableRow key={agent.id}>
                        <TableCell className="name">@{agent.id}</TableCell>
                        <TableCell>{agent.title}</TableCell>
                        <TableCell>{agent.model}</TableCell>
                        <TableCell>{agent.runtime}</TableCell>
                        <TableCell><StatusBadge status={agent.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="span-4">
              <CardHeader>
                <div>
                  <CardTitle>Org graph</CardTitle>
                  <CardDescription>Work flows down. Truth flows up.</CardDescription>
                </div>
                <Network size={16} />
              </CardHeader>
              <CardContent>
                <OrgGraph />
              </CardContent>
            </Card>

            <Card className="span-5">
              <CardHeader>
                <div>
                  <CardTitle>MCP grants</CardTitle>
                  <CardDescription>Visible capability envelopes by group.</CardDescription>
                </div>
                <McpIcon size={16} />
              </CardHeader>
              <CardContent className="grant-list">
                {grants.map((grant) => (
                  <div className="grant-row" key={grant.group}>
                    <div>
                      <div className="row-title">{grant.group}</div>
                      <div className="row-sub">{grant.servers}</div>
                    </div>
                    <div className="row-meta">{grant.tools}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="span-4">
              <CardHeader>
                <div>
                  <CardTitle>Environments</CardTitle>
                  <CardDescription>Compute, storage, ingress contract.</CardDescription>
                </div>
                <LaptopMinimal size={16} />
              </CardHeader>
              <CardContent className="runtime-list">
                {environments.map((runtime) => (
                  <div className="runtime-row" key={runtime.provider}>
                    <LaptopMinimal size={15} />
                    <div>
                      <div className="row-title">{runtime.provider}</div>
                      <div className="row-sub">{runtime.compute} · {runtime.storage}</div>
                    </div>
                    <Badge tone={runtime.state === "ready" ? "success" : "muted"}>{runtime.state}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="span-3">
              <CardHeader>
                <div>
                  <CardTitle>Lash flow</CardTitle>
                  <CardDescription>Delegation and reporting spine.</CardDescription>
                </div>
                <Workflow size={16} />
              </CardHeader>
              <CardContent>
                <div className="flow-card">
                  <div><CircleDot size={14} /> delegate</div>
                  <div className="flow-line" />
                  <div><CircleDot size={14} /> wake</div>
                  <div className="flow-line" />
                  <div><CircleDot size={14} /> report</div>
                </div>
              </CardContent>
            </Card>

            <Card className="span-12">
              <CardHeader>
                <div>
                  <CardTitle>Event stream</CardTitle>
                  <CardDescription>Local SSE-ready feed from the head node.</CardDescription>
                </div>
                <PlugZap size={16} />
              </CardHeader>
              <CardContent>
                <div className="event-feed">
                  {events.map((event) => (
                    <div className="event-row" key={`${event.time}-${event.actor}-${event.event}`}>
                      <span>{event.time}</span>
                      <b>@{event.actor}</b>
                      <Badge tone={event.event === "blocked" ? "warning" : event.event === "delegate" ? "laser" : "default"}>{event.event}</Badge>
                      <p>{event.detail}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </section>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function modelSelectionForAgent(agent: Agent): ModelSelection {
  const wanted = agent.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const group of modelGroups) {
    const model = group.models.find((candidate) => candidate.id === wanted || candidate.name?.toLowerCase() === agent.model.toLowerCase());
    if (model) return { provider: group.id, id: model.id };
  }
  return { provider: "openai", id: "gpt-5.4" };
}

function ChatPage() {
  const [selectedAgentId, setSelectedAgentId] = useState("coo");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0]!;
  const [selectedModel, setSelectedModel] = useState<ModelSelection>(modelSelectionForAgent(selectedAgent));
  const [defaultModel, setDefaultModel] = useState<ModelSelection>(modelSelectionForAgent(selectedAgent));
  const [turns, setTurns] = useState<ChatTurn[]>(initialChatTurns);
  const [composerText, setComposerText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const directReports = agents.filter((agent) => agent.manager === selectedAgent.id).length;
  const workspaceName = selectedAgent.runtime.split("/")[0] ?? "local";

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  function selectAgent(id: string) {
    const next = agents.find((agent) => agent.id === id);
    setSelectedAgentId(id);
    if (next) setSelectedModel(modelSelectionForAgent(next));
  }

  function startNewChat() {
    setTurns([
      {
        kind: "system",
        id: cryptoId("system"),
        text: `new session started · provider ${selectedModel.provider}/${selectedModel.id} · agent @${selectedAgent.id}`,
        ts: Date.now(),
      },
    ]);
    setComposerText("");
    setIsRunning(false);
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || isRunning) return;

    const now = Date.now();
    const assistantId = cryptoId("assistant");
    setComposerText("");
    setIsRunning(true);
    setTurns((prev) => [
      ...prev,
      { kind: "user", id: cryptoId("user"), text, ts: now },
      { kind: "assistant", id: assistantId, agent: selectedAgent.id, text: "", streaming: true, ts: now + 1 },
    ]);

    window.setTimeout(() => {
      setTurns((prev) =>
        prev.map((turn) =>
          turn.kind === "assistant" && turn.id === assistantId
            ? {
                ...turn,
                text: draftLocalAgentReply(text, selectedAgent, directReports, selectedModel),
                streaming: false,
              }
            : turn,
        ),
      );
      setIsRunning(false);
    }, 260);
  }

  return (
    <section className="chat-stage">
      <div className="page-head chat-page-head">
        <div>
          <p className="eyebrow">Agent console</p>
          <h1>Chat</h1>
          <p className="lede">Prompt any agent through the head node with explicit model, access, Lash, and MCP scope.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Settings2 size={15} />Session settings</Button>
          <Button variant="laser" onClick={startNewChat}><MessageSquare size={15} />New chat</Button>
        </div>
      </div>

      <div className="chat-command-grid">
        <main className="chat-workbench">
          <div className="chat-thread">
            {turns.length > 0 ? (
              <ChatTranscript turns={turns} endRef={transcriptEndRef} />
            ) : (
              <div className="thread-empty">
                <MessageSquare size={20} />
                <h2>What should @{selectedAgent.id} work on?</h2>
                <p>{selectedAgent.title} can see {selectedAgent.manager ? `@${selectedAgent.manager}` : "the full org"} and {directReports} direct report{directReports === 1 ? "" : "s"} through Lash.</p>
              </div>
            )}
          </div>

          <form className="chat-shell" onSubmit={submitChat}>
            <div className="chat-composer">
              <textarea
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={`Ask @${selectedAgent.id} anything. @ to mention agents, MCP servers, or files`}
                rows={3}
              />
              <div className="composer-footer">
                <div className="composer-left">
                  <button className="composer-icon" aria-label="Attach context"><Plus size={24} strokeWidth={1.5} /></button>
                  <label className="select-pill access-pill">
                    <ShieldCheck size={16} />
                    <select aria-label="Access level" defaultValue="full">
                      <option value="full">Full access</option>
                      <option value="scoped">Scoped to role</option>
                      <option value="read">Read only</option>
                    </select>
                    <ChevronDown size={15} />
                  </label>
                </div>

                <div className="composer-right">
                  <div className="model-pill">
                    <ModelSelector
                      compact
                      groups={modelGroups}
                      value={selectedModel}
                      defaultValue={defaultModel}
                      onChange={setSelectedModel}
                      onSetDefault={setDefaultModel}
                    />
                  </div>
                  <button className="composer-icon" aria-label="Voice input"><Mic size={20} strokeWidth={1.8} /></button>
                  <button className="send-or-stop" type="submit" aria-label={isRunning ? "Stop generation" : "Send message"}>
                    {isRunning ? <Square size={16} fill="currentColor" /> : <Send size={18} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="chat-context-bar">
              <label className="context-select">
                <BrainCircuit size={16} />
                <select value={selectedAgentId} onChange={(event) => selectAgent(event.target.value)} aria-label="Agent">
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>@{agent.id} · {agent.title}</option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </label>
              <div className="context-chip"><Cpu size={14} />{selectedAgent.runtime}</div>
              <div className="context-chip"><Workflow size={14} />{selectedAgent.manager ? `reports to @${selectedAgent.manager}` : `${directReports} reports`}</div>
              <div className="context-chip"><Folder size={14} />{workspaceName}</div>
            </div>
          </form>
        </main>

        <aside className="chat-control-panel">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Run controls</CardTitle>
                <CardDescription>Execution scope for the next prompt.</CardDescription>
              </div>
              <StatusBadge status={selectedAgent.status} />
            </CardHeader>
            <CardContent className="control-stack">
              <label className="field">
                <span>Agent</span>
                <select value={selectedAgentId} onChange={(event) => selectAgent(event.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>@{agent.id} · {agent.title}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <ModelSelector
                  groups={modelGroups}
                  value={selectedModel}
                  defaultValue={defaultModel}
                  onChange={setSelectedModel}
                  onSetDefault={setDefaultModel}
                />
              </label>
              <label className="field">
                <span>Reasoning</span>
                <select defaultValue="medium">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Federation</CardTitle>
                <CardDescription>What this agent can see and invoke.</CardDescription>
              </div>
              <ShieldCheck size={16} />
            </CardHeader>
            <CardContent className="context-list">
              <div><span>Manager</span><b>{selectedAgent.manager ? `@${selectedAgent.manager}` : "none"}</b></div>
              <div><span>Direct reports</span><b>{directReports}</b></div>
              <div><span>MCP grant</span><b>{selectedAgent.group === "engineering" ? "github" : selectedAgent.group === "executives" ? "github, linear, slack" : "scoped"}</b></div>
              <div><span>Lash thread</span><b>{selectedAgent.activeThread ?? "new on send"}</b></div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </section>
  );
}

function ChatTranscript({ turns, endRef }: { turns: ChatTurn[]; endRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="chat-transcript" aria-live="polite">
      {turns.map((turn) => (
        <ChatTurnView key={turn.id} turn={turn} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ChatTurnView({ turn }: { turn: ChatTurn }) {
  if (turn.kind === "user") {
    return (
      <article className="turn turn-user">
        <span className="turn-gutter">&gt;</span>
        <p>{turn.text}</p>
      </article>
    );
  }

  if (turn.kind === "assistant") {
    return (
      <article className="turn turn-assistant">
        <div className="turn-label">[ {turn.agent.toUpperCase()} ]</div>
        <div className="turn-body markdown-lite">
          {turn.text ? renderMarkdownLite(turn.text) : <p className="streaming-dot">...</p>}
          {turn.streaming && turn.text && <span className="streaming-cursor" />}
        </div>
      </article>
    );
  }

  if (turn.kind === "system") {
    return (
      <article className="turn turn-system">
        <div className="turn-label">[ SYSTEM ]</div>
        <pre>{turn.text}</pre>
      </article>
    );
  }

  if (turn.kind === "tool") {
    return (
      <article className="turn turn-tool">
        <header>
          <span>[ TOOL ]</span>
          <b>{turn.name}</b>
          <em>{turn.result == null ? "running" : "done"}</em>
        </header>
        <div className="tool-grid">
          <div>
            <span>args</span>
            <pre>{oneLine(turn.args)}</pre>
          </div>
          <div>
            <span>result</span>
            {turn.result == null ? <p className="tool-running">running...</p> : <pre>{truncateLines(turn.result, 8)}</pre>}
          </div>
        </div>
      </article>
    );
  }

  const saved = turn.tokensBefore - turn.tokensAfter;
  return (
    <article className="turn turn-compaction">
      <header>
        <span>[ COMPACTED ]</span>
        <b>{turn.droppedCount} msgs</b>
        <em>{kFmt(turn.tokensBefore)} {"->"} {kFmt(turn.tokensAfter)} saved {kFmt(saved)}</em>
      </header>
      <p>{turn.summary}</p>
    </article>
  );
}

function renderMarkdownLite(text: string) {
  return text.split(/\n{2,}/).map((chunk, index) => {
    if (chunk.trim().startsWith("```")) {
      return <pre key={index}>{chunk.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "")}</pre>;
    }
    return <p key={index}>{renderInlineCode(chunk)}</p>;
  });
}

function renderInlineCode(text: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function draftLocalAgentReply(
  prompt: string,
  agent: Agent,
  directReports: number,
  model: ModelSelection,
): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("what is happening") || lower.includes("huh") || lower.includes("dude")) {
    return `You're seeing the dashboard's local chat fallback, not the real model stream yet. Regular messages now stay as normal user -> agent turns; delegation/tool rows should only appear once the runtime stream says a tool was called.\n\nNext step is wiring this composer to the runtime SSE endpoint so @${agent.id} answers through \`${model.provider}/${model.id}\` instead of this local placeholder.`;
  }
  if (lower.length <= 12) {
    return `I'm here as @${agent.id}. This dashboard composer is ready, but the live runtime stream is not wired in yet.`;
  }
  return `@${agent.id} received that message. The dashboard is rendering this as a normal chat turn now; when the runtime endpoint is connected, this response will come from \`${model.provider}/${model.id}\` with the same transcript shape the TUI uses.`;
}

function cryptoId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function oneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function truncateLines(raw: string, max: number): string {
  const lines = raw.split("\n");
  if (lines.length <= max) return raw;
  return `${lines.slice(0, max).join("\n")}\n... ${lines.length - max} more lines`;
}

function kFmt(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function SchedulePage() {
  const [selectedId, setSelectedId] = useState(scheduledSyncs[0]!.id);
  const [calendarView, setCalendarView] = useState<"day" | "week" | "month">("week");
  const selected = scheduledSyncs.find((sync) => sync.id === selectedId) ?? scheduledSyncs[0]!;
  const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
  const monthCells = [
    { day: 26, muted: true }, { day: 27, muted: false }, { day: 28, muted: false }, { day: 29, muted: false }, { day: 30, muted: false }, { day: 1, muted: false }, { day: 2, muted: false },
    { day: 3, muted: false }, { day: 4, muted: false }, { day: 5, muted: false }, { day: 6, muted: false }, { day: 7, muted: false }, { day: 8, muted: false }, { day: 9, muted: false },
    { day: 10, muted: false }, { day: 11, muted: false }, { day: 12, muted: false }, { day: 13, muted: false }, { day: 14, muted: false }, { day: 15, muted: false }, { day: 16, muted: false },
    { day: 17, muted: false }, { day: 18, muted: false }, { day: 19, muted: false }, { day: 20, muted: false }, { day: 21, muted: false }, { day: 22, muted: false }, { day: 23, muted: false },
    { day: 24, muted: false }, { day: 25, muted: false }, { day: 26, muted: false }, { day: 27, muted: false }, { day: 28, muted: false }, { day: 29, muted: false }, { day: 30, muted: false },
  ];
  const scheduledAgents = agents.map((agent) => ({
    agent,
    syncs: scheduledSyncs.filter((sync) => sync.agents.includes(agent.id)),
  }));
  const syncsByDay = (day: string) => scheduledSyncs.filter((sync) => sync.day === day);
  const syncsByMonthDay = (day: number) => scheduledSyncs.filter((sync) => monthDayForSync(sync.day) === day);
  const visibleDays = calendarView === "day" ? [selected.day] : weekDays;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Aggregated agent calendar</p>
          <h1>Calendar</h1>
          <p className="lede">Human time becomes ordered agent wakeups: schedule a topic, launch `us -p`, let Lash fan work down and reports flow back up.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Settings2 size={15} />Calendar settings</Button>
          <Button variant="laser"><CalendarDays size={15} />New sync</Button>
        </div>
      </div>

      <section className="calendar-toolbar">
        <div className="calendar-toolbar-left">
          <Button variant="secondary" size="icon" aria-label="Previous period"><ChevronLeft size={15} /></Button>
          <Button variant="secondary">Today</Button>
          <Button variant="secondary" size="icon" aria-label="Next period"><ChevronRight size={15} /></Button>
          <div>
            <b>Apr 27 - May 3, 2026</b>
            <span>All-agent schedule · America/Los_Angeles</span>
          </div>
        </div>
        <Tabs>
          <TabsList>
            {(["day", "week", "month"] as const).map((view) => (
              <TabsTrigger key={view} active={calendarView === view} onClick={() => setCalendarView(view)}>
                {view}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </section>

      <section className="time-model-band">
        <div>
          <span>Human calendar</span>
          <b>10 hours of meetings</b>
          <p>Useful for planning, ownership, and when humans expect results.</p>
        </div>
        <ChevronRight size={16} />
        <div>
          <span>Agent execution</span>
          <b>task {"->"} work {"->"} report</b>
          <p>Agents do not wait through time; a scheduled sync wakes a chain and records deliverables.</p>
        </div>
        <ChevronRight size={16} />
        <div>
          <span>Pulse interaction</span>
          <b>heartbeat reconciles stale work</b>
          <p>Pulses catch missed reports, stale tasks, and instruction drift between scheduled syncs.</p>
        </div>
      </section>

      <section className="schedule-grid">
        <Card className="schedule-calendar-card">
          <CardHeader>
            <div>
              <CardTitle>{calendarView === "month" ? "All-agent month" : calendarView === "day" ? "Agent day" : "All-agent week"}</CardTitle>
              <CardDescription>Aggregated Google Calendar-style view of planned syncs across the fleet.</CardDescription>
            </div>
            <Badge tone="laser">{scheduledSyncs.length} syncs</Badge>
          </CardHeader>
          <CardContent className="calendar-wrap">
            {calendarView === "month" ? (
              <div className="agent-calendar-month">
                {weekDays.map((day) => <div className="month-day-head" key={day}>{day}</div>)}
                {monthCells.map((cell, index) => {
                  const syncs = cell.muted ? [] : syncsByMonthDay(cell.day);
                  return (
                    <div className={`month-cell ${cell.muted ? "muted" : ""} ${cell.day === 27 ? "today" : ""}`} key={`${cell.day}-${index}`}>
                      <div className="month-cell-date">{cell.day}</div>
                      <div className="month-events">
                        {syncs.map((sync) => (
                          <button
                            key={sync.id}
                            className={`month-event ${sync.id === selected.id ? "active" : ""}`}
                            onClick={() => setSelectedId(sync.id)}
                          >
                            <span>{sync.time}</span>
                            <b>{sync.title}</b>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="agent-calendar" style={{ gridTemplateColumns: `76px repeat(${visibleDays.length}, minmax(${calendarView === "day" ? "420px" : "140px"}, 1fr))` }}>
                <div className="calendar-corner">PST</div>
                {visibleDays.map((day) => (
                  <div className="calendar-day-head" key={day}>
                    <b>{day}</b>
                    <span>{monthLabelForSyncDay(day)}</span>
                  </div>
                ))}
                {hours.map((hour) => (
                  <div className="calendar-row" key={hour} style={{ display: "contents" }}>
                    <div className="calendar-hour">{hour}</div>
                    {visibleDays.map((day) => {
                      const syncs = syncsByDay(day).filter((item) => item.time >= hour && item.time < nextHour(hour));
                      return (
                        <button
                          key={`${day}-${hour}`}
                          className={`calendar-cell ${syncs.length ? "has-sync" : ""} ${syncs.some((sync) => sync.id === selected.id) ? "active" : ""}`}
                          onClick={() => syncs[0] && setSelectedId(syncs[0].id)}
                        >
                          {syncs.map((sync) => (
                            <div className="calendar-event" key={sync.id}>
                              <b>{sync.title}</b>
                              <span>{sync.time} · {sync.duration} · {sync.agents.length} agents</span>
                            </div>
                          ))}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <aside className="schedule-side">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Agent agendas</CardTitle>
                <CardDescription>Every agent’s scheduled sync load.</CardDescription>
              </div>
              <Badge tone="muted">{agents.length} agents</Badge>
            </CardHeader>
            <CardContent className="agent-agenda-list">
              {scheduledAgents.map(({ agent, syncs }) => (
                <button
                  className={`agent-agenda-row ${syncs.some((sync) => sync.id === selected.id) ? "active" : ""}`}
                  key={agent.id}
                  onClick={() => syncs[0] && setSelectedId(syncs[0].id)}
                  disabled={syncs.length === 0}
                >
                  <span>@{agent.id}</span>
                  <b>{syncs.length ? syncs.map((sync) => `${sync.day} ${sync.time}`).join(", ") : "open"}</b>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{selected.title}</CardTitle>
                <CardDescription>{selected.topic}</CardDescription>
              </div>
              <Badge tone={selected.status === "scheduled" ? "success" : "muted"}>{selected.status}</Badge>
            </CardHeader>
            <CardContent className="sync-detail">
              <div className="sync-meta">
                <div><span>When</span><b>{selected.day} {selected.time} · {selected.duration}</b></div>
                <div><span>Lash route</span><b>{selected.lash}</b></div>
                <div><span>Launch</span><code>{selected.command}</code></div>
              </div>
              <div className="sync-section">
                <span>Agents</span>
                <div className="agent-chip-row">
                  {selected.agents.map((agentId) => <Badge key={agentId}>@{agentId}</Badge>)}
                </div>
              </div>
              <div className="sync-section">
                <span>Deliverables</span>
                <ul>
                  {selected.deliverables.map((deliverable) => <li key={deliverable}>{deliverable}</li>)}
                </ul>
              </div>
              <label className="editor-field">
                <span>Instructions</span>
                <textarea defaultValue={`Run this scheduled agent sync.\n\nTopic: ${selected.topic}\nRoute: ${selected.lash}\n\nUse Lash to coordinate down the chain. Return deliverables only when each owner has reported back.`} />
              </label>
            </CardContent>
          </Card>
        </aside>
      </section>
    </>
  );
}

function nextHour(hour: string): string {
  const [raw] = hour.split(":");
  return `${String(Number(raw) + 1).padStart(2, "0")}:00`;
}

function monthDayForSync(day: string): number {
  return ({ Mon: 27, Tue: 28, Wed: 29, Thu: 30, Fri: 1, Sat: 2, Sun: 3 } as Record<string, number>)[day] ?? 27;
}

function monthLabelForSyncDay(day: string): string {
  return ({ Mon: "Apr 27", Tue: "Apr 28", Wed: "Apr 29", Thu: "Apr 30", Fri: "May 1", Sat: "May 2", Sun: "May 3" } as Record<string, string>)[day] ?? "Apr 27";
}

function ReportsPage() {
  const ready = reports.filter((report) => report.status === "ready").length;
  const blocked = reports.filter((report) => report.status === "blocked").length;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Truth flow</p>
          <h1>Reports</h1>
          <p className="lede">Upward summaries, deliverables, escalations, and decision packets returned through Lash.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Search size={15} />Filter</Button>
          <Button variant="laser"><FileCheck2 size={15} />New report</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Reports" value={String(reports.length)} delta="visible to head node" />
        <Kpi label="Ready" value={String(ready)} delta="awaiting review" />
        <Kpi label="Blocked" value={String(blocked)} delta="needs owner" />
        <Kpi label="Routes" value="4" delta="Lash-backed" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Report inbox</CardTitle>
              <CardDescription>Decision-ready output from agents and delegated chains.</CardDescription>
            </div>
            <FileCheck2 size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {reports.map((report) => (
              <div className="plugin-row" key={report.title}>
                <FileCheck2 size={15} />
                <div>
                  <div className="row-title">{report.title}</div>
                  <div className="row-sub">@{report.agent} · {report.route}</div>
                  <div className="row-sub">{report.detail}</div>
                </div>
                <ProviderStatus status={report.status} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Report contract</CardTitle>
              <CardDescription>What every upward report should carry.</CardDescription>
            </div>
            <ShieldCheck size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {[
              ["Route", "source agent, manager path, Lash thread"],
              ["Evidence", "tool calls, files, run ids, citations"],
              ["Decision", "recommendation, alternatives, owner"],
              ["Follow-up", "next delegate/report action"],
            ].map(([title, detail]) => (
              <div className="plugin-row" key={title}>
                <FileCheck2 size={15} />
                <div>
                  <div className="row-title">{title}</div>
                  <div className="row-sub">{detail}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function PluginsPage() {
  const installed = plugins.filter((plugin) => plugin.status === "installed" || plugin.status === "configured" || plugin.status === "granted").length;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Extension surface</p>
          <h1>Plugins</h1>
          <p className="lede">Local view of first-party providers and federated capability plugins exposed to the head node.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Plug size={15} />Install local</Button>
          <Button variant="laser"><Command size={15} />Open marketplace</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Plugins" value={String(plugins.length)} delta={`${installed} active`} />
        <Kpi label="Categories" value="5" delta="environment, mcp, model" />
        <Kpi label="First-party" value="3" delta="runtime providers" />
        <Kpi label="Federated" value="2" delta="grant scoped" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Plugin registry</CardTitle>
              <CardDescription>Installed and available modules for models, environments, memory, channels, and MCP.</CardDescription>
            </div>
            <Plug size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((plugin) => (
                  <TableRow key={plugin.name}>
                    <TableCell className="name">{plugin.name}</TableCell>
                    <TableCell>{plugin.category}</TableCell>
                    <TableCell>{plugin.scope}</TableCell>
                    <TableCell><PluginStatus status={plugin.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Plugin details</CardTitle>
              <CardDescription>Provider contracts exposed to the runtime.</CardDescription>
            </div>
            <PlugZap size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {plugins.slice(0, 5).map((plugin) => (
              <div className="plugin-row" key={plugin.name}>
                <Plug size={15} />
                <div>
                  <div className="row-title">{plugin.name}</div>
                  <div className="row-sub">{plugin.detail}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function ProvidersPage() {
  const connected = providers.filter((provider) => provider.status === "connected" || provider.status === "configured").length;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Model routing</p>
          <h1>Providers</h1>
          <p className="lede">OAuth and OpenAI-compatible providers available to agents through profile auth and model discovery.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Settings2 size={15} />Add API key</Button>
          <Button variant="laser"><Orbit size={15} />Connect OAuth</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Providers" value={String(providers.length)} delta={`${connected} connected`} />
        <Kpi label="OAuth" value="2" delta="codex, anthropic" />
        <Kpi label="API keys" value="3" delta="openai-compatible" />
        <Kpi label="Default" value="coo" delta="GPT-5.4" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Provider registry</CardTitle>
              <CardDescription>Resolved credentials, base URLs, and available model families.</CardDescription>
            </div>
            <Orbit size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Models</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.name}>
                    <TableCell className="name">{provider.name}</TableCell>
                    <TableCell>{provider.kind}</TableCell>
                    <TableCell>{provider.models}</TableCell>
                    <TableCell><ProviderStatus status={provider.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Base URLs</CardTitle>
              <CardDescription>Sanitized endpoints used by model clients.</CardDescription>
            </div>
            <Terminal size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {providers.map((provider) => (
              <div className="plugin-row" key={provider.name}>
                <Orbit size={15} />
                <div>
                  <div className="row-title">{provider.name}</div>
                  <div className="row-sub">{provider.baseUrl}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function MemoryPage() {
  const [memoryView, setMemoryView] = useState<"memories" | "stores" | "promotion" | "internals">("memories");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(memoryEntries[0]!.id);
  const [draftText, setDraftText] = useState(memoryEntries[0]!.text);
  const [editingMemory, setEditingMemory] = useState(false);
  const total = memories.reduce((sum, memory) => sum + memory.entries, 0);
  const filteredEntries = memoryEntries.filter((entry) => {
    const agentMatch = selectedAgent === "all" || entry.agent === selectedAgent;
    const queryText = `${entry.agent} ${entry.type} ${entry.scope} ${entry.source} ${entry.tags.join(" ")} ${entry.text}`.toLowerCase();
    return agentMatch && queryText.includes(query.toLowerCase());
  });
  const selected = filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? memoryEntries[0]!;
  useEffect(() => {
    setDraftText(selected.text);
    setEditingMemory(false);
  }, [selected.id, selected.text]);
  const selectedStore = memories.find((memory) => memory.agent === selected.agent);

  function selectMemory(id: string) {
    const next = memoryEntries.find((entry) => entry.id === id);
    if (!next) return;
    setSelectedId(next.id);
    setDraftText(next.text);
    setEditingMemory(false);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Long-running context</p>
          <h1>Memory</h1>
          <p className="lede">Agent memory stores, promoted facts, sync health, and Honcho/local state visibility.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" onClick={() => setMemoryView("stores")}><Database size={15} />Inspect stores</Button>
          <Button variant="laser"><BrainCircuit size={15} />Promote fact</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Entries" value={String(total)} delta="across visible agents" />
        <Kpi label="Stores" value="2" delta="honcho, local" />
        <Kpi label="Syncing" value="1" delta="coo" />
        <Kpi label="Blocked" value="1" delta="manager platform" />
      </section>

      <Tabs>
        <TabsList>
          {[
            ["memories", "Memories"],
            ["stores", "Stores"],
            ["promotion", "Promotion Queue"],
            ["internals", "Internals"],
          ].map(([id, label]) => (
            <TabsTrigger key={id} active={memoryView === id} onClick={() => setMemoryView(id as typeof memoryView)}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {memoryView === "memories" && (
        <section className="memory-console">
          <Card className="memory-browser">
            <CardHeader>
              <div>
                <CardTitle>Memory browser</CardTitle>
                <CardDescription>Search visible memories, then inspect the selected record.</CardDescription>
              </div>
              <Badge tone="laser">{filteredEntries.length} shown</Badge>
            </CardHeader>
            <CardContent className="memory-browser-body">
              <div className="memory-filters">
                <label className="memory-search">
                  <Search size={14} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory, tags, source..." />
                </label>
                <select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>
                  <option value="all">All agents</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.id}</option>)}
                </select>
              </div>
              <div className="memory-list">
                {filteredEntries.length === 0 ? (
                  <div className="memory-empty">
                    <b>No memories match this filter</b>
                    <span>Try another agent, tag, source, or body search.</span>
                  </div>
                ) : filteredEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`memory-row ${entry.id === selected.id ? "active" : ""}`}
                    onClick={() => selectMemory(entry.id)}
                  >
                    <div className="memory-row-head">
                      <b>@{entry.agent}</b>
                      <span>{entry.type}</span>
                    </div>
                    <p>{entry.text}</p>
                    <div className="memory-tags">
                      {entry.tags.map((tag) => <em key={tag}>{tag}</em>)}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="memory-editor-card">
            <CardHeader>
              <div>
                <CardTitle>{editingMemory ? "Edit memory" : "Memory preview"}</CardTitle>
                <CardDescription>{selected.source} · updated {selected.updated}</CardDescription>
              </div>
              <ProviderStatus status={selectedStore?.status ?? "ready"} />
            </CardHeader>
            <CardContent className="memory-editor">
              {!editingMemory ? (
                <>
                  <div className="memory-preview">
                    <p>{selected.text}</p>
                    <div className="memory-preview-chips">
                      <Badge>@{selected.agent}</Badge>
                      <Badge>{selected.type}</Badge>
                      <Badge>{selected.scope}</Badge>
                      <Badge>{Math.round(selected.confidence * 100)}% confidence</Badge>
                    </div>
                  </div>
                  <details className="memory-disclosure">
                    <summary>Provenance and metadata</summary>
                    <div className="memory-internal-list">
                      <div><span>Store</span><b>{selected.store}</b></div>
                      <div><span>Source</span><b>{selected.source}</b></div>
                      <div><span>Tags</span><b>{selected.tags.join(", ")}</b></div>
                    </div>
                  </details>
                  <div className="memory-editor-actions">
                    <Button variant="secondary"><ScrollText size={15} />View provenance</Button>
                    <Button variant="secondary"><Database size={15} />Archive</Button>
                    <Button variant="laser" onClick={() => setEditingMemory(true)}><BrainCircuit size={15} />Edit</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="memory-meta-grid">
                    <label><span>Agent</span><select defaultValue={selected.agent}>{agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.id}</option>)}</select></label>
                    <label><span>Store</span><select defaultValue={selected.store}><option value="honcho">honcho</option><option value="local">local</option></select></label>
                    <label><span>Type</span><select defaultValue={selected.type}><option>promoted fact</option><option>working note</option><option>constraint</option><option>blocker</option><option>preference</option></select></label>
                    <label><span>Scope</span><input defaultValue={selected.scope} /></label>
                    <label><span>Confidence</span><input defaultValue={`${Math.round(selected.confidence * 100)}%`} /></label>
                    <label><span>Source</span><input defaultValue={selected.source} /></label>
                  </div>
                  <label className="memory-textarea">
                    <span>Memory body</span>
                    <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                  </label>
                  <label className="memory-textarea compact">
                    <span>Tags</span>
                    <input defaultValue={selected.tags.join(", ")} />
                  </label>
                  <div className="memory-editor-actions">
                    <Button variant="secondary" onClick={() => setEditingMemory(false)}>Cancel</Button>
                    <Button variant="secondary"><Database size={15} />Demote</Button>
                    <Button variant="laser" onClick={() => setEditingMemory(false)}><BrainCircuit size={15} />Save memory</Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {memoryView === "stores" && (
        <section className="memory-card-grid">
          {memories.map((memory) => (
            <Card key={memory.agent}>
              <CardHeader>
                <div>
                  <CardTitle>@{memory.agent}</CardTitle>
                  <CardDescription>{memory.store} store · {memory.last}</CardDescription>
                </div>
                <ProviderStatus status={memory.status} />
              </CardHeader>
              <CardContent className="memory-internal-list">
                <div><span>Entries</span><b>{memory.entries}</b></div>
                <div><span>Namespace</span><b>{memory.store}:{memory.agent}</b></div>
                <details className="memory-disclosure">
                  <summary>Store internals</summary>
                  <div className="memory-internal-list">
                    <div><span>Embedding</span><b>semantic index ready</b></div>
                    <div><span>Compaction</span><b>last run 08:41</b></div>
                    <div><span>Path</span><b>profiles/{memory.agent}/memory</b></div>
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {memoryView === "promotion" && (
        <section className="memory-card-grid">
          {memoryEntries.slice(0, 4).map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div>
                  <CardTitle>{entry.type}</CardTitle>
                  <CardDescription>@{entry.agent} · suggested from {entry.source}</CardDescription>
                </div>
                <Badge tone="muted">{Math.round(entry.confidence * 100)}%</Badge>
              </CardHeader>
              <CardContent className="memory-promotion-card">
                <p>{entry.text}</p>
                <details className="memory-disclosure">
                  <summary>Why suggested</summary>
                  <div className="memory-internal-list">
                    <div><span>Signal</span><b>Repeated in reports and tool results</b></div>
                    <div><span>Scope</span><b>{entry.scope}</b></div>
                  </div>
                </details>
                <div className="memory-editor-actions">
                  <Button variant="secondary">Reject</Button>
                  <Button variant="secondary">Edit first</Button>
                  <Button variant="laser">Promote</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {memoryView === "internals" && (
        <section className="memory-card-grid">
          {[
            ["Collections", "agents, reports, tool-results, promoted-facts"],
            ["Embedding Index", "semantic search ready · 5 namespaces"],
            ["Promotion Queue", "7 candidates awaiting review"],
            ["Compaction", "last run 08:41 · 38% context reduction"],
            ["Tombstones", "2 pending purge confirmations"],
          ].map(([title, detail]) => (
            <Card key={title}>
              <CardHeader>
                <div>
                  <CardTitle>{title}</CardTitle>
                  <CardDescription>{detail}</CardDescription>
                </div>
                <BrainCircuit size={16} />
              </CardHeader>
              <CardContent>
                <details className="memory-disclosure">
                  <summary>Inspect details</summary>
                  <div className="memory-internal-list">
                    <div><span>Status</span><b>ready</b></div>
                    <div><span>Owner</span><b>honcho</b></div>
                    <div><span>Writable</span><b>operator approval required</b></div>
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </>
  );
}
function AuditLogsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Append-only control plane trail</p>
          <h1>Audit Logs</h1>
          <p className="lede">Delegations, wakes, reports, tool grants, and runtime changes that need a durable operator record.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Search size={15} />Filter</Button>
          <Button variant="laser"><ScrollText size={15} />Export trail</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Events" value={String(events.length)} delta="visible in this session" />
        <Kpi label="Delegations" value="1" delta="down-chain" />
        <Kpi label="Reports" value="1" delta="up-chain" />
        <Kpi label="Tool calls" value="1" delta="federated grant" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Audit stream</CardTitle>
              <CardDescription>Structured runtime events normalized for compliance and debugging.</CardDescription>
            </div>
            <ScrollText size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={`${event.time}-${event.event}`}>
                    <TableCell className="name">{event.time}</TableCell>
                    <TableCell>@{event.actor}</TableCell>
                    <TableCell>{event.event}</TableCell>
                    <TableCell>{event.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Retention policy</CardTitle>
              <CardDescription>Local defaults before enterprise storage is attached.</CardDescription>
            </div>
            <ShieldCheck size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {[
              ["Local store", "~/.us/audit"],
              ["Tamper mode", "append-only pending signer"],
              ["Export", "jsonl, parquet planned"],
              ["Scope", "head node visible events"],
            ].map(([title, detail]) => (
              <div className="plugin-row" key={title}>
                <ScrollText size={15} />
                <div>
                  <div className="row-title">{title}</div>
                  <div className="row-sub">{detail}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function DoctorPage() {
  const checks = [
    { name: "Head node", status: "ready", detail: "Local runtime process responding" },
    { name: "Lash routes", status: "ready", detail: "Manager/direct-report visibility graph loaded" },
    { name: "Model auth", status: "configured", detail: "OpenAI and Anthropic providers connected" },
    { name: "MCP grants", status: "ready", detail: "Federated grants resolved for visible groups" },
    { name: "Cloud runtimes", status: "blocked", detail: "Daytona terraform output pending" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Runtime health</p>
          <h1>Doctor</h1>
          <p className="lede">Fast preflight view for the head node, model auth, Lash, MCP, storage, and environment providers.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Terminal size={15} />Copy report</Button>
          <Button variant="laser"><Stethoscope size={15} />Run checks</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Checks" value={String(checks.length)} delta="doctor profile" />
        <Kpi label="Ready" value={String(checks.filter((check) => check.status !== "blocked").length)} delta="non-blocking" />
        <Kpi label="Blocked" value={String(checks.filter((check) => check.status === "blocked").length)} delta="needs action" />
        <Kpi label="Last run" value="now" delta="local dashboard" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>System checks</CardTitle>
              <CardDescription>What should be green before handing the fleet real work.</CardDescription>
            </div>
            <Stethoscope size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {checks.map((check) => (
              <div className="plugin-row" key={check.name}>
                <Stethoscope size={15} />
                <div>
                  <div className="row-title">{check.name}</div>
                  <div className="row-sub">{check.detail}</div>
                </div>
                <ProviderStatus status={check.status} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Suggested fix</CardTitle>
              <CardDescription>Highest-signal next repair from the current profile.</CardDescription>
            </div>
            <Terminal size={16} />
          </CardHeader>
          <CardContent className="terminal-card">
            <pre>{`us doctor --profile local
us runtime daytona verify
us audit tail --actor @coo`}</pre>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function ProviderStatus({ status }: { status: string }) {
  const tone =
    status === "connected" || status === "configured" || status === "ready" || status === "syncing"
      ? "success"
      : status === "blocked"
        ? "warning"
        : "muted";
  return <Badge tone={tone}>{status}</Badge>;
}

function PluginStatus({ status }: { status: string }) {
  const tone =
    status === "installed" || status === "configured" || status === "granted"
      ? "success"
      : status === "available"
        ? "muted"
        : "default";
  return <Badge tone={tone}>{status}</Badge>;
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 500 700" fill="none" role="img" aria-label="Union Street">
      <path d="M0 0H100V100H0V0Z" fill="currentColor" />
      <path d="M0 100H100V200H0V100Z" fill="currentColor" />
      <path d="M0 200H100V300H0V200Z" fill="currentColor" />
      <path d="M0 300H100V400H0V300Z" fill="currentColor" />
      <path d="M100 300H200V400H100V300Z" fill="currentColor" />
      <path d="M200 400H300V500H200V400Z" fill="currentColor" />
      <path d="M200 300H300V400H200V300Z" fill="currentColor" />
      <path d="M200 0H300V100H200V0Z" fill="currentColor" />
      <path d="M200 100H300V200H200V100Z" fill="currentColor" />
      <path d="M200 200H300V300H200V200Z" fill="currentColor" />
      <path d="M200 300H300V400H200V300Z" fill="currentColor" />
      <path d="M200 200H300V300H200V200Z" fill="currentColor" />
      <path d="M300 200H400V300H300V200Z" fill="currentColor" />
      <path d="M400 200H500V300H400V200Z" fill="currentColor" />
      <path d="M300 400H400V500H300V400Z" fill="currentColor" />
      <path d="M400 400H500V500H400V400Z" fill="currentColor" />
      <path d="M400 500H500V600H400V500Z" fill="currentColor" />
      <path d="M400 600H500V700H400V600Z" fill="currentColor" />
      <path d="M300 600H400V700H300V600Z" fill="currentColor" />
      <path d="M200 600H300V700H200V600Z" fill="currentColor" />
    </svg>
  );
}

function McpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d="m14.557 7.875l-.055.054l-5.804 5.691a.183.183 0 0 0-.003.259l.003.003l1.192 1.17a.55.55 0 0 1 .011.776l-.01.01a.575.575 0 0 1-.803 0L7.896 14.67a1.28 1.28 0 0 1 0-1.836l5.805-5.692a1.647 1.647 0 0 0 .031-2.328l-.031-.032l-.034-.032a1.725 1.725 0 0 0-2.405-.002l-4.781 4.69h-.002l-.065.065a.575.575 0 0 1-.803 0a.55.55 0 0 1-.01-.776l.01-.01L10.46 3.96c.65-.636.663-1.678.027-2.329l-.029-.03a1.725 1.725 0 0 0-2.407 0L1.635 7.896a.575.575 0 0 1-.802 0a.55.55 0 0 1-.011-.776l.011-.01L7.25.814a2.875 2.875 0 0 1 4.01 0c.63.613.929 1.49.803 2.36c.88-.125 1.77.166 2.406.787l.034.033a2.743 2.743 0 0 1 .053 3.88m-1.691-1.553a.55.55 0 0 0 .01-.776l-.01-.01a.575.575 0 0 0-.803 0L7.317 10.19a1.725 1.725 0 0 1-2.407 0a1.647 1.647 0 0 1-.03-2.33l.031-.031l4.747-4.655a.55.55 0 0 0 .011-.776l-.011-.01a.575.575 0 0 0-.803 0L4.108 7.042a2.743 2.743 0 0 0 0 3.933a2.876 2.876 0 0 0 4.011 0z" clipRule="evenodd" />
    </svg>
  );
}

function Kpi({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-delta">{delta}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const tone = status === "live" ? "success" : status === "blocked" ? "warning" : "muted";
  return <Badge tone={tone}><span className={`status-dot ${status}`} />{status}</Badge>;
}

function OrgGraph() {
  return (
    <div className="org-graph">
      <div className="org-node root">@coo</div>
      <div className="org-branches">
        {["vp-ops", "vp-eng", "vp-gtm", "vp-finance"].map((node) => (
          <div className="org-branch" key={node}>
            <div className="org-line" />
            <div className={node === "vp-eng" ? "org-node active" : "org-node"}>@{node}</div>
            {node === "vp-eng" && (
              <div className="org-children">
                <div className="org-node small">@dir-eng-infra</div>
                <div className="org-node small">@dir-eng-product</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
