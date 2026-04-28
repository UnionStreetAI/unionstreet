/**
 * Some terminals can leak mouse tracking packets into focused text inputs.
 * OpenTUI normally consumes these as events, but when a packet gets damaged
 * on the way in we may only see the printable tail, e.g. `35;6;42M`.
 */
export function stripTerminalMousePackets(value: string): string {
  return value
    .replace(/\x1b\[\<\d{1,3};\d{1,4};\d{1,4}[mM]/g, "")
    .replace(/\[\<\d{1,3};\d{1,4};\d{1,4}[mM]/g, "")
    .replace(/\<\d{1,3};\d{1,4};\d{1,4}[mM]/g, "")
    .replace(/(?:0|1|2|3|32|33|34|35|64|65|96|97);\d{1,4};\d{1,4}[mM]/g, "");
}

export function cleanTextareaValue<T extends { plainText?: string; setText?: (text: string) => void }>(
  textarea: T | null | undefined,
): string {
  const raw = textarea?.plainText ?? "";
  const clean = stripTerminalMousePackets(raw);
  if (textarea && clean !== raw && typeof textarea.setText === "function") {
    textarea.setText(clean);
  }
  return clean;
}
