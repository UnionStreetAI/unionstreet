import kleur from "kleur";
import {
  applyFleetPlan,
  createFleetPlanningPrompt,
  parseFleetPlanText,
  readFleetPlanFile,
  resolveProfile,
  runAgentPrompt,
  serializeFleetPlan,
  validateFleetPlan,
  writeEvent,
  writeFleetPlanFile,
  type FleetPlan,
} from "@unionstreet/us-core";

export interface FleetCommandOptions {
  prompt?: string;
  out?: string;
  json?: boolean;
  replace?: boolean;
  dryRun?: boolean;
}

export async function fleetCommand(action: string | undefined, arg: string | undefined, options: FleetCommandOptions = {}): Promise<void> {
  switch (action ?? "status") {
    case "plan":
      await fleetPlan(arg, options);
      return;
    case "validate":
      await fleetValidate(arg, options);
      return;
    case "apply":
      await fleetApply(arg, options);
      return;
    default:
      throw new Error(`Unknown fleet action "${action}". Try: plan <agent> -p <prompt> | validate <file> | apply <file>`);
  }
}

async function fleetPlan(profileArg: string | undefined, options: FleetCommandOptions): Promise<void> {
  const prompt = typeof options.prompt === "string" ? options.prompt.trim() : "";
  if (!prompt) throw new Error("`us-dev fleet plan <agent> -p <prompt>` requires a prompt.");
  const resolved = await resolveProfile(profileArg);
  const result = await runAgentPrompt({
    profile: resolved.name,
    prompt: createFleetPlanningPrompt(resolved.name, prompt),
    cwd: process.cwd(),
  });
  const plan = parseFleetPlanText(result.text);
  const validation = await validateFleetPlan(plan, { allowExisting: true });
  await writeEvent({
    type: "fleet.plan.create",
    actor: resolved.name,
    subject: plan.root,
    resource: `fleet:${plan.name}`,
    outcome: validation.ok ? "success" : "failure",
    reason: validation.ok ? undefined : validation.errors.join("; "),
    trace: result.trace,
    sessionId: result.sessionId,
    payload: {
      agents: plan.agents.map((agent) => agent.id),
      warnings: validation.warnings,
      errors: validation.errors,
    },
  });
  await emitPlan(plan, options);
  if (!validation.ok) {
    throw new Error(`Generated fleet plan did not validate:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

async function fleetValidate(path: string | undefined, options: FleetCommandOptions): Promise<void> {
  if (!path) throw new Error("`us-dev fleet validate <file>` requires a fleet plan path.");
  const plan = await readFleetPlanFile(path);
  const validation = await validateFleetPlan(plan, { allowExisting: options.replace === true });
  if (options.json) {
    console.log(JSON.stringify({ plan, validation }, null, 2));
  } else {
    printValidation(plan, validation);
  }
  if (!validation.ok) process.exitCode = 1;
}

async function fleetApply(path: string | undefined, options: FleetCommandOptions): Promise<void> {
  if (!path) throw new Error("`us-dev fleet apply <file>` requires a fleet plan path.");
  const plan = await readFleetPlanFile(path);
  const result = await applyFleetPlan(plan, { overwrite: options.replace === true, dryRun: options.dryRun === true });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printValidation(plan, result.validation);
    if (result.applied) {
      console.log(kleur.green(`applied ${result.profiles.length} agents`));
      for (const profile of result.profiles) console.log(`  ${kleur.cyan(`@${profile}`)}`);
    } else if (options.dryRun) {
      console.log(kleur.yellow(`dry-run ok for ${result.profiles.length} agents`));
    }
  }
  if (!result.validation.ok) process.exitCode = 1;
}

async function emitPlan(plan: FleetPlan, options: FleetCommandOptions): Promise<void> {
  if (options.out) {
    await writeFleetPlanFile(options.out, plan);
    console.log(kleur.green(`wrote fleet plan ${options.out}`));
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  process.stdout.write(serializeFleetPlan(plan));
}

function printValidation(plan: FleetPlan, validation: Awaited<ReturnType<typeof validateFleetPlan>>): void {
  console.log(kleur.bold(plan.name));
  console.log(`  root   ${kleur.cyan(`@${validation.summary.root || plan.root}`)}`);
  console.log(`  agents ${kleur.cyan(String(validation.summary.agents))}`);
  console.log(`  groups ${kleur.dim(validation.summary.groups.join(", ") || "none")}`);
  console.log(`  mcp    ${kleur.dim(validation.summary.mcpServers.join(", ") || "none")}`);
  for (const warning of validation.warnings) console.log(`  ${kleur.yellow("warn")}  ${warning}`);
  for (const error of validation.errors) console.log(`  ${kleur.red("error")} ${error}`);
  console.log(validation.ok ? kleur.green("  validation ok") : kleur.red("  validation failed"));
}
