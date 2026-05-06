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
import { CommandCenter } from "./components/command-center";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ModelSelector, type DashboardModel, type DashboardModelGroup, type ModelSelection } from "./components/model-selector";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  loadRuntimeSnapshot,
  loadRuntimeModels,
  createSchedulerJob,
  ensureAgentRuntime,
  runSchedulerTick,
  sendAgentPrompt,
  streamRuntimeEvents,
  type RuntimeAgentSnapshot,
  type RuntimeContract,
  type RuntimeEvent,
  type RuntimeMemoryEvent,
  type RuntimeModelGroup,
  type RuntimeSchedulerJob,
  type RuntimeSchedulerRun,
  type RuntimeSnapshot,
} from "./runtime-client";

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
  modelProvider?: string;
  modelId?: string;
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
  { time: "00:42:24", actor: "dir-eng-infra", event: "tool", detail: "plugin/github-cli used gh pr checks" },
  { time: "00:42:31", actor: "mgr-eng-platform", event: "blocked", detail: "Environment provider missing ingress_url output" },
  { time: "00:42:39", actor: "vp-eng", event: "report", detail: "Reported blocker upward to coo" },
];

const grants = [
  { group: "executives", servers: "linear, slack", tools: "*", approval: "required" },
  { group: "engineering", servers: "linear", tools: "issues.*, projects.*, comments.*", approval: "not required" },
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
  { name: "github", category: "developer", auth: "CLI session/token", status: "available", scope: "agent/department", detail: "GitHub workflows for PRs, issues, releases, checks" },
  { name: "gtm", category: "marketing", auth: "none", status: "available", scope: "agent/department", detail: "Marketing skill graph for positioning, CRO, SEO, analytics, launch, pricing, RevOps, and sales enablement" },
  { name: "linear", category: "productivity", auth: "OAuth", status: "available", scope: "agent/department", detail: "Linear work tracking for issues, projects, and comments" },
  { name: "stripe", category: "finance", auth: "API key", status: "available", scope: "agent/department", detail: "Stripe billing, subscriptions, invoices, customers, and webhook workflows" },
  { name: "vercel", category: "developer", auth: "token/CLI session", status: "available", scope: "agent/department", detail: "Vercel project, env, deployment, and log workflows" },
  { name: "aws", category: "cloud", auth: "CLI session", status: "available", scope: "agent/department", detail: "AWS account-aware cloud operations" },
  { name: "gcp", category: "cloud", auth: "CLI session", status: "available", scope: "agent/department", detail: "Google Cloud project, logs, Cloud Run, builds, and storage workflows" },
  { name: "azure", category: "cloud", auth: "CLI session", status: "available", scope: "agent/department", detail: "Azure subscription and resource workflows" },
  { name: "cloudflare", category: "cloud", auth: "token/CLI session", status: "available", scope: "agent/department", detail: "Cloudflare Workers, Pages, D1, KV, R2, and deployment workflows" },
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
    text: "Environment shape is stable: `head`, `compute`, `storage`, `ingress`, and `workspace` all have a clear contract. The next real edge is replacing dashboard fixtures with `server` endpoints while preserving Lash trace continuity in browser-originated prompts.",
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
      { label: "Command Center", icon: Activity },
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

interface DashboardData {
  snapshot: RuntimeSnapshot;
  agents: Agent[];
  events: EventRow[];
  rawEvents: RuntimeEvent[];
  schedulerJobs: RuntimeSchedulerJob[];
  schedulerRuns: RuntimeSchedulerRun[];
  memoryEntries: MemoryEntry[];
  memoryStores: MemoryStoreRow[];
  reports: ReportRow[];
  environments: EnvironmentRow[];
  providers: ProviderRow[];
  plugins: PluginRow[];
  modelGroups: DashboardModelGroup[];
  statusCounts: { live: number; idle: number; blocked: number };
  reload(): Promise<void>;
}

interface MemoryEntry {
  id: string;
  agent: string;
  store: string;
  type: string;
  scope: string;
  confidence: number;
  updated: string;
  source: string;
  tags: string[];
  text: string;
}

interface MemoryStoreRow {
  agent: string;
  store: string;
  entries: number;
  status: string;
  last: string;
}

interface ReportRow {
  title: string;
  agent: string;
  route: string;
  status: string;
  detail: string;
}

interface EnvironmentRow {
  provider: string;
  compute: string;
  storage: string;
  ingress: string;
  state: string;
}

interface ProviderRow {
  name: string;
  kind: string;
  status: string;
  models: string;
  baseUrl: string;
}

interface PluginRow {
  name: string;
  category: string;
  auth: string;
  status: string;
  scope: string;
  detail: string;
}

function useRuntimeDashboard(): DashboardData {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => ({
    connected: false,
    baseUrl: "http://127.0.0.1:8787",
    agents: [],
    runtimes: [],
    events: [],
    usage: { usage: [], summary: {} },
    scheduler: { jobs: [], runs: [] },
    memory: [],
    models: [],
  }));

  async function reload(signal?: AbortSignal) {
    const next = await loadRuntimeSnapshot(signal);
    if (!signal?.aborted) setSnapshot(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    void streamRuntimeEvents({
      signal: controller.signal,
      onEvent(event) {
        setSnapshot((current) => ({
          ...current,
          connected: true,
          events: mergeEvents(current.events, [event]).slice(0, 250),
        }));
      },
      onError(error) {
        setSnapshot((current) => ({ ...current, error: error.message }));
      },
    }).catch((error) => {
      if (!controller.signal.aborted) setSnapshot((current) => ({ ...current, error: (error as Error).message }));
    });
    return () => controller.abort();
  }, []);

  const agents = useMemo(() => snapshot.agents.map(agentFromRuntime), [snapshot.agents]);
  const rawEvents = snapshot.events;
  const eventRows = useMemo(() => rawEvents.map(eventRowFromRuntime), [rawEvents]);
  const memoryRows = useMemo(() => memoryEntriesFromRuntime(snapshot.memory), [snapshot.memory]);
  const memoryStores = useMemo(() => memoryStoresFromRuntime(snapshot.agents, snapshot.memory), [snapshot.agents, snapshot.memory]);
  const modelGroupsLive = useMemo(() => modelGroupsFromRuntimeModels(snapshot.models), [snapshot.models]);
  const statusCounts = useMemo(() => ({
    live: agents.filter((agent) => agent.status === "live").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    blocked: agents.filter((agent) => agent.status === "blocked").length,
  }), [agents]);

  return {
    snapshot,
    agents,
    events: eventRows,
    rawEvents,
    schedulerJobs: snapshot.scheduler.jobs,
    schedulerRuns: snapshot.scheduler.runs,
    memoryEntries: memoryRows,
    memoryStores,
    reports: reportsFromEvents(rawEvents, agents),
    environments: environmentsFromRuntime(snapshot),
    providers: providersFromRuntime(snapshot.agents, modelGroupsLive),
    plugins: pluginsFromRuntime(snapshot),
    modelGroups: modelGroupsLive.length ? modelGroupsLive : modelGroups,
    statusCounts,
    reload: () => reload(),
  };
}

export function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [activeTab, setActiveTab] = useState("Command Center");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatAgentId, setChatAgentId] = useState<string | undefined>(undefined);
  const data = useRuntimeDashboard();
  const { agents, statusCounts } = data;

  function openChatForAgent(agentId: string) {
    setChatAgentId(agentId);
    setActiveTab("Chat");
  }

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
            <span>{data.snapshot.connected ? "head node live" : "runtime disconnected"}</span>
          </div>
          <div className="mono-muted">{data.snapshot.baseUrl}</div>
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
            <ChatPage agents={agents} modelGroups={data.modelGroups} initialAgentId={chatAgentId} />
          ) : activeTab === "Calendar" ? (
            <SchedulePage agents={agents} jobs={data.schedulerJobs} runs={data.schedulerRuns} reload={data.reload} />
          ) : activeTab === "Reports" ? (
            <ReportsPage reports={data.reports} rawEvents={data.rawEvents} />
          ) : activeTab === "Agents" ? (
            <AgentFleet agents={agents} modelGroups={data.modelGroups} initialView="graph" />
          ) : activeTab === "Providers" ? (
            <ProvidersPage providers={data.providers} />
          ) : activeTab === "MCP" ? (
            <McpPage agents={data.snapshot.agents} plugins={data.plugins} />
          ) : activeTab === "Webhooks" ? (
            <WebhooksPage events={data.rawEvents} />
          ) : activeTab === "Environments" ? (
            <EnvironmentsPage environments={data.environments} runtimes={data.snapshot.runtimes} reload={data.reload} />
          ) : activeTab === "Plugins" ? (
            <PluginsPage plugins={data.plugins} />
          ) : activeTab === "Memory" ? (
            <MemoryPage agents={agents} memories={data.memoryStores} memoryEntries={data.memoryEntries} />
          ) : activeTab === "Audit Logs" ? (
            <AuditLogsPage events={data.events} rawEvents={data.rawEvents} />
          ) : activeTab === "Doctor" ? (
            <DoctorPage snapshot={data.snapshot} agents={agents} events={data.rawEvents} />
          ) : (
            <CommandCenter
              agents={agents}
              modelGroups={data.modelGroups}
              events={data.events}
              rawEvents={data.rawEvents}
              connected={data.snapshot.connected}
              runtimeError={data.snapshot.error}
              runtimeBaseUrl={data.snapshot.baseUrl}
              statusCounts={statusCounts}
              onOpenChat={openChatForAgent}
              onOpenAgents={() => setActiveTab("Agents")}
              onOpenAudit={() => setActiveTab("Audit Logs")}
              onFleetApplied={data.reload}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function modelSelectionForAgent(agent: Agent | undefined, groups: DashboardModelGroup[]): ModelSelection {
  if (!agent) return { provider: "codex", id: "gpt-5.4" };
  if (agent.modelProvider && agent.modelId) return { provider: agent.modelProvider, id: agent.modelId };
  const wanted = agent.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const group of groups) {
    const model = group.models.find((candidate) => candidate.id === wanted || candidate.name?.toLowerCase() === agent.model.toLowerCase());
    if (model) return { provider: group.id, id: model.id };
  }
  return { provider: "openai", id: "gpt-5.4" };
}

function agentFromRuntime(snapshot: RuntimeAgentSnapshot): Agent {
  const provider = snapshot.model?.provider ?? snapshot.pack?.model?.primary?.provider ?? "codex";
  const modelId = snapshot.model?.id ?? snapshot.pack?.model?.primary?.id ?? "gpt-5.4";
  const manager = cleanProfile(snapshot.principal?.manager);
  const groups = snapshot.principal?.groups ?? snapshot.pack?.identity?.groups ?? [];
  const roles = snapshot.principal?.roles ?? snapshot.pack?.identity?.roles ?? [];
  const runtimeName = runtimeLabel(snapshot.runtime);
  return {
    id: snapshot.profile,
    title: snapshot.pack?.identity?.title ?? snapshot.principal?.title ?? snapshot.pack?.identity?.displayName ?? snapshot.profile,
    ...(manager ? { manager } : {}),
    group: groups[0] ?? roles[0] ?? "agents",
    model: normalizedDisplayModel(`${provider}/${modelId}`),
    modelProvider: provider,
    modelId,
    runtime: runtimeName,
    status: snapshot.runtime?.warnings?.length ? "blocked" : snapshot.sessions?.length ? "live" : "idle",
    activeThread: snapshot.pack?.lash?.thread,
  };
}

function eventRowFromRuntime(event: RuntimeEvent): EventRow {
  return {
    time: event.ts ? new Date(event.ts).toLocaleTimeString([], { hour12: false }) : "--:--:--",
    actor: cleanProfile(event.actor) ?? "system",
    event: event.type,
    detail: event.reason ?? event.resource ?? event.trace ?? summarizePayload(event.payload),
  };
}

function memoryEntriesFromRuntime(memory: RuntimeMemoryEvent[]): MemoryEntry[] {
  return memory.map((entry, index) => ({
    id: entry.id ?? `memory-${index}`,
    agent: cleanProfile(entry.peer) ?? "system",
    store: "runtime",
    type: entry.kind ?? "memory",
    scope: entry.trace ?? "agent",
    confidence: 1,
    updated: entry.ts ? new Date(entry.ts).toLocaleString() : "unknown",
    source: entry.source ?? entry.trace ?? "runtime",
    tags: [entry.kind ?? "memory", entry.trace ? "trace" : "local"].filter(Boolean),
    text: entry.text ?? summarizePayload(entry.payload),
  }));
}

function memoryStoresFromRuntime(agents: RuntimeAgentSnapshot[], memory: RuntimeMemoryEvent[]): MemoryStoreRow[] {
  const countByAgent = new Map<string, number>();
  for (const entry of memory) {
    const agent = cleanProfile(entry.peer) ?? "system";
    countByAgent.set(agent, (countByAgent.get(agent) ?? 0) + 1);
  }
  return agents.map((agent) => ({
    agent: agent.profile,
    store: agent.memory?.enabled === false ? "local" : "honcho/local",
    entries: countByAgent.get(agent.profile) ?? 0,
    status: agent.memory?.enabled === false ? "ready" : "syncing",
    last: agent.sessions?.[0]?.id ?? "no sessions",
  }));
}

function modelGroupsFromRuntimeModels(groups: RuntimeModelGroup[]): DashboardModelGroup[] {
  return groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      models: group.models.map((model) => {
        const row = {
          id: model.id,
          name: model.display_name ?? normalizedDisplayModel(model.id),
          recent: group.state === "live",
        } as DashboardModel;
        if (model.context_window) row.context = formatContextWindow(model.context_window);
        return row;
      }),
    }))
    .filter((group) => group.models.length > 0);
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function reportsFromEvents(events: RuntimeEvent[], agents: Agent[]): ReportRow[] {
  const reportEvents = events.filter((event) => event.type.includes("report") || event.type === "scheduler.run.complete" || event.type === "prompt.run.complete");
  return reportEvents.slice(0, 20).map((event) => ({
    title: event.type.replaceAll(".", " "),
    agent: cleanProfile(event.actor) ?? "system",
    route: routeForEvent(event, agents),
    status: event.outcome === "failure" ? "blocked" : event.type === "scheduler.run.complete" ? "scheduled" : "ready",
    detail: event.reason ?? event.resource ?? event.trace ?? summarizePayload(event.payload),
  }));
}

function environmentsFromRuntime(snapshot: RuntimeSnapshot): EnvironmentRow[] {
  return snapshot.runtimes.map((runtime, index) => ({
    provider: String(runtime.workspace?.provider ?? runtime.compute?.provider ?? runtime.profile ?? `runtime-${index}`),
    compute: summarizePayload(runtime.compute),
    storage: summarizePayload(runtime.storage),
    ingress: summarizePayload(runtime.ingress),
    state: runtime.warnings?.length ? "blocked" : "ready",
  }));
}

function providersFromRuntime(agents: RuntimeAgentSnapshot[], modelGroups: DashboardModelGroup[]): ProviderRow[] {
  if (modelGroups.length) {
    return modelGroups.map((group) => ({
      name: normalizedProviderLabel(group.id),
      kind: group.id.includes("oauth") || group.id === "openai-codex" || group.id === "codex" ? "oauth/profile" : "configured",
      status: "connected",
      models: group.models.slice(0, 3).map((model) => normalizedDisplayModel(model.name ?? model.id)).join(", ") || "none",
      baseUrl: group.label,
    }));
  }
  const modelsByProvider = new Map<string, Set<string>>();
  for (const agent of agents) {
    const provider = agent.model?.provider ?? agent.pack?.model?.primary?.provider ?? "codex";
    const id = agent.model?.id ?? agent.pack?.model?.primary?.id ?? "gpt-5.4";
    const set = modelsByProvider.get(provider) ?? new Set<string>();
    set.add(id);
    modelsByProvider.set(provider, set);
  }
  return [...modelsByProvider.entries()].map(([provider, models]) => ({
    name: normalizedProviderLabel(provider),
    kind: provider.includes("oauth") || provider === "codex" ? "oauth/profile" : "configured",
    status: "configured",
    models: [...models].map(normalizedDisplayModel).join(", "),
    baseUrl: provider,
  }));
}

function pluginsFromRuntime(snapshot: RuntimeSnapshot): PluginRow[] {
  const rows = new Map<string, PluginRow>(plugins.map((plugin) => [plugin.name, plugin]));
  for (const agent of snapshot.agents) {
    for (const server of agent.mcp?.servers ?? []) {
      const grant = agent.mcp?.grants?.[server.name];
      const existing = rows.get(server.name);
      rows.set(server.name, {
        name: server.name,
        category: existing?.category ?? "MCP",
        auth: existing?.auth ?? "OAuth",
        status: grant?.allowed ? "granted" : server.credential?.configured ? "configured" : existing?.status ?? "available",
        scope: `@${agent.profile}`,
        detail: existing
          ? `${existing.detail}; configured as ${server.url ?? server.command ?? server.transport ?? "server"}`
          : server.url ?? server.command ?? server.transport ?? "configured server",
      });
    }
  }
  return [...rows.values()];
}

function scheduledSyncsFromJobs(jobs: RuntimeSchedulerJob[]) {
  return jobs.map((job) => {
    const parsed = parseCronish(job.cron ?? job.cadence);
    const route = job.route?.length ? job.route : [job.profile];
    return {
      id: job.id,
      day: parsed.day,
      time: parsed.time,
      duration: job.kind === "pulse" ? "heartbeat" : "30m",
      title: job.name ?? `${job.kind} ${job.profile}`,
      topic: job.prompt?.split("\n")[0] ?? `${job.kind} wakeup`,
      agents: route,
      lash: `scheduler -> ${route.map((agent) => `@${agent}`).join(" -> ")}`,
      command: `us ${job.profile} -p ${JSON.stringify(job.prompt ?? "Run scheduled job.")}`,
      deliverables: job.deliverables?.length ? job.deliverables : [job.kind === "pulse" ? "heartbeat report" : "scheduled deliverable"],
      status: job.enabled === false ? "draft" : "scheduled",
      prompt: job.prompt ?? "",
    };
  });
}

function mergeEvents(current: RuntimeEvent[], incoming: RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set<string>();
  return [...incoming, ...current].filter((event) => {
    const key = event.id ?? `${event.ts}:${event.type}:${event.actor}:${event.resource}:${event.trace}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

function routeForEvent(event: RuntimeEvent, agents: Agent[]): string {
  const actor = cleanProfile(event.actor) ?? "system";
  const target = cleanProfile(event.target);
  if (target) return `${target} <- ${actor}`;
  const manager = agents.find((agent) => agent.id === actor)?.manager;
  return manager ? `${manager} <- ${actor}` : actor;
}

function runtimeLabel(runtime: RuntimeContract | undefined): string {
  if (!runtime) return "unknown";
  const provider = runtime.workspace?.provider ?? runtime.compute?.provider ?? "local";
  const compute = runtime.compute?.target ?? runtime.compute?.provider ?? "host";
  return `${provider}/${compute}`;
}

function parseCronish(cron: string | undefined): { day: string; time: string } {
  const parts = cron?.split(/\s+/) ?? [];
  const minute = Number(parts[0] ?? 0);
  const hour = Number(parts[1] ?? 9);
  const day = String(parts[4] ?? "*").toUpperCase();
  return {
    day: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].includes(day) ? titleDay(day) : "Mon",
    time: `${String(Number.isFinite(hour) ? hour : 9).padStart(2, "0")}:${String(Number.isFinite(minute) ? minute : 0).padStart(2, "0")}`,
  };
}

function titleDay(day: string): string {
  return day.slice(0, 1) + day.slice(1).toLowerCase();
}

function cleanProfile(value: string | undefined): string | undefined {
  return value?.replace(/^agent:/, "").replace(/^@/, "");
}

function normalizedProviderLabel(provider: string): string {
  if (provider === "codex") return "OpenAI";
  return provider.split(/[-_:/.]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function normalizedDisplayModel(value: string): string {
  const slug = value.split("/").pop() ?? value;
  return slug.split(/[-_]+/).filter(Boolean).map((part) => /^[0-9.]+$/.test(part) ? part : part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function summarizePayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  try {
    return JSON.stringify(payload);
  } catch {
    return "[unserializable]";
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ChatPage({ agents, modelGroups, initialAgentId }: { agents: Agent[]; modelGroups: DashboardModelGroup[]; initialAgentId?: string }) {
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId ?? "coo");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const [agentModelGroups, setAgentModelGroups] = useState<DashboardModelGroup[]>(modelGroups);
  const activeModelGroups = agentModelGroups.length ? agentModelGroups : modelGroups;
  const initialModel = modelSelectionForAgent(selectedAgent, activeModelGroups);
  const [selectedModel, setSelectedModel] = useState<ModelSelection>(initialModel);
  const [defaultModel, setDefaultModel] = useState<ModelSelection>(initialModel);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [composerText, setComposerText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedAgentKey = useRef<string | undefined>(undefined);
  const directReports = selectedAgent ? agents.filter((agent) => agent.manager === selectedAgent.id).length : 0;
  const workspaceName = selectedAgent?.runtime.split("/")[0] ?? "local";

  useEffect(() => {
    if (initialAgentId && agents.some((agent) => agent.id === initialAgentId)) {
      setSelectedAgentId(initialAgentId);
    }
  }, [agents, initialAgentId]);

  useEffect(() => {
    if (!selectedAgent) return;
    const controller = new AbortController();
    setAgentModelGroups(modelGroups);
    loadRuntimeModels(selectedAgent.id, controller.signal)
      .then((groups) => {
        if (!controller.signal.aborted) {
          const discovered = modelGroupsFromRuntimeModels(groups);
          setAgentModelGroups(discovered.length ? discovered : modelGroups);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setAgentModelGroups(modelGroups);
      });
    return () => controller.abort();
  }, [modelGroups, selectedAgent]);

  useEffect(() => {
    if (!selectedAgent) return;
    if (selectedAgentId !== selectedAgent.id) setSelectedAgentId(selectedAgent.id);
    const agentModelKey = `${selectedAgent.id}:${selectedAgent.modelProvider ?? ""}/${selectedAgent.modelId ?? selectedAgent.model}`;
    if (lastSyncedAgentKey.current !== agentModelKey) {
      const nextModel = modelSelectionForAgent(selectedAgent, activeModelGroups);
      lastSyncedAgentKey.current = agentModelKey;
      setSelectedModel(nextModel);
      setDefaultModel(nextModel);
    }
  }, [activeModelGroups, selectedAgent, selectedAgentId]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  function selectAgent(id: string) {
    const next = agents.find((agent) => agent.id === id);
    setSelectedAgentId(id);
    if (next) {
      const nextModel = modelSelectionForAgent(next, activeModelGroups);
      lastSyncedAgentKey.current = `${next.id}:${next.modelProvider ?? ""}/${next.modelId ?? next.model}`;
      setSelectedModel(nextModel);
      setDefaultModel(nextModel);
    }
  }

  function startNewChat() {
    setTurns([
      {
        kind: "system",
        id: cryptoId("system"),
        text: `new session started · provider ${selectedModel.provider}/${selectedModel.id} · agent @${selectedAgent?.id ?? "none"}`,
        ts: Date.now(),
      },
    ]);
    setComposerText("");
    setIsRunning(false);
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || isRunning || !selectedAgent) return;

    const now = Date.now();
    const assistantId = cryptoId("assistant");
    const profile = selectedAgent.id;
    setComposerText("");
    setIsRunning(true);
    setTurns((prev) => [
      ...prev,
      { kind: "user", id: cryptoId("user"), text, ts: now },
      { kind: "assistant", id: assistantId, agent: profile, text: "", streaming: true, ts: now + 1 },
    ]);

    sendAgentPrompt(profile, { prompt: text, model: selectedModel }).then((result) => {
      const toolTurns: ChatTurn[] = (result.toolCalls ?? []).map((call, index) => ({
        kind: "tool",
        id: cryptoId(`tool-${index}`),
        name: call.name ?? "tool",
        args: JSON.stringify(call.args ?? {}, null, 2),
        result: call.result == null ? null : typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2),
        ts: Date.now(),
      }));
      setTurns((prev) =>
        prev.flatMap((turn) =>
          turn.kind === "assistant" && turn.id === assistantId
            ? {
                ...turn,
                text: result.text ?? "",
                streaming: false,
              }
            : turn,
        ).concat(toolTurns),
      );
      setIsRunning(false);
    }).catch((error) => {
      setTurns((prev) =>
        prev.map((turn) =>
          turn.kind === "assistant" && turn.id === assistantId
            ? { ...turn, text: `Runtime error: ${(error as Error).message}`, streaming: false }
            : turn,
        ),
      );
      setIsRunning(false);
    });
  }

  if (!selectedAgent) {
    return (
      <section className="chat-stage">
        <div className="thread-empty">
          <MessageSquare size={20} />
          <h2>No live agents</h2>
          <p>Start `us runtime serve` and refresh the dashboard connection.</p>
        </div>
      </section>
    );
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
                      groups={activeModelGroups}
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
                  groups={activeModelGroups}
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
              <div><span>Plugins</span><b>{selectedAgent.group === "engineering" ? "github, linear" : selectedAgent.group === "executives" ? "linear, slack" : "scoped"}</b></div>
              <div><span>MCP grant</span><b>{selectedAgent.group === "engineering" ? "linear" : selectedAgent.group === "executives" ? "linear, slack" : "scoped"}</b></div>
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

function SchedulePage({ agents, jobs, runs, reload }: { agents: Agent[]; jobs: RuntimeSchedulerJob[]; runs: RuntimeSchedulerRun[]; reload(): Promise<void> }) {
  const scheduledSyncs = useMemo(() => scheduledSyncsFromJobs(jobs), [jobs]);
  const [selectedId, setSelectedId] = useState(scheduledSyncs[0]?.id ?? "");
  const [calendarView, setCalendarView] = useState<"day" | "week" | "month">("week");
  const [eventName, setEventName] = useState("Cross-functional delivery review");
  const [eventDay, setEventDay] = useState("MON");
  const [eventTime, setEventTime] = useState("09:00");
  const [eventTimezone, setEventTimezone] = useState("America/Los_Angeles");
  const [eventRoute, setEventRoute] = useState<string[]>(() => agents.slice(0, 3).map((agent) => agent.id));
  const [eventPrompt, setEventPrompt] = useState("Review current work, delegate the next concrete action, and report decision-ready status upward through Lash.");
  const [eventDeliverables, setEventDeliverables] = useState("status summary\nmaterial blockers\nnext owner and deadline");
  const [eventError, setEventError] = useState<string | null>(null);
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const selected = scheduledSyncs.find((sync) => sync.id === selectedId) ?? scheduledSyncs[0];
  const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const cronDays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
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
  const visibleDays = calendarView === "day" && selected ? [selected.day] : weekDays;

  useEffect(() => {
    if (!selectedId && scheduledSyncs[0]) setSelectedId(scheduledSyncs[0].id);
  }, [scheduledSyncs, selectedId]);

  useEffect(() => {
    setEventRoute((current) => current.filter((agentId) => agents.some((agent) => agent.id === agentId)).length
      ? current.filter((agentId) => agents.some((agent) => agent.id === agentId))
      : agents.slice(0, 1).map((agent) => agent.id));
  }, [agents]);

  async function runDueNow() {
    await runSchedulerTick({ execute: true });
    await reload();
  }

  function updateRouteAgent(index: number, agentId: string) {
    setEventRoute((current) => current.map((value, routeIndex) => routeIndex === index ? agentId : value));
  }

  function addRouteStep() {
    if (eventRoute.length >= 12) return;
    const fallback = agents.find((agent) => !eventRoute.includes(agent.id))?.id ?? agents[0]?.id;
    if (fallback) setEventRoute((current) => [...current, fallback]);
  }

  function removeRouteStep(index: number) {
    setEventRoute((current) => current.filter((_, routeIndex) => routeIndex !== index));
  }

  async function createCalendarEvent() {
    setEventError(null);
    const route = eventRoute.filter(Boolean);
    if (!route.length) {
      setEventError("Choose at least one agent for the route.");
      return;
    }
    if (new Set(route).size !== route.length) {
      setEventError("Each agent can appear only once in a scheduled route.");
      return;
    }
    if (!eventPrompt.trim()) {
      setEventError("Add the prompt this scheduled route should execute.");
      return;
    }
    setIsCreatingEvent(true);
    try {
      const owner = route[0]!;
      const [hour, minute] = eventTime.split(":").map(Number);
      const cron = `${minute} ${hour} * * ${eventDay}`;
      await createSchedulerJob({
        owner,
        name: eventName,
        cron,
        timezone: eventTimezone,
        prompt: eventPrompt,
        deliverables: eventDeliverables.split("\n").map((item) => item.trim()).filter(Boolean),
        route,
      });
      await reload();
    } catch (error) {
      setEventError((error as Error).message);
    } finally {
      setIsCreatingEvent(false);
    }
  }

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
          <Button variant="secondary" onClick={() => document.getElementById("schedule-event-builder")?.scrollIntoView({ behavior: "smooth", block: "start" })}><Plus size={15} />Create event</Button>
          <Button variant="laser" onClick={() => void runDueNow()}><CalendarDays size={15} />Run due now</Button>
        </div>
      </div>

      <Card className="orchestration-builder" id="schedule-event-builder">
        <CardHeader>
          <div>
            <CardTitle>Create scheduled orchestration</CardTitle>
            <CardDescription>Pick a prompt and an explicit ordered route. The first agent owns the calendar event; each next agent receives the previous step as upstream context.</CardDescription>
          </div>
          <Badge tone="laser">{eventRoute.length || 0} step{eventRoute.length === 1 ? "" : "s"}</Badge>
        </CardHeader>
        <CardContent>
          <div className="orchestration-form-grid">
            <label className="editor-field">
              <span>Event name</span>
              <input value={eventName} onChange={(event) => setEventName(event.target.value)} />
            </label>
            <label className="editor-field">
              <span>Day</span>
              <select value={eventDay} onChange={(event) => setEventDay(event.target.value)}>
                {cronDays.map((day) => <option key={day} value={day}>{day}</option>)}
              </select>
            </label>
            <label className="editor-field">
              <span>Time</span>
              <input type="time" value={eventTime} onChange={(event) => setEventTime(event.target.value)} />
            </label>
            <label className="editor-field">
              <span>Timezone</span>
              <input value={eventTimezone} onChange={(event) => setEventTimezone(event.target.value)} />
            </label>
          </div>

          <div className="route-builder">
            <div className="route-builder-head">
              <div>
                <b>Invocation route</b>
                <span>{eventRoute.map((agentId) => `@${agentId}`).join(" -> ") || "No route selected"}</span>
              </div>
              <Button variant="secondary" onClick={addRouteStep} disabled={!agents.length || eventRoute.length >= 12}><Plus size={14} />Add step</Button>
            </div>
            <div className="route-step-list">
              {eventRoute.map((agentId, index) => (
                <div className="route-step-row" key={`${index}-${agentId}`}>
                  <span>{index + 1}</span>
                  <select value={agentId} onChange={(event) => updateRouteAgent(index, event.target.value)} aria-label={`Route step ${index + 1}`}>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>@{agent.id} · {agent.title}</option>
                    ))}
                  </select>
                  <Button variant="secondary" size="icon" aria-label="Remove route step" onClick={() => removeRouteStep(index)} disabled={eventRoute.length <= 1}>
                    <Square size={12} />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="orchestration-form-grid wide">
            <label className="editor-field">
              <span>Prompt</span>
              <textarea value={eventPrompt} onChange={(event) => setEventPrompt(event.target.value)} />
            </label>
            <label className="editor-field">
              <span>Deliverables</span>
              <textarea value={eventDeliverables} onChange={(event) => setEventDeliverables(event.target.value)} />
            </label>
          </div>

          {eventError && <div className="form-error">{eventError}</div>}
          <div className="orchestration-actions">
            <code>{eventRoute[0] ? `owner=@${eventRoute[0]} · cron=${eventTime.split(":")[1]} ${eventTime.split(":")[0]} * * ${eventDay}` : "choose a route"}</code>
            <Button variant="laser" onClick={() => void createCalendarEvent()} disabled={isCreatingEvent || !agents.length}>
              <CalendarDays size={15} />{isCreatingEvent ? "Creating..." : "Create event"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="calendar-toolbar">
        <div className="calendar-toolbar-left">
          <Button variant="secondary" size="icon" aria-label="Previous period"><ChevronLeft size={15} /></Button>
          <Button variant="secondary">Today</Button>
          <Button variant="secondary" size="icon" aria-label="Next period"><ChevronRight size={15} /></Button>
          <div>
            <b>Live scheduler</b>
            <span>{jobs.length} jobs · {runs.length} recorded runs</span>
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
                            className={`month-event ${sync.id === selected?.id ? "active" : ""}`}
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
                          className={`calendar-cell ${syncs.length ? "has-sync" : ""} ${syncs.some((sync) => sync.id === selected?.id) ? "active" : ""}`}
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
                  className={`agent-agenda-row ${syncs.some((sync) => sync.id === selected?.id) ? "active" : ""}`}
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
                <CardTitle>{selected?.title ?? "No scheduled jobs"}</CardTitle>
                <CardDescription>{selected?.topic ?? "The runtime has not exposed pulse or schedule jobs yet."}</CardDescription>
              </div>
              {selected && <Badge tone={selected.status === "scheduled" ? "success" : "muted"}>{selected.status}</Badge>}
            </CardHeader>
            <CardContent className="sync-detail">
              {selected ? (
                <>
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
                    <textarea value={`Run this scheduled agent sync.\n\nTopic: ${selected.topic}\nRoute: ${selected.lash}\n\n${selected.prompt}`} readOnly />
                  </label>
                </>
              ) : (
                <div className="thread-empty"><CalendarDays size={20} /><p>No scheduler jobs are visible from the runtime.</p></div>
              )}
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

function ReportsPage({ reports, rawEvents }: { reports: ReportRow[]; rawEvents: RuntimeEvent[] }) {
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
        <Kpi label="Routes" value={String(new Set(rawEvents.map((event) => event.threadId).filter(Boolean)).size)} delta="Lash-backed" />
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

function PluginsPage({ plugins }: { plugins: PluginRow[] }) {
  const installed = plugins.filter((plugin) => plugin.status === "installed" || plugin.status === "configured" || plugin.status === "granted").length;
  const authless = plugins.filter((plugin) => plugin.auth === "none").length;
  const needsAuth = plugins.length - authless;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Extension surface</p>
          <h1>Plugins</h1>
          <p className="lede">Installable agent capabilities. Auth varies by plugin; runtime providers live under Infrastructure.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Plug size={15} />Install local</Button>
          <Button variant="laser"><PlugZap size={15} />Open marketplace</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Plugins" value={String(plugins.length)} delta={`${installed} active`} />
        <Kpi label="Needs auth" value={String(needsAuth)} delta="OAuth, token, key, or CLI" />
        <Kpi label="No auth" value={String(authless)} delta="skills-only bundles" />
        <Kpi label="Runtime providers" value="0" delta="shown under Infra" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Plugin registry</CardTitle>
              <CardDescription>Installed and available capability modules for agent behavior and app integration.</CardDescription>
            </div>
            <Plug size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((plugin) => (
                  <TableRow key={plugin.name}>
                    <TableCell className="name">{plugin.name}</TableCell>
                    <TableCell>{plugin.auth}</TableCell>
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
              <CardDescription>How each capability is exposed to agents.</CardDescription>
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

function ProvidersPage({ providers }: { providers: ProviderRow[] }) {
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

function McpPage({ agents, plugins }: { agents: RuntimeAgentSnapshot[]; plugins: PluginRow[] }) {
  const serverRows = agents.flatMap((agent) =>
    (agent.mcp?.servers ?? []).map((server) => ({
      agent: agent.profile,
      server,
      grant: agent.mcp?.grants?.[server.name],
    })),
  );
  const granted = serverRows.filter((row) => row.grant?.allowed).length;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Agent tool fabric</p>
          <h1>MCP</h1>
          <p className="lede">Live MCP servers, grants, credentials, and tool exposure by agent. Auth remains agent-scoped.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><McpIcon size={15} />Auth agent</Button>
          <Button variant="laser"><ShieldCheck size={15} />Validate grants</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Servers" value={String(new Set(serverRows.map((row) => row.server.name)).size)} delta="from .mcp config" />
        <Kpi label="Agent grants" value={String(granted)} delta="allowed envelopes" />
        <Kpi label="Credentials" value={String(serverRows.filter((row) => row.server.credential?.configured).length)} delta="agent scoped" />
        <Kpi label="Builtin tools" value={String(agents.reduce((sum, agent) => sum + (agent.mcp?.builtinTools?.length ?? 0), 0))} delta="local toolkit" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>MCP matrix</CardTitle>
              <CardDescription>Every row is resolved from runtime agent snapshots and federation grants.</CardDescription>
            </div>
            <McpIcon size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Credential</TableHead>
                  <TableHead>Grant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serverRows.map((row) => (
                  <TableRow key={`${row.agent}-${row.server.name}`}>
                    <TableCell className="name">@{row.agent}</TableCell>
                    <TableCell>{row.server.name}</TableCell>
                    <TableCell>{row.server.credential?.configured ? `${row.server.credential.source ?? "profile"}/${row.server.credential.kind ?? "credential"}` : "missing"}</TableCell>
                    <TableCell><ProviderStatus status={row.grant?.allowed ? "ready" : "blocked"} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Exposed tools</CardTitle>
              <CardDescription>Grant-filtered tool envelopes.</CardDescription>
            </div>
            <PlugZap size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {serverRows.slice(0, 12).map((row) => (
              <div className="plugin-row" key={`${row.agent}-${row.server.name}-tools`}>
                <McpIcon size={15} />
                <div>
                  <div className="row-title">@{row.agent} / {row.server.name}</div>
                  <div className="row-sub">{row.grant?.tools?.join(", ") || row.grant?.reason || "no tools exposed"}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function WebhooksPage({ events }: { events: RuntimeEvent[] }) {
  const webhookEvents = events.filter((event) => event.type === "webhook.received" || event.resource?.startsWith("webhook:"));
  const sources = new Set(webhookEvents.map((event) => event.resource?.replace(/^webhook:/, "")).filter(Boolean));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Ingress</p>
          <h1>Webhooks</h1>
          <p className="lede">Signed external events entering the head node and becoming append-only control-plane audit records.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><Webhook size={15} />Copy endpoint</Button>
          <Button variant="laser"><ShieldCheck size={15} />Verify signature</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Webhook events" value={String(webhookEvents.length)} delta="live audit rows" />
        <Kpi label="Sources" value={String(sources.size)} delta="observed" />
        <Kpi label="Failures" value={String(events.filter((event) => event.resource?.startsWith("webhook:") && event.outcome === "failure").length)} delta="signature/body" />
        <Kpi label="Endpoint" value="/api/webhooks/:source" delta="runtime" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Webhook trail</CardTitle>
              <CardDescription>Recently received ingress events from the runtime audit stream.</CardDescription>
            </div>
            <Webhook size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {webhookEvents.map((event) => (
                  <TableRow key={event.id ?? `${event.ts}-${event.resource}`}>
                    <TableCell className="name">{new Date(event.ts).toLocaleTimeString([], { hour12: false })}</TableCell>
                    <TableCell>{event.resource ?? "webhook"}</TableCell>
                    <TableCell>@{cleanProfile(event.actor) ?? "external"}</TableCell>
                    <TableCell><ProviderStatus status={event.outcome === "failure" ? "blocked" : "ready"} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Security contract</CardTitle>
              <CardDescription>Runtime-enforced ingress rules.</CardDescription>
            </div>
            <ShieldCheck size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {[
              ["Source id", "lowercase, bounded, path-safe"],
              ["Body limit", "1 MB before audit write"],
              ["Signature", "HMAC SHA-256 when source secret exists"],
              ["Audit", "successful ingress becomes webhook.received"],
            ].map(([title, detail]) => (
              <div className="plugin-row" key={title}>
                <Webhook size={15} />
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

function EnvironmentsPage({ environments, runtimes, reload }: { environments: EnvironmentRow[]; runtimes: RuntimeContract[]; reload(): Promise<void> }) {
  async function ensureFirstRuntime() {
    const profile = runtimes[0]?.profile;
    if (!profile) return;
    await ensureAgentRuntime(profile);
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Infrastructure</p>
          <h1>Environments</h1>
          <p className="lede">Live runtime contracts for compute, storage, ingress, workspace, secrets, and tool materialization.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><LaptopMinimal size={15} />Render manifests</Button>
          <Button variant="laser" onClick={() => void ensureFirstRuntime()}><Cpu size={15} />Ensure workspace</Button>
        </div>
      </div>

      <section className="kpi-grid">
        <Kpi label="Contracts" value={String(environments.length)} delta="agent runtimes" />
        <Kpi label="Ready" value={String(environments.filter((env) => env.state === "ready").length)} delta="no warnings" />
        <Kpi label="Blocked" value={String(environments.filter((env) => env.state === "blocked").length)} delta="warnings present" />
        <Kpi label="Workspace" value={String(runtimes.filter((runtime) => runtime.workspace).length)} delta="materialized config" />
      </section>

      <section className="dashboard-grid">
        <Card className="span-8">
          <CardHeader>
            <div>
              <CardTitle>Runtime contracts</CardTitle>
              <CardDescription>Resolved from each agent pack and runtime provider.</CardDescription>
            </div>
            <LaptopMinimal size={16} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>Compute</TableHead>
                  <TableHead>Storage</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environments.map((environment) => (
                  <TableRow key={`${environment.provider}-${environment.compute}`}>
                    <TableCell className="name">{environment.provider}</TableCell>
                    <TableCell>{environment.compute}</TableCell>
                    <TableCell>{environment.storage}</TableCell>
                    <TableCell><ProviderStatus status={environment.state} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="span-4">
          <CardHeader>
            <div>
              <CardTitle>Ingress and secrets</CardTitle>
              <CardDescription>Provider-neutral runtime shape.</CardDescription>
            </div>
            <ShieldCheck size={16} />
          </CardHeader>
          <CardContent className="plugin-list">
            {runtimes.slice(0, 10).map((runtime, index) => (
              <div className="plugin-row" key={`${runtime.profile}-${index}`}>
                <LaptopMinimal size={15} />
                <div>
                  <div className="row-title">@{runtime.profile ?? "agent"}</div>
                  <div className="row-sub">{summarizePayload(runtime.ingress)} · {summarizePayload(runtime.secrets)}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function MemoryPage({ agents, memories, memoryEntries }: { agents: Agent[]; memories: MemoryStoreRow[]; memoryEntries: MemoryEntry[] }) {
  const [memoryView, setMemoryView] = useState<"memories" | "stores" | "promotion" | "internals">("memories");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(memoryEntries[0]?.id ?? "");
  const [draftText, setDraftText] = useState(memoryEntries[0]?.text ?? "");
  const [editingMemory, setEditingMemory] = useState(false);
  const total = memories.reduce((sum, memory) => sum + memory.entries, 0);
  const filteredEntries = memoryEntries.filter((entry) => {
    const agentMatch = selectedAgent === "all" || entry.agent === selectedAgent;
    const queryText = `${entry.agent} ${entry.type} ${entry.scope} ${entry.source} ${entry.tags.join(" ")} ${entry.text}`.toLowerCase();
    return agentMatch && queryText.includes(query.toLowerCase());
  });
  const selected = filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? memoryEntries[0];
  useEffect(() => {
    if (!selected) return;
    setDraftText(selected.text);
    setEditingMemory(false);
  }, [selected?.id, selected?.text]);
  const selectedStore = selected ? memories.find((memory) => memory.agent === selected.agent) : undefined;

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
                    className={`memory-row ${entry.id === selected?.id ? "active" : ""}`}
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
                <CardDescription>{selected ? `${selected.source} · updated ${selected.updated}` : "No runtime memories visible"}</CardDescription>
              </div>
              <ProviderStatus status={selectedStore?.status ?? "ready"} />
            </CardHeader>
            <CardContent className="memory-editor">
              {!selected ? (
                <div className="memory-empty">
                  <b>No memories exposed by runtime</b>
                  <span>Prompt an agent or enable Honcho/local memory sync to populate this view.</span>
                </div>
              ) : !editingMemory ? (
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
function AuditLogsPage({ events, rawEvents }: { events: EventRow[]; rawEvents: RuntimeEvent[] }) {
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
        <Kpi label="Delegations" value={String(rawEvents.filter((event) => event.type.includes("delegate")).length)} delta="down-chain" />
        <Kpi label="Reports" value={String(rawEvents.filter((event) => event.type.includes("report")).length)} delta="up-chain" />
        <Kpi label="Tool calls" value={String(rawEvents.filter((event) => event.type.includes("tool")).length)} delta="federated grant" />
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
                {events.map((event, index) => (
                  <TableRow key={`${event.time}-${event.event}-${index}`}>
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

function DoctorPage({ snapshot, agents, events }: { snapshot: RuntimeSnapshot; agents: Agent[]; events: RuntimeEvent[] }) {
  const checks = [
    { name: "Head node", status: snapshot.connected ? "ready" : "blocked", detail: snapshot.connected ? `Runtime ${snapshot.runtime?.runtimeId ?? snapshot.health?.runtimeId ?? "connected"}` : snapshot.error ?? "Runtime not reachable" },
    { name: "Agent profiles", status: agents.length ? "ready" : "blocked", detail: `${agents.length} live profiles resolved from runtime config` },
    { name: "Lash routes", status: events.some((event) => event.type.startsWith("lash.")) ? "ready" : "configured", detail: `${events.filter((event) => event.type.startsWith("lash.")).length} Lash events visible` },
    { name: "MCP grants", status: snapshot.agents.some((agent) => Object.values(agent.mcp?.grants ?? {}).some((grant) => grant.allowed)) ? "ready" : "configured", detail: "Federated grants resolved from agent snapshots" },
    { name: "Scheduler", status: snapshot.scheduler.jobs.length ? "ready" : "blocked", detail: `${snapshot.scheduler.jobs.length} jobs · ${snapshot.scheduler.runs.length} runs` },
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
