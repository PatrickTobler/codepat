/** Canonical form for pane-derived action text. Preserve command-significant whitespace. */
export const ACTION_TEXT_VERSION = 1;
export const canonicalActionText = (value: string): string =>
  value.replace(/\r\n/g, "\n").trim();
