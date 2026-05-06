/**
 * `us-dev profile ...` — profile management.
 *   us-dev profile list
 *   us-dev profile use <name>
 */
import {
  listProfiles,
  profileExists,
  readGlobalConfig,
  setDefaultProfile,
} from "@unionstreet/server";
import kleur from "kleur";

export async function profileList(): Promise<void> {
  const cfg = await readGlobalConfig();
  const names = await listProfiles();
  console.log("");
  if (!names.length) {
    console.log(kleur.dim("  (no profiles. Run `us-dev init <name>` to create one.)"));
    console.log("");
    return;
  }
  for (const n of names) {
    const star = cfg.default_profile === n ? kleur.green("★") : " ";
    console.log(`  ${star} ${kleur.cyan(n)}`);
  }
  console.log("");
  if (!cfg.default_profile) {
    console.log(kleur.dim(`  no default set. \`us-dev profile use <name>\` to pin one.`));
    console.log("");
  }
}

export async function profileUse(name: string): Promise<void> {
  if (!(await profileExists(name))) {
    throw new Error(`Profile "${name}" does not exist. Run \`us-dev init ${name}\` first.`);
  }
  await setDefaultProfile(name);
  console.log(kleur.green(`\n  ✓ default profile is now "${name}"\n`));
}
