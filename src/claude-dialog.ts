import { canonicalActionText, unambiguousActionText } from './action-text.ts';

/** Bounded Claude gutter layout. Selection is inspected separately from authorization. */
export function claudeGutterDialog(text: string): {action: string; selected?: string} | undefined {
  if (!unambiguousActionText(text)) return undefined;
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
  if (options.length !== 4) return undefined;
  const choices = options.map((line, index) => {
    const match = /^\s*([❯>›]\s*)?(\d+)[.)]\s+(.+?)\s*$/u.exec(line);
    return match && Number(match[2]) === index + 1 ? {selected: Boolean(match[1]), text: match[3]} : undefined;
  });
  if (choices.some(choice => !choice) || choices[0]!.text !== 'Yes' || choices[3]!.text !== 'No') return undefined;
  if (lines.slice(0, start).some(line => /^(?:\s*[│|]?\s*Bash command|\s*(?:Action|Command|Request):|\s*\$\s)/i.test(line))) return undefined;
  const selected = choices.filter(choice => choice!.selected);
  const action = canonicalActionText(command.join('\n'));
  return action ? {action, selected: selected.length === 1 && choices[0]!.selected ? 'yes' : undefined} : undefined;
}
