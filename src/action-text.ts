/** Canonical form for pane-derived action text. Preserve command-significant whitespace. */
export const canonicalActionText = (value: string): string =>
  value.replace(/\r\n/g, "\n").trim();
