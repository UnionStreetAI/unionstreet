import { Background, Controls, MiniMap, Position, ReactFlow, type Edge, type Node, useEdgesState, useNodesState } from "@xyflow/react";
import { BrainCircuit, FileCode2, Folder, GitBranch, Network, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../App";
import type { DashboardModelGroup } from "./model-selector";
import { AgentEditor } from "./agent-editor";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type FleetView = "graph" | "filesystem";

interface AgentFleetProps {
  agents: Agent[];
  modelGroups: DashboardModelGroup[];
  initialView?: FleetView;
}

export function AgentFleet({ agents, modelGroups, initialView = "graph" }: AgentFleetProps) {
  const [view, setView] = useState<FleetView>(initialView);
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const graph = useMemo(() => agentGraph(agents), [agents]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

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

  function openAgent(id: string) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent) {
      setSelectedAgentId(agent.id);
      setEditingAgent(agent);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Agent fleet</p>
          <h1>Org configuration</h1>
          <p className="lede">Visualize the hierarchy as an org graph or profile filesystem, then open any agent to edit soul, Lash, models, fallback chain, and permissions.</p>
        </div>
        <div className="actions">
          <Button variant="secondary"><GitBranch size={15} />Validate Lash</Button>
          <Button variant="laser"><BrainCircuit size={15} />New agent</Button>
        </div>
      </div>

      <Tabs>
        <TabsList>
          <TabsTrigger active={view === "graph"} onClick={() => setView("graph")}><Network size={14} />Graph</TabsTrigger>
          <TabsTrigger active={view === "filesystem"} onClick={() => setView("filesystem")}><Folder size={14} />Filesystem</TabsTrigger>
        </TabsList>
      </Tabs>

      <section className="fleet-grid">
        <Card className="fleet-main">
          <CardHeader>
            <div>
              <CardTitle>{view === "graph" ? "Org graph" : "Profile filesystem"}</CardTitle>
              <CardDescription>Double-click an agent to open the shared config editor.</CardDescription>
            </div>
            <Badge tone="laser">{agents.length} agents</Badge>
          </CardHeader>
          <CardContent className="fleet-canvas-wrap">
            {view === "graph" ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodesDraggable
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                fitView
                minZoom={0.35}
                maxZoom={1.4}
                onNodeClick={(_, node) => setSelectedAgentId(String(node.id))}
                onNodeDoubleClick={(_, node) => openAgent(String(node.id))}
              >
                <Background color="var(--border-2)" gap={22} />
                <MiniMap nodeStrokeWidth={3} pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <AgentFilesystem agents={agents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} onOpen={openAgent} />
            )}
          </CardContent>
        </Card>

        <aside className="fleet-side">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Selected agent</CardTitle>
                <CardDescription>Logical profile and routing summary.</CardDescription>
              </div>
              <Settings2 size={16} />
            </CardHeader>
            <CardContent>
              {selectedAgent && (
                <div className="selected-agent">
                  <div className="selected-agent-title">
                    <b>@{selectedAgent.id}</b>
                    <Badge tone={selectedAgent.status === "live" ? "success" : selectedAgent.status === "blocked" ? "warning" : "muted"}>{selectedAgent.status}</Badge>
                  </div>
                  <dl>
                    <div><dt>Role</dt><dd>{selectedAgent.title}</dd></div>
                    <div><dt>Group</dt><dd>{selectedAgent.group}</dd></div>
                    <div><dt>Model</dt><dd>{selectedAgent.model}</dd></div>
                    <div><dt>Runtime</dt><dd>{selectedAgent.runtime}</dd></div>
                    <div><dt>Manager</dt><dd>{selectedAgent.manager ? `@${selectedAgent.manager}` : "none"}</dd></div>
                    <div><dt>Reports</dt><dd>{agents.filter((agent) => agent.manager === selectedAgent.id).length}</dd></div>
                  </dl>
                  <Button variant="laser" onClick={() => setEditingAgent(selectedAgent)}><FileCode2 size={15} />Open config editor</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </section>

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

function AgentFilesystem(props: {
  agents: Agent[];
  selectedAgentId: string;
  onSelect(id: string): void;
  onOpen(id: string): void;
}) {
  const roots = props.agents.filter((agent) => !agent.manager);
  return (
    <div className="agent-fs" role="tree">
      {roots.map((root) => (
        <AgentTreeNode key={root.id} agent={root} agents={props.agents} depth={0} selectedAgentId={props.selectedAgentId} onSelect={props.onSelect} onOpen={props.onOpen} />
      ))}
    </div>
  );
}

function AgentTreeNode(props: {
  agent: Agent;
  agents: Agent[];
  depth: number;
  selectedAgentId: string;
  onSelect(id: string): void;
  onOpen(id: string): void;
}) {
  const children = props.agents.filter((agent) => agent.manager === props.agent.id);
  return (
    <div>
      <button
        className={`agent-fs-row ${props.selectedAgentId === props.agent.id ? "active" : ""}`}
        style={{ paddingLeft: 12 + props.depth * 24 }}
        onClick={() => props.onSelect(props.agent.id)}
        onDoubleClick={() => props.onOpen(props.agent.id)}
      >
        {children.length ? <Folder size={15} /> : <FileCode2 size={15} />}
        <span>@{props.agent.id}</span>
        <em>{props.agent.title}</em>
        <b>{props.agent.model}</b>
      </button>
      {children.map((child) => (
        <AgentTreeNode key={child.id} agent={child} agents={props.agents} depth={props.depth + 1} selectedAgentId={props.selectedAgentId} onSelect={props.onSelect} onOpen={props.onOpen} />
      ))}
    </div>
  );
}

function agentGraph(agents: Agent[]): { nodes: Node[]; edges: Edge[] } {
  const levels = levelsForAgents(agents);
  const nodes: Node[] = agents.map((agent) => {
    const level = levels.get(agent.id) ?? 0;
    const siblings = agents.filter((candidate) => (levels.get(candidate.id) ?? 0) === level);
    const index = siblings.findIndex((candidate) => candidate.id === agent.id);
    return {
      id: agent.id,
      position: { x: index * 260, y: level * 150 },
      data: { label: agentNodeLabel(agent) },
      className: `agent-flow-node ${agent.status}`,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });
  const edges: Edge[] = agents
    .filter((agent) => agent.manager)
    .map((agent) => ({
      id: `${agent.manager}-${agent.id}`,
      source: agent.manager!,
      target: agent.id,
      animated: agent.status === "live",
      className: "agent-flow-edge",
    }));
  return { nodes, edges };
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

function agentNodeLabel(agent: Agent) {
  return (
    <div className="agent-node-card">
      <b>@{agent.id}</b>
      <span>{agent.title}</span>
      <em>{agent.model}</em>
    </div>
  );
}
