/** Close one remote session at most once and never leak cleanup failures. */
export function closeRemoteSessionOnce(
  id: string,
  closedSessionIds: Set<string>,
  close: (id: string) => Promise<unknown> | unknown,
): boolean {
  if (!id || closedSessionIds.has(id)) return false;
  closedSessionIds.add(id);
  try {
    void Promise.resolve(close(id)).catch(() => undefined);
  } catch {
    // A cleanup failure is terminal for this unmount; do not retry forever.
  }
  return true;
}
