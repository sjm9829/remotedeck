export interface BooleanRef {
  current: boolean;
}

export type DeferredScheduler = (run: () => void) => () => void;

/** Start the two halves together while preserving each pane's own error UI. */
export async function startWorkspaceConnections(
  connectSsh: () => Promise<unknown>,
  connectSftp: () => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled([connectSsh(), connectSftp()]);
}

const timeoutScheduler: DeferredScheduler = (run) => {
  const timer = window.setTimeout(run, 0);
  return () => window.clearTimeout(timer);
};

/**
 * Defer workspace connection until React has committed the mounted instance.
 * The first Strict Mode probe is cancelled during its cleanup; the shared ref
 * guarantees that any remaining callback starts the workspace only once.
 */
export function scheduleWorkspaceAutoStart(
  start: () => Promise<unknown> | unknown,
  started: BooleanRef,
  schedule: DeferredScheduler = timeoutScheduler,
): () => void {
  return schedule(() => {
    if (started.current) return;
    started.current = true;
    try {
      void Promise.resolve(start()).catch(() => undefined);
    } catch {
      // Connection state is rendered by the workspace; never retry on unmount.
    }
  });
}
