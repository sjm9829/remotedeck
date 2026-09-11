// Behavioral tests for the exclusive in-flight (busy) runner — defect #3.
//
// Proves: only one action runs at a time (a concurrent submit is skipped), the
// busy flag is exposed to the UI observer, and a rejecting action still clears
// the busy flag (so the UI never gets stuck "busy" after an error).

import { describe, it, expect } from 'vitest';
import { createExclusiveRunner } from '../async-guard.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createExclusiveRunner', () => {
  it('runs an action and reports not-busy before and after', async () => {
    const seen: boolean[] = [];
    const r = createExclusiveRunner((b) => seen.push(b));
    expect(r.isBusy()).toBe(false);
    const res = await r.run(async () => { expect(r.isBusy()).toBe(true); });
    expect(res).toBe('ran');
    expect(r.isBusy()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('skips a second submit while the first is in flight', async () => {
    let calls = 0;
    const d = deferred();
    const r = createExclusiveRunner();
    const first = r.run(async () => { calls++; await d.promise; });
    // busy is now true; a concurrent submit must be skipped
    expect(r.isBusy()).toBe(true);
    const second = await r.run(async () => { calls++; });
    expect(second).toBe('skipped');
    expect(calls).toBe(1);
    d.resolve();
    expect(await first).toBe('ran');
    expect(r.isBusy()).toBe(false);
  });

  it('clears busy when the action rejects', async () => {
    const seen: boolean[] = [];
    const r = createExclusiveRunner((b) => seen.push(b));
    await expect(
      r.run(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(r.isBusy()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('allows a new action after the previous one finished', async () => {
    const r = createExclusiveRunner();
    await r.run(async () => {});
    expect(await r.run(async () => {})).toBe('ran');
  });
});
