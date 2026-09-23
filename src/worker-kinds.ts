import type { WorkerKind } from './state.ts';

/** Validate before probing CLIs; installation alone never enables a provider. */
export function configuredWorkerKinds(value: string | undefined): WorkerKind[] {
  const kinds = (value ?? 'codex,claude').split(',').map(kind => kind.trim());
  if (kinds.some(kind => !['codex', 'claude', 'grok'].includes(kind)))
    throw new Error('CODEPAT_WORKER_KINDS must be a nonempty comma-separated list of codex, claude, grok');
  return [...new Set(kinds)] as WorkerKind[];
}

export async function availableWorkerKinds(
  configured: WorkerKind[],
  installed: (kind: WorkerKind) => Promise<boolean>,
): Promise<WorkerKind[]> {
  const available: WorkerKind[] = [];
  for (const kind of configured) if (await installed(kind)) available.push(kind);
  return available;
}
