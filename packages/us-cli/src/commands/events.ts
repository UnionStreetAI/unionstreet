import kleur from "kleur";
import { queryEvents, tailEvents, type ControlPlaneEventType, type EventQuery } from "@unionstreet/us-core";

interface EventsOptions {
  agent?: string;
  actor?: string;
  subject?: string;
  target?: string;
  type?: string;
  outcome?: string;
  trace?: string;
  limit?: string | number;
  json?: boolean;
}

export async function eventsCommand(action: string | undefined, options: EventsOptions = {}): Promise<void> {
  switch (action ?? "tail") {
    case "tail":
      await printEvents(await tailEvents(readLimit(options.limit)));
      return;
    case "query":
      await printEvents(await queryEvents(buildQuery(options)), Boolean(options.json));
      return;
    default:
      throw new Error(`Unknown events action "${action}". Try: tail | query`);
  }
}

function buildQuery(options: EventsOptions): EventQuery {
  const agent = normalizeAgent(options.agent);
  return {
    ...(options.type ? { type: options.type as ControlPlaneEventType } : {}),
    ...(options.outcome ? { outcome: options.outcome as EventQuery["outcome"] } : {}),
    ...(options.actor || agent ? { actor: normalizeAgent(options.actor) ?? agent } : {}),
    ...(options.subject ? { subject: normalizeAgent(options.subject) } : {}),
    ...(options.target ? { target: normalizeAgent(options.target) } : {}),
    ...(options.trace ? { trace: options.trace } : {}),
    limit: readLimit(options.limit),
  };
}

async function printEvents(events: Awaited<ReturnType<typeof queryEvents>>, json = false): Promise<void> {
  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  console.log("");
  console.log(kleur.bold("events"));
  if (!events.length) {
    console.log(kleur.dim("  none"));
    console.log("");
    return;
  }
  for (const event of events) {
    const when = new Date(event.ts).toISOString();
    const actor = event.actor ? ` @${event.actor}` : "";
    const target = event.target ? ` → @${event.target}` : "";
    const resource = event.resource ? ` ${kleur.dim(event.resource)}` : "";
    const trace = event.trace ? ` ${kleur.dim(`trace:${event.trace}`)}` : "";
    const color = event.outcome === "deny" || event.outcome === "failure" ? kleur.yellow : event.outcome === "allow" || event.outcome === "success" ? kleur.green : kleur.dim;
    console.log(`  ${kleur.dim(when)} ${color(event.outcome.padEnd(7))} ${kleur.cyan(event.type)}${actor}${target}${resource}${trace}`);
    if (event.reason) console.log(kleur.dim(`    ${event.reason}`));
  }
  console.log("");
}

function readLimit(value: string | number | undefined): number {
  const n = Number(value ?? 50);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 50;
}

function normalizeAgent(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^@+/, "");
  return trimmed || undefined;
}
