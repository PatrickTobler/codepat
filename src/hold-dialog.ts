import { recognizedDialog } from './routine-approval.ts';
import { canonicalActionText } from './action-text.ts';

/** Inspection only. Supporting a layout here does not authorize an approval key. */
export function inspectHoldDialog(text: string): {action: string} | undefined {
  const existing = recognizedDialog(text);
  if (existing) return existing;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headers = lines.flatMap((line, i) => /^\s*Bash command\s*$/.test(line) ? [i] : []);
  const prompts = lines.flatMap((line, i) => /^\s*Do you want to proceed\?\s*$/.test(line) ? [i] : []);
  if (headers.length !== 1 || prompts.length !== 1) return undefined;
  const start = headers[0], end = prompts[0];
  if (end <= start) return undefined;
  let i = start + 1;
  const blank = () => { while (i < end && !lines[i].trim()) i++; };
  blank();
  if (lines[i]?.trim() !== 'Tip: auto mode handles these prompts for you') return undefined;
  i++; blank();
  const command: string[] = [];
  // Exactly the observed provider gutter; never trim command continuation lines.
  while (i < end && lines[i].startsWith('   │ ')) command.push(lines[i++].slice(5));
  if (!command.length) return undefined;
  blank();
  // One unboxed provider description, separated from the command by the gutter.
  if (i >= end || !/^   [^│|\s].*$/.test(lines[i]) || lines[i].trim() === 'This command requires approval') return undefined;
  i++; blank();
  if (lines[i]?.trim() !== 'This command requires approval') return undefined;
  i++; blank();
  if (i !== end) return undefined;
  const options = lines.slice(end + 1).filter(line => line.trim());
  if (!options.length || !options.every(line => /^\s*(?:[❯>›]\s*)?\d+[.)]\s+.+$/u.test(line))) return undefined;
  const action = canonicalActionText(command.join('\n'));
  return action ? {action} : undefined;
}
