import {readFileSync} from 'node:fs';

/** The same template and renderer used for the installed orchestrator instructions. */
export function renderOperatingPrompt(cliPath: string): string {
  return readFileSync(new URL('../CODEPAT.md', import.meta.url), 'utf8').replaceAll('{{CLI}}', cliPath);
}
