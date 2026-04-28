const DISABLE_TERMINAL_MOUSE_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l";
const DISABLE_TERMINAL_EXTRA_MODES =
  "\x1b[?2004l\x1b[?2026l\x1b[?2027l\x1b[?2031l\x1b[?25h";

export function resetTerminalModes() {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(DISABLE_TERMINAL_MOUSE_MODES + DISABLE_TERMINAL_EXTRA_MODES);
  } catch {}
}
