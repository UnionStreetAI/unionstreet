/**
 * `us auth ...` — credential management.
 *
 *   us auth codex   [profile]   OAuth (ChatGPT Plus/Pro/Team)
 *   us auth claude  [profile]   OAuth (Claude Pro/Max)
 *   us auth status  [profile]   list configured providers
 *
 * Without a profile, writes to the SHARED file at ~/.us/auth-profiles.json.
 * With a profile, writes to that profile's auth-profiles.json — which
 * overrides the shared one for that profile's keys.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import kleur from "kleur";
import {
  GLOBAL_AUTH_PROFILES_PATH,
  profilePaths,
  profileExists,
  readAuthProfiles,
  updateAuthProfiles,
  resolveAuthProfiles,
  redactCred,
  redactMcpCred,
  type AuthProfilesFile,
  type OAuthCred,
} from "@unionstreet/us-core";
import {
  loginOpenAICodex,
  loginAnthropic,
  type OAuthCredentials,
} from "@unionstreet/us-auth";

async function targetPath(profile: string | undefined): Promise<string> {
  if (!profile) return GLOBAL_AUTH_PROFILES_PATH;
  if (!(await profileExists(profile))) {
    throw new Error(`Profile "${profile}" does not exist. Run \`us-dev init ${profile}\` first.`);
  }
  return profilePaths(profile).authProfiles;
}

function scopeLabel(profile: string | undefined): string {
  return profile ? kleur.magenta(`profile:${profile}`) : kleur.cyan("global");
}

async function ask(message: string, allowEmpty = false): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message}: `);
    if (!answer && !allowEmpty) return ask(message, allowEmpty);
    return answer;
  } finally {
    rl.close();
  }
}

function progress(label: string) {
  return (msg: string) => console.log(kleur.dim(`  ${label}: ${msg}`));
}

async function persistOAuth(
  path: string,
  providerKey: string,
  providerOAuthId: string,
  creds: OAuthCredentials,
): Promise<void> {
  await updateAuthProfiles(path, (current) => {
    const stored: OAuthCred = {
      kind: "oauth",
      provider: providerOAuthId,
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      ...stripStandardFields(creds),
    };
    return {
      ...current,
      providers: { ...current.providers, [providerKey]: stored },
    };
  });
}

function stripStandardFields(creds: OAuthCredentials): Record<string, unknown> {
  const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
  return rest;
}

export async function authCodex(profile: string | undefined): Promise<void> {
  const path = await targetPath(profile);
  console.log(kleur.bold(`\nus auth codex → ${scopeLabel(profile)}`));
  console.log(kleur.dim("ChatGPT Plus / Pro / Team / Enterprise OAuth.\n"));

  const creds = await loginOpenAICodex({
    onAuth: async ({ url, instructions }) => {
      console.log(kleur.cyan("Opening browser:"));
      console.log(`  ${url}`);
      if (instructions) console.log(kleur.dim(`  ${instructions}`));
      try {
        await open(url);
      } catch {
        console.log(kleur.yellow("  (couldn't open browser automatically — paste the URL manually)"));
      }
    },
    onPrompt: async (p) => ask(p.message, p.allowEmpty),
    onProgress: progress("codex"),
  });

  await persistOAuth(path, "codex", "openai-codex", creds);
  console.log(kleur.green(`\n  ✓ Codex OAuth saved to ${path}\n`));
}

export async function authClaude(profile: string | undefined): Promise<void> {
  const path = await targetPath(profile);
  console.log(kleur.bold(`\nus auth claude → ${scopeLabel(profile)}`));
  console.log(kleur.dim("Anthropic Claude Pro / Max OAuth.\n"));

  const creds = await loginAnthropic({
    onAuth: async ({ url, instructions }) => {
      console.log(kleur.cyan("Opening browser:"));
      console.log(`  ${url}`);
      if (instructions) console.log(kleur.dim(`  ${instructions}`));
      try {
        await open(url);
      } catch {
        console.log(kleur.yellow("  (couldn't open browser automatically — paste the URL manually)"));
      }
    },
    onPrompt: async (p) => ask(p.message, p.allowEmpty),
    onProgress: progress("claude"),
  });

  await persistOAuth(path, "claude", "anthropic", creds);
  console.log(kleur.green(`\n  ✓ Claude OAuth saved to ${path}\n`));
}

export async function authStatus(profile: string | undefined): Promise<void> {
  if (profile && !(await profileExists(profile))) {
    throw new Error(`Profile "${profile}" does not exist.`);
  }

  const resolved = await resolveAuthProfiles(profile);

  console.log("");
  console.log(kleur.bold("auth-profiles") + "  " + scopeLabel(profile));
  console.log(kleur.dim(`  global:  ${GLOBAL_AUTH_PROFILES_PATH}`));
  if (profile) {
    console.log(kleur.dim(`  profile: ${profilePaths(profile).authProfiles}`));
  }
  console.log("");

  printSection("providers", resolved.merged.providers, resolved.source.providers);
  printSection("channels", resolved.merged.channels, resolved.source.channels);
  printSection("storage", resolved.merged.storage, resolved.source.storage);
  printSection("mcp", resolved.merged.mcp, resolved.source.mcp);
  console.log("");
}

function printSection(
  title: string,
  entries: Record<string, unknown>,
  sourceMap: Record<string, "global" | "profile">,
): void {
  const keys = Object.keys(entries);
  if (!keys.length) return;
  console.log(kleur.bold(`  ${title}:`));
  for (const k of keys) {
    const value = entries[k];
    const src = sourceMap[k] ?? "global";
    const tag = src === "profile" ? kleur.magenta("[profile]") : kleur.dim("[global] ");
    let summary = "";
    if (title === "providers" && value && typeof value === "object" && "kind" in value) {
      const cred = value as { kind: string; expires?: number };
      const r = redactCred(cred as Parameters<typeof redactCred>[0]);
      summary =
        cred.kind === "oauth"
          ? `${cred.kind.padEnd(8)} ${expiryLabel((r as Record<string, unknown>)["expires_in_s"] as number)}`
          : `${cred.kind.padEnd(8)}`;
    } else if (title === "mcp" && value && typeof value === "object" && "kind" in value) {
      const cred = value as { kind: string; expires?: number };
      const r = redactMcpCred(cred as Parameters<typeof redactMcpCred>[0]);
      summary =
        cred.kind === "oauth"
          ? `${cred.kind.padEnd(8)} ${expiryLabel((r as Record<string, unknown>)["expires_in_s"] as number)}`
          : `${cred.kind.padEnd(8)}`;
    }
    console.log(`    ${tag} ${kleur.cyan(k.padEnd(14))} ${summary}`);
  }
  console.log("");
}

function expiryLabel(seconds: number): string {
  if (seconds <= 0) return kleur.red("expired");
  if (seconds < 300) return kleur.yellow(`expires in ${seconds}s`);
  if (seconds < 3600) return kleur.dim(`expires in ${Math.round(seconds / 60)}m`);
  if (seconds < 86400) return kleur.dim(`expires in ${Math.round(seconds / 3600)}h`);
  return kleur.dim(`expires in ${Math.round(seconds / 86400)}d`);
}
