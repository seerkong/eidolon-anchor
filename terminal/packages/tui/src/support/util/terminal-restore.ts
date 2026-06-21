const RESTORE_TERMINAL_MODES = [
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1006l",
  "\x1b[?1007l",
  "\x1b[?1015l",
  "\x1b[?2027l",
  "\x1b[?2031l",
  "\x1b[?2004l",
  "\x1b[?25h",
  "\x1b[?1049l",
  "\x1b[>4;0m",
].join("")

export function restoreTuiTerminalModes(): void {
  try {
    process.stdout.write(RESTORE_TERMINAL_MODES)
  } catch {}
}
