/**
 * Clipboard write — dual-path for robustness, opencode-style.
 *
 * Path 1: OSC 52 escape sequence emitted via stdout. The TERMINAL handles
 * the clipboard, so this works over SSH and in tmux (with set-clipboard
 * on). iTerm2, Kitty, Wezterm, Ghostty, and recent Terminal.app honor it.
 *
 * Path 2: Native command line tool — `pbcopy` on macOS, `wl-copy` on
 * Wayland Linux, `xclip`/`xsel` on X11, `clip.exe`/PowerShell on Windows.
 * Always works on a local terminal even when OSC 52 is dropped.
 *
 * We fire both. If either succeeds the user gets their copy. Errors are
 * swallowed — this is a best-effort path.
 */
import { spawn } from "bun";
import { platform } from "node:os";

/** Emit the OSC 52 escape (idempotent if stdout isn't a TTY). */
export function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return;
  const base64 = Buffer.from(text).toString("base64");
  const osc52 = `\x1b]52;c;${base64}\x07`;
  // Pass through tmux's wrapping if we're inside it.
  const inTmux = !!process.env["TMUX"];
  const sequence = inTmux ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52;
  process.stdout.write(sequence);
}

/**
 * Best-effort native-cli copy. Returns the spawned promise so callers can
 * await the actual write completion, but generally fire-and-forget is
 * fine — clipboards are written byte-by-byte to the spawned process's
 * stdin and the visible "did it copy" effect happens before we resolve.
 */
export async function nativeCopy(text: string): Promise<void> {
  const cmd = nativeCommand();
  if (!cmd) return;
  try {
    const proc = spawn(cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (proc.stdin) {
      proc.stdin.write(text);
      proc.stdin.end();
    }
    await proc.exited;
  } catch {
    // best-effort
  }
}

function nativeCommand(): string[] | null {
  const os = platform();
  if (os === "darwin") return ["pbcopy"];
  if (os === "win32") return ["clip.exe"];
  if (os === "linux") {
    if (process.env["WAYLAND_DISPLAY"]) return ["wl-copy"];
    return ["xclip", "-selection", "clipboard"];
  }
  return null;
}

/** Both paths. Don't await — copy is best-effort. */
export function copyText(text: string): void {
  if (!text) return;
  writeOsc52(text);
  void nativeCopy(text);
}
