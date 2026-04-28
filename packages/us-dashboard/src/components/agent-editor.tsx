import { BrainCircuit, CalendarDays, Clock3, GitBranch, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import type { Agent } from "../App";
import { ModelSelector, type DashboardModelGroup, type ModelSelection } from "./model-selector";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type EditorTab = "soul" | "lash" | "models" | "schedule" | "pulses" | "permissions";

interface AgentEditorProps {
  agent: Agent;
  modelGroups: DashboardModelGroup[];
  directReports: Agent[];
  onClose(): void;
}

export function AgentEditor({ agent, modelGroups, directReports, onClose }: AgentEditorProps) {
  const [activeTab, setActiveTab] = useState<EditorTab>("soul");
  const [scheduleView, setScheduleView] = useState<"day" | "week" | "month">("week");
  const [selectedScheduleDay, setSelectedScheduleDay] = useState("Mon");
  const [primaryModel, setPrimaryModel] = useState<ModelSelection>(modelSelectionForAgent(agent, modelGroups));
  const [fallbackOne, setFallbackOne] = useState<ModelSelection>({ provider: "anthropic", id: "claude-sonnet-4-5" });
  const [fallbackTwo, setFallbackTwo] = useState<ModelSelection>({ provider: "openai", id: "gpt-5.4-mini" });
  const [pulseFrequency, setPulseFrequency] = useState("weekly");
  const [pulseTime, setPulseTime] = useState("09:00");
  const [pulseDay, setPulseDay] = useState("MON");
  const [pulseInterval, setPulseInterval] = useState("30");
  const [pulseCanRewrite, setPulseCanRewrite] = useState(true);
  const pulseCron = buildPulseCron(pulseFrequency, pulseTime, pulseDay, pulseInterval);
  const scheduleEvents = [
    { id: "weekly-review", day: "Mon", date: 27, time: "09:00", duration: "45m", title: `${agent.title} weekly review`, kind: "sync" },
    { id: "pulse-check", day: "Wed", date: 29, time: "14:00", duration: "30m", title: "Pulse reconciliation", kind: "pulse" },
    { id: "report-pack", day: "Fri", date: 1, time: "10:00", duration: "30m", title: "Report packet", kind: "report" },
  ];
  const scheduleDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const visibleDays = scheduleView === "day" ? [selectedScheduleDay] : scheduleDays;
  const scheduleHours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
  const monthCells = [
    27, 28, 29, 30, 1, 2, 3,
    4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24,
  ];

  return (
    <div className="agent-editor-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="agent-editor" role="dialog" aria-modal="true" aria-label={`Edit @${agent.id}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="agent-editor-head">
          <div>
            <p className="eyebrow">Agent configuration</p>
            <h1>@{agent.id}</h1>
            <p className="lede">{agent.title} · {agent.group} · {agent.runtime}</p>
          </div>
          <div className="agent-editor-actions">
            <Badge tone={agent.status === "live" ? "success" : agent.status === "blocked" ? "warning" : "muted"}>{agent.status}</Badge>
            <Button variant="secondary" size="icon" aria-label="Close editor" onClick={onClose}><X size={15} /></Button>
          </div>
        </header>

        <div className="agent-editor-grid">
          <main className="agent-editor-main">
            {activeTab === "soul" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <Sparkles size={17} />
                  <div>
                    <h2>Soul</h2>
                    <p>System identity, working style, and durable behavioral contract.</p>
                  </div>
                </div>
                <label className="editor-field">
                  <span>SOUL.md</span>
                  <textarea defaultValue={`${agent.title} acts as @${agent.id} inside Union Street.\n\nMission:\n- preserve chain of command\n- keep reports crisp\n- delegate only to visible direct reports\n- report blockers upward through Lash\n\nOperating style:\n- concise, decisive, evidence-seeking\n- prefer deterministic tool use over vibes`} />
                </label>
                <div className="editor-two-col">
                  <label className="editor-field">
                    <span>Role</span>
                    <input defaultValue={agent.title} />
                  </label>
                  <label className="editor-field">
                    <span>Group</span>
                    <input defaultValue={agent.group} />
                  </label>
                </div>
              </section>
            )}

            {activeTab === "lash" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <GitBranch size={17} />
                  <div>
                    <h2>Lash</h2>
                    <p>Delegation and report routing for information flow.</p>
                  </div>
                </div>
                <div className="lash-rules">
                  <div><span>Manager</span><b>{agent.manager ? `@${agent.manager}` : "none"}</b></div>
                  <div><span>Direct reports</span><b>{directReports.length ? directReports.map((child) => `@${child.id}`).join(", ") : "none"}</b></div>
                  <div><span>Active thread</span><b>{agent.activeThread ?? "created on first send"}</b></div>
                </div>
                <label className="editor-field">
                  <span>LASH.md</span>
                  <textarea defaultValue={`visibility:\n  up: ${agent.manager ? `@${agent.manager}` : "none"}\n  down:\n${directReports.map((child) => `    - @${child.id}`).join("\n") || "    []"}\n\ntools:\n  delegate: direct_reports_only\n  report: manager_only\n  prompt_flag: descendants_and_manager\n\npolicy:\n  preserve_chain_of_command: true\n  structured_envelope: preferred\n  raw_prompt_fallback: allowed`} />
                </label>
              </section>
            )}

            {activeTab === "models" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <BrainCircuit size={17} />
                  <div>
                    <h2>Models</h2>
                    <p>Primary model and fallback chain for this agent.</p>
                  </div>
                </div>
                <div className="model-chain">
                  <label className="editor-field">
                    <span>Primary</span>
                    <ModelSelector groups={modelGroups} value={primaryModel} defaultValue={primaryModel} onChange={setPrimaryModel} />
                  </label>
                  <label className="editor-field">
                    <span>Fallback 1</span>
                    <ModelSelector groups={modelGroups} value={fallbackOne} defaultValue={primaryModel} onChange={setFallbackOne} />
                  </label>
                  <label className="editor-field">
                    <span>Fallback 2</span>
                    <ModelSelector groups={modelGroups} value={fallbackTwo} defaultValue={primaryModel} onChange={setFallbackTwo} />
                  </label>
                </div>
                <label className="editor-field">
                  <span>Fallback policy</span>
                  <textarea defaultValue={`on:\n  - provider_unavailable\n  - rate_limited\n  - model_not_supported\n  - context_overflow\nstrategy: preserve_provider_if_possible\nmax_retries: 2`} />
                </label>
              </section>
            )}

            {activeTab === "pulses" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <Clock3 size={17} />
                  <div>
                    <h2>Pulse</h2>
                    <p>Agent heartbeat behavior with self-modifiable instructions.</p>
                  </div>
                </div>
                <div className="heartbeat-summary">
                  <div>
                    <span>Heartbeat</span>
                    <b>{pulseFrequency === "interval" ? `every ${pulseInterval}m` : `${pulseFrequency} at ${pulseTime}`}</b>
                  </div>
                  <div>
                    <span>Target</span>
                    <b>agent runtime context</b>
                  </div>
                  <div>
                    <span>Instruction writes</span>
                    <b>{pulseCanRewrite ? "agent may propose patches" : "locked"}</b>
                  </div>
                </div>
                <div className="pulse-list">
                  {[
                    { name: "Heartbeat", cadence: "every 30m", target: "runtime context", state: agent.status === "blocked" ? "paused" : "enabled" },
                    { name: "Reflection pass", cadence: "weekdays at 08:00", target: "self-update proposal", state: "enabled" },
                  ].map((pulse) => (
                    <div className="pulse-row" key={pulse.name}>
                      <div>
                        <b>{pulse.name}</b>
                        <span>{pulse.cadence} · {pulse.target}</span>
                    </div>
                      <em>{pulse.state}</em>
                    </div>
                  ))}
                </div>
                <div className="heartbeat-policy">
                  <label>
                    <input type="checkbox" checked={pulseCanRewrite} onChange={(event) => setPulseCanRewrite(event.target.checked)} />
                    <span>Allow this agent to propose edits to its Pulse instructions</span>
                  </label>
                  <label>
                    <input type="checkbox" defaultChecked />
                    <span>Keep heartbeat turns out of visible chat transcript</span>
                  </label>
                  <label>
                    <input type="checkbox" defaultChecked />
                    <span>Report material blockers upward through Lash</span>
                  </label>
                </div>
                <label className="editor-field">
                  <span>Pulse instructions</span>
                  <textarea defaultValue={`You are the recurring heartbeat for @${agent.id}.\n\nOn each pulse:\n- inspect current open work, stale threads, and unresolved blockers\n- decide whether any direct report needs a delegated follow-up\n- report only material risk upward through Lash\n- keep routine OK output quiet unless configured otherwise\n\nSelf-modification:\n- if this Pulse is noisy, stale, or missing a useful check, propose a patch to this instruction block\n- never silently expand your own authority or visibility\n- preserve manager/direct-report boundaries\n\nOutput:\n- heartbeat status\n- decisions taken\n- proposed instruction patch, if any`} />
                </label>
              </section>
            )}

            {activeTab === "schedule" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <CalendarDays size={17} />
                  <div>
                    <h2>Schedule</h2>
                    <p>Calendar trigger for waking this agent with scoped instructions and deliverables.</p>
                  </div>
                </div>
                <div className="agent-schedule-toolbar">
                  <div>
                    <b>{scheduleView === "day" ? agentScheduleDate(selectedScheduleDay) : "Apr 27 - May 3, 2026"}</b>
                    <span>{agent.id} schedule · America/Los_Angeles · {pulseCron}</span>
                  </div>
                  <select value={selectedScheduleDay} onChange={(event) => setSelectedScheduleDay(event.target.value)} aria-label="Selected day">
                    {scheduleDays.map((day) => (
                      <option key={day} value={day}>{day} · {agentScheduleDate(day)}</option>
                    ))}
                  </select>
                  <Tabs>
                    <TabsList>
                      {(["day", "week", "month"] as const).map((view) => (
                        <TabsTrigger key={view} active={scheduleView === view} onClick={() => setScheduleView(view)}>
                          {view}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>

                <div className="agent-schedule-shell">
                  {scheduleView === "month" ? (
                    <div className="agent-schedule-month">
                      {scheduleDays.map((day) => (
                        <div className="agent-schedule-month-head" key={day}>{day}</div>
                      ))}
                      {monthCells.map((date, index) => {
                        const events = scheduleEvents.filter((event) => event.date === date);
                        return (
                          <div className={`agent-schedule-month-cell ${date === 27 ? "today" : ""}`} key={`${date}-${index}`}>
                            <span>{date}</span>
                            {events.map((event) => (
                              <button className={`agent-schedule-chip ${event.kind}`} key={event.id} onClick={() => {
                                setSelectedScheduleDay(event.day);
                                setScheduleView("day");
                              }}>
                                <b>{event.time}</b>
                                {event.title}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="agent-schedule-calendar" style={{ gridTemplateColumns: `70px repeat(${visibleDays.length}, minmax(${scheduleView === "day" ? "520px" : "132px"}, 1fr))` }}>
                      <div className="agent-schedule-corner">PST</div>
                      {visibleDays.map((day) => (
                        <div className="agent-schedule-day-head" key={day}>
                          <b>{day}</b>
                          <span>{agentScheduleDate(day)}</span>
                        </div>
                      ))}
                      {scheduleHours.map((hour) => (
                        <div className="agent-schedule-row" key={hour} style={{ display: "contents" }}>
                          <div className="agent-schedule-hour">{hour}</div>
                          {visibleDays.map((day) => {
                            const events = scheduleEvents.filter((event) => event.day === day && event.time >= hour && event.time < nextScheduleHour(hour));
                            return (
                              <div className="agent-schedule-cell" key={`${day}-${hour}`}>
                                {events.map((event) => (
                                  <button className={`agent-schedule-event ${event.kind}`} key={event.id} onClick={() => setSelectedScheduleDay(event.day)}>
                                    <b>{event.title}</b>
                                    <span>{event.time} · {event.duration}</span>
                                  </button>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <details className="schedule-advanced">
                  <summary>Trigger builder</summary>
                  <div className="schedule-builder">
                    <div className="schedule-builder-head">
                      <div>
                        <b>Schedule trigger</b>
                        <span>Compile this calendar rule to the scheduler contract.</span>
                      </div>
                      <code>{pulseCron}</code>
                    </div>
                    <div className="schedule-row">
                      <label className="editor-field">
                        <span>Repeats</span>
                        <select value={pulseFrequency} onChange={(event) => setPulseFrequency(event.target.value)}>
                          <option value="daily">Daily</option>
                          <option value="weekdays">Weekdays</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="interval">Every N minutes</option>
                        </select>
                      </label>
                      {pulseFrequency === "weekly" && (
                        <label className="editor-field">
                          <span>Day</span>
                          <select value={pulseDay} onChange={(event) => setPulseDay(event.target.value)}>
                            {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => (
                              <option key={day} value={day}>{day}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      {pulseFrequency === "interval" ? (
                        <label className="editor-field">
                          <span>Every</span>
                          <select value={pulseInterval} onChange={(event) => setPulseInterval(event.target.value)}>
                            <option value="5">5 minutes</option>
                            <option value="15">15 minutes</option>
                            <option value="30">30 minutes</option>
                            <option value="60">60 minutes</option>
                          </select>
                        </label>
                      ) : (
                        <label className="editor-field">
                          <span>Time</span>
                          <input type="time" value={pulseTime} onChange={(event) => setPulseTime(event.target.value)} />
                        </label>
                      )}
                    </div>
                  </div>
                </details>

                <div className="editor-two-col">
                  <label className="editor-field">
                    <span>Timezone</span>
                    <input defaultValue="America/Los_Angeles" />
                  </label>
                  <label className="editor-field">
                    <span>Delivery</span>
                    <select defaultValue="self">
                      <option value="self">Wake this agent</option>
                      <option value="manager">Report to manager</option>
                      <option value="reports">Delegate to reports</option>
                    </select>
                  </label>
                </div>
                <label className="editor-field">
                  <span>Scheduled instructions</span>
                  <textarea defaultValue={`Wake @${agent.id} on this schedule.\n\nTopic:\n- Review open work, stale blockers, and due reports.\n\nDeliverables:\n- concise status summary\n- material risks\n- next delegation or report action\n\nRouting:\n- preserve Lash visibility\n- use manager/direct-report scope only\n- launch through us -p with this agent's configured model chain`} />
                </label>
              </section>
            )}
            {activeTab === "permissions" && (
              <section className="config-panel">
                <div className="config-panel-head">
                  <ShieldCheck size={17} />
                  <div>
                    <h2>Permissions</h2>
                    <p>MCP grants, runtime placement, and approval posture.</p>
                  </div>
                </div>
                <div className="permission-grid">
                  <div><span>MCP grant</span><b>{agent.group === "engineering" ? "github" : agent.group === "executives" ? "github, linear, slack" : "scoped"}</b></div>
                  <div><span>Runtime</span><b>{agent.runtime}</b></div>
                  <div><span>Approval</span><b>{agent.group === "executives" ? "required for finance" : "not required"}</b></div>
                  <div><span>Workspace</span><b>profiles/{agent.id}</b></div>
                </div>
              </section>
            )}
          </main>

          <aside className="agent-editor-side">
            {[
              ["soul", "Soul", "identity and behavior"],
              ["lash", "Lash", "chain of command"],
              ["models", "Models", "fallback chain"],
              ["schedule", "Schedule", "calendar wakeups"],
              ["pulses", "Pulse", "heartbeat loop"],
              ["permissions", "Permissions", "MCP and runtime"],
            ].map(([id, label, hint]) => (
              <button key={id} className={`editor-side-item ${activeTab === id ? "active" : ""}`} onClick={() => setActiveTab(id as EditorTab)}>
                <b>{label}</b>
                <span>{hint}</span>
              </button>
            ))}
          </aside>
        </div>
      </section>
    </div>
  );
}

function modelSelectionForAgent(agent: Agent, groups: DashboardModelGroup[]): ModelSelection {
  const wanted = agent.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const group of groups) {
    const model = group.models.find((candidate) => candidate.id === wanted || candidate.name?.toLowerCase() === agent.model.toLowerCase());
    if (model) return { provider: group.id, id: model.id };
  }
  return { provider: groups[0]?.id ?? "openai", id: groups[0]?.models[0]?.id ?? "gpt-5.4" };
}

function buildPulseCron(frequency: string, time: string, day: string, interval: string): string {
  const [hourRaw, minuteRaw] = time.split(":");
  const hour = Number(hourRaw || 9);
  const minute = Number(minuteRaw || 0);
  if (frequency === "interval") return `*/${interval} * * * *`;
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (frequency === "monthly") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * ${day}`;
}

function nextScheduleHour(hour: string): string {
  const [raw] = hour.split(":");
  return `${String(Number(raw) + 1).padStart(2, "0")}:00`;
}

function agentScheduleDate(day: string): string {
  return ({ Mon: "Apr 27", Tue: "Apr 28", Wed: "Apr 29", Thu: "Apr 30", Fri: "May 1", Sat: "May 2", Sun: "May 3" } as Record<string, string>)[day] ?? "Apr 27";
}
