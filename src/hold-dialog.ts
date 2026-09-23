import { recognizedDialog } from './routine-approval.ts';
import { claudeGutterDialog } from './claude-dialog.ts';

export function inspectHoldDialog(text: string): {action: string} | undefined {
  const parsed = recognizedDialog(text) ?? claudeGutterDialog(text);
  return parsed ? {action: parsed.action} : undefined;
}
