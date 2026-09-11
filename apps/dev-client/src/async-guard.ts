// In-flight (busy) guard for terminal/session actions.
//
// Terminal/session actions (refresh, create session, trust, attach, direct-mode
// connect) hit the network and must not be double-submitted. The guard runs at
// most one action at a time: a second call while one is in flight is skipped,
// and the busy flag is cleared whether the action resolves OR rejects. It is
// DOM-free so the reentrancy and error-clearing behavior is directly testable.

export type RunResult = 'ran' | 'skipped';

export interface ExclusiveRunner {
  /** True while an action is in flight. */
  isBusy(): boolean;
  /**
   * Run `fn` exclusively. Returns `'skipped'` if another action is in flight.
   * Otherwise sets busy, awaits `fn`, and clears busy even if `fn` throws.
   */
  run(fn: () => Promise<void>): Promise<RunResult>;
}

export function createExclusiveRunner(onChange: (busy: boolean) => void = () => {}): ExclusiveRunner {
  let busy = false;
  function set(b: boolean): void {
    if (busy === b) return;
    busy = b;
    onChange(b);
  }
  return {
    isBusy: () => busy,
    async run(fn: () => Promise<void>): Promise<RunResult> {
      if (busy) return 'skipped';
      set(true);
      try {
        await fn();
      } finally {
        set(false);
      }
      return 'ran';
    },
  };
}
