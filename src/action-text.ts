import {ControlConflict} from './control-error.ts';

/** CRLF is a newline; bare CR, terminal controls and invisible direction changes are ambiguous. */
export function unambiguousActionText(value: string): boolean {
  return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value.replace(/\r\n/g, '\n'));
}
// The canonical representation of allowed text is unchanged; existing safe v1 evidence remains valid.
export const ACTION_TEXT_VERSION = 1;
export function canonicalActionText(value: string): string {
  if (!unambiguousActionText(value))
    throw new ControlConflict('Ambiguous command control characters; no action approved. Obtain a lossless private capture and reviewed supported layout; never strip controls to approve it');
  return value.replace(/\r\n/g, '\n').trim();
}
