/**
 * `us init <name>` — scaffold a new profile.
 */
import { initProfile, profileExists } from "@unionstreet/us-core";
import kleur from "kleur";

export interface InitArgs {
  role?: string;
  capability?: string | string[];
}

export async function init(name: string, args: InitArgs): Promise<void> {
  const exists = await profileExists(name);
  if (exists) {
    console.log(kleur.yellow(`Profile "${name}" already exists. Re-running init to fill in any missing files.`));
  }

  const capabilities = Array.isArray(args.capability)
    ? args.capability
    : args.capability
    ? [args.capability]
    : undefined;

  const result = await initProfile(name, { role: args.role, capabilities });

  console.log("");
  console.log(kleur.bold(`Profile "${name}"`) + kleur.dim(`  ${result.paths.root}`));
  if (result.created.length) {
    console.log(kleur.green(`  created (${result.created.length}):`));
    for (const p of result.created) console.log(`    ${kleur.dim(p.replace(result.paths.root, "."))}`);
  }
  if (result.alreadyExisted.length) {
    console.log(kleur.dim(`  already existed (${result.alreadyExisted.length}, untouched)`));
  }
  console.log("");
  console.log(kleur.bold("Next:"));
  console.log(`  ${kleur.cyan("us-dev auth codex")}                # ChatGPT Plus/Pro/Team OAuth (shared across all profiles)`);
  console.log(`  ${kleur.cyan("us-dev auth claude")}               # Claude Pro/Max OAuth (shared)`);
  console.log(`  ${kleur.cyan(`us-dev auth status ${name}`)}        # see merged view (global + profile overrides)`);
  console.log(kleur.dim(`  ${`us-dev auth codex ${name}`.padEnd(34)}# (optional) override credentials just for this profile`));
  console.log("");
}
