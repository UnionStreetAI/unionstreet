export default {
  description: "Collect GitHub pull request context with gh and local git. Returns JSON when available.",
  parameters: {
    type: "object",
    properties: {
      number: {
        type: "integer",
        description: "Pull request number. If omitted, gh chooses the PR for the current branch when possible.",
      },
    },
    additionalProperties: false,
  },
  async execute(args: Record<string, unknown>, context: { cwd: string }) {
    const number = Number.isInteger(args.number) ? String(args.number) : undefined;
    const view = await run(["gh", "pr", "view", ...(number ? [number] : []), "--json", "number,title,state,isDraft,author,baseRefName,headRefName,url,additions,deletions,changedFiles"], context.cwd);
    const diff = await run(["git", "diff", "--stat", "HEAD"], context.cwd);
    return JSON.stringify({ view, diff }, null, 2);
  },
};

async function run(cmd: string[], cwd: string): Promise<{ ok: boolean; exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      GH_TOKEN: process.env.GH_TOKEN ?? "",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, exit: code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 5_000) };
}
