import { Background, Controls, MiniMap, Position, ReactFlow, type Edge, type Node, useEdgesState, useNodesState } from "@xyflow/react";
import { BrainCircuit, FileCode2, MessageSquare, Network, Radio, ScrollText, Settings2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../App";
import type { RuntimeEvent } from "../runtime-client";
import { AgentEditor } from "./agent-editor";
import type { DashboardModelGroup } from "./model-selector";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type CommandView = "graph" | "timeline";

export interface CommandCenterEventRow {
  time: string;
  actor: string;
  event: string;
  detail: string;
}

interface CommandCenterProps {
  agents: Agent[];
  modelGroups: DashboardModelGroup[];
  events: CommandCenterEventRow[];
  rawEvents: RuntimeEvent[];
  connected: boolean;
  runtimeError?: string;
  runtimeBaseUrl: string;
  statusCounts: { live: number; idle: number; blocked: number };
  onOpenChat(agentId: string): void;
  onOpenAgents(): void;
  onOpenAudit(): void;
}

export function CommandCenter({
  agents,
  modelGroups,
  events,
  rawEvents,
  connected,
  runtimeError,
  runtimeBaseUrl,
  statusCounts,
  onOpenChat,
  onOpenAgents,
  onOpenAudit,
}: CommandCenterProps) {
  const [view, setView] = useState<CommandView>("graph");
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "");
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const directReports = selectedAgent ? agents.filter((agent) => agent.manager === selectedAgent.id) : [];
  const activeEdges = useMemo(() => activeEdgeIds(rawEvents, agents), [rawEvents, agents]);
  const graph = useMemo(() => commandGraph(agents, activeEdges, selectedAgent?.id), [agents, activeEdges, selectedAgent?.id]);
  const topologyKey = useMemo(() => agents.map((agent) => agent.id).join("|"), [agents]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const recentEvents = events.slice(0, 14);

  useEffect(() => {
    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const existing = currentById.get(node.id);
        return existing ? { ...node, position: existing.position } : node;
      });
    });
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

  useEffect(() => {
    if (!selectedAgent && agents[0]) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgent]);

  function openAgent(id: string) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    setSelectedAgentId(agent.id);
    setEditingAgent(agent);
  }

  return (
    <>
      <div className="page-head command-head">
        <div>
          <p className="eyebrow">Agent command center</p>
          <h1>Fleet activity</h1>
          <p className="lede">
            {connected
              ? "Single pane of glass for live agents, Lash traffic, runtime events, and operator steering."
              : `Runtime unavailable at ${runtimeBaseUrl}: ${runtimeError ?? "not connected"}`}
          </p>
        </div>
        <div className="actions">
          <Button variant="secondary" onClick={onOpenAudit}><ScrollText size={15} />Audit trail</Button>
          <Button variant="laser" onClick={() => selectedAgent && onOpenChat(selectedAgent.id)}><MessageSquare size={15} />Steer selected</Button>
        </div>
      </div>

      <section className="command-grid">
        <Card className="command-graph-card">
          <CardHeader>
            <div>
              <CardTitle>Live topology</CardTitle>
              <CardDescription>Animated edges mark recent delegation, reports, prompts, and tool traffic.</CardDescription>
            </div>
            <Tabs>
              <TabsList>
                <TabsTrigger active={view === "graph"} onClick={() => setView("graph")}><Network size={14} />Graph</TabsTrigger>
                <TabsTrigger active={view === "timeline"} onClick={() => setView("timeline")}><ScrollText size={14} />Timeline</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="command-canvas-wrap">
            {view === "graph" && agents.length ? (
              <ReactFlow
                key={topologyKey}
                nodes={nodes}
                edges={edges}
                nodesDraggable
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                fitView
                fitViewOptions={{ padding: 0.28 }}
                minZoom={0.35}
                maxZoom={1.5}
                onNodeClick={(_, node) => setSelectedAgentId(String(node.id))}
                onNodeDoubleClick={(_, node) => openAgent(String(node.id))}
              >
                <Background color="var(--border-2)" gap={24} />
                <MiniMap nodeStrokeWidth={3} pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : view === "graph" ? (
              <div className="command-empty-canvas">
                <div className="empty-state">No live agents are visible from the runtime yet.</div>
              </div>
            ) : (
              <CommandTimeline events={events} />
            )}
          </CardContent>
        </Card>

        <aside className="command-side">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Fleet pulse</CardTitle>
                <CardDescription>Current operating posture.</CardDescription>
              </div>
              <Radio size={16} />
            </CardHeader>
            <CardContent className="command-pulse-grid">
              <div><span>Agents</span><b>{agents.length}</b><em>{statusCounts.live} live</em></div>
              <div><span>Events</span><b>{events.length}</b><em>visible now</em></div>
              <div><span>Blocked</span><b>{statusCounts.blocked}</b><em>need action</em></div>
              <div><span>Edges</span><b>{activeEdges.size}</b><em>active routes</em></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Selected agent</CardTitle>
                <CardDescription>Click nodes to inspect, double-click to configure.</CardDescription>
              </div>
              <Settings2 size={16} />
            </CardHeader>
            <CardContent>
              {selectedAgent ? (
                <div className="selected-agent command-selected">
                  <div className="selected-agent-title">
                    <b>@{selectedAgent.id}</b>
                    <StatusPill status={selectedAgent.status} />
                  </div>
                  <dl>
                    <div><dt>Role</dt><dd>{selectedAgent.title}</dd></div>
                    <div><dt>Model</dt><dd>{selectedAgent.model}</dd></div>
                    <div><dt>Runtime</dt><dd>{selectedAgent.runtime}</dd></div>
                    <div><dt>Manager</dt><dd>{selectedAgent.manager ? `@${selectedAgent.manager}` : "none"}</dd></div>
                    <div><dt>Reports</dt><dd>{directReports.length ? directReports.map((agent) => `@${agent.id}`).join(", ") : "none"}</dd></div>
                  </dl>
                  <div className="command-agent-actions">
                    <Button variant="laser" onClick={() => onOpenChat(selectedAgent.id)}><MessageSquare size={15} />Chat</Button>
                    <Button variant="secondary" onClick={() => setEditingAgent(selectedAgent)}><FileCode2 size={15} />Configure</Button>
                  </div>
                </div>
              ) : (
                <div className="empty-state">No agents are currently visible.</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Activity rail</CardTitle>
                <CardDescription>Latest runtime facts across the stack.</CardDescription>
              </div>
              <Zap size={16} />
            </CardHeader>
            <CardContent className="command-activity-rail">
              {recentEvents.length ? recentEvents.map((event, index) => (
                <button
                  key={`${event.time}-${event.actor}-${event.event}-${index}`}
                  className="activity-card"
                  type="button"
                  onClick={() => {
                    const agent = cleanHandle(event.actor);
                    if (agents.some((candidate) => candidate.id === agent)) setSelectedAgentId(agent);
                  }}
                >
                  <span>{event.time}</span>
                  <b>@{event.actor}</b>
                  <em>{event.event}</em>
                  <p>{event.detail}</p>
                </button>
              )) : (
                <div className="empty-state">No events yet.</div>
              )}
            </CardContent>
          </Card>
        </aside>
      </section>

      <div className="command-bottom-actions">
        <Button variant="secondary" onClick={onOpenAgents}><BrainCircuit size={15} />Open agent configuration</Button>
      </div>

      {editingAgent && (
        <AgentEditor
          agent={editingAgent}
          modelGroups={modelGroups}
          directReports={agents.filter((agent) => agent.manager === editingAgent.id)}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </>
  );
}

function CommandTimeline({ events }: { events: CommandCenterEventRow[] }) {
  return (
    <div className="command-timeline">
      {events.length ? events.map((event, index) => (
        <div className="command-timeline-row" key={`${event.time}-${event.actor}-${event.event}-${index}`}>
          <span>{event.time}</span>
          <b>@{event.actor}</b>
          <em>{event.event}</em>
          <p>{event.detail}</p>
        </div>
      )) : (
        <div className="empty-state">No runtime events yet.</div>
      )}
    </div>
  );
}

function commandGraph(agents: Agent[], activeEdges: Set<string>, selectedAgentId: string | undefined): { nodes: Node[]; edges: Edge[] } {
  const levels = levelsForAgents(agents);
  const nodes: Node[] = agents.map((agent) => {
    const level = levels.get(agent.id) ?? 0;
    const siblings = agents.filter((candidate) => (levels.get(candidate.id) ?? 0) === level);
    const index = siblings.findIndex((candidate) => candidate.id === agent.id);
    return {
      id: agent.id,
      position: { x: index * 290, y: level * 168 },
      data: { label: commandNodeLabel(agent, agent.id === selectedAgentId) },
      className: `agent-flow-node command-node ${agent.status} ${agent.id === selectedAgentId ? "selected" : ""}`,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });
  const edges: Edge[] = agents
    .filter((agent) => agent.manager)
    .map((agent) => {
      const id = `${agent.manager}-${agent.id}`;
      const active = activeEdges.has(id);
      return {
        id,
        source: agent.manager!,
        target: agent.id,
        animated: active || agent.status === "live",
        className: `agent-flow-edge command-edge ${active ? "communicating" : ""}`,
      };
    });
  return { nodes, edges };
}

function commandNodeLabel(agent: Agent, selected: boolean) {
  return (
    <div className="agent-node-card command-agent-node">
      <div className="node-title-line">
        <span className={`live-ring ${agent.status}`} />
        <b>@{agent.id}</b>
        {selected && <em>selected</em>}
      </div>
      <span>{agent.title}</span>
      <small>{agent.model}</small>
    </div>
  );
}

function activeEdgeIds(events: RuntimeEvent[], agents: Agent[]): Set<string> {
  const ids = new Set<string>();
  const agentIds = new Set(agents.map((agent) => agent.id));
  for (const event of events.slice(0, 80)) {
    const actor = cleanHandle(event.actor);
    const target = cleanHandle(event.target) || cleanHandle(event.subject);
    if (actor && target && agentIds.has(actor) && agentIds.has(target)) {
      ids.add(`${actor}-${target}`);
      ids.add(`${target}-${actor}`);
    }
    if (actor && event.type.includes("report")) {
      const manager = agents.find((agent) => agent.id === actor)?.manager;
      if (manager) ids.add(`${manager}-${actor}`);
    }
    if (actor && (event.type.includes("delegate") || event.type.includes("prompt") || event.type.includes("tool"))) {
      for (const child of agents.filter((agent) => agent.manager === actor)) ids.add(`${actor}-${child.id}`);
    }
  }
  return ids;
}

function levelsForAgents(agents: Agent[]) {
  const levels = new Map<string, number>();
  function levelOf(agent: Agent): number {
    if (levels.has(agent.id)) return levels.get(agent.id)!;
    if (!agent.manager) {
      levels.set(agent.id, 0);
      return 0;
    }
    const parent = agents.find((candidate) => candidate.id === agent.manager);
    const level = parent ? levelOf(parent) + 1 : 0;
    levels.set(agent.id, level);
    return level;
  }
  agents.forEach(levelOf);
  return levels;
}

function cleanHandle(value: string | undefined): string {
  return value?.replace(/^agent:/, "").replace(/^@/, "") ?? "";
}

function StatusPill({ status }: { status: Agent["status"] }) {
  const tone = status === "live" ? "success" : status === "blocked" ? "warning" : "muted";
  return <Badge tone={tone}>{status}</Badge>;
}
