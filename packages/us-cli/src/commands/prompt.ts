import {
  resolveProfile,
  runAgentPrompt,
} from "@unionstreet/server";

export async function prompt(profileArg: string | undefined, text: string): Promise<void> {
  const resolved = await resolveProfile(profileArg);
  await runAgentPrompt({
    profile: resolved.name,
    prompt: text,
    cwd: process.cwd(),
    onText: (chunk) => process.stdout.write(chunk),
    onToolResult: (name, result) => {
      console.error(`[tool:${name}] ${result.split("\n")[0] ?? ""}`);
    },
    onModelFallback: (from, to, error) => {
      console.error(`[model:${from.provider}/${from.id}] ${error.message}`);
      console.error(`[fallback] ${to.provider}/${to.id}`);
    },
  });
  process.stdout.write("\n");
}
