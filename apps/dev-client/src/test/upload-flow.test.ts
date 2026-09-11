// Behavioral tests for the upload overwrite flow — defect #2.
//
// Proves: a NEW filename uploads exactly once immediately with overwrite=false;
// an EXISTING filename performs ZERO uploads until confirm() (which performs
// exactly one upload with overwrite=true); cancel performs nothing; and a single
// selection never uploads twice.

import { describe, it, expect } from 'vitest';
import { createUploadFlow } from '../upload-flow.js';

type Call = { name: string; overwrite: boolean };

function flowWithLog() {
  const calls: Call[] = [];
  const flow = createUploadFlow(async (file, overwrite) => {
    calls.push({ name: (file as { name: string }).name, overwrite });
  });
  return { calls, flow };
}

// A File object is only used for its `.name`; a plain object suffices.
const file = (name: string) => ({ name } as unknown as File);

describe('createUploadFlow', () => {
  it('new name: uploads once immediately with overwrite=false, no pending', async () => {
    const { calls, flow } = flowWithLog();
    const r = await flow.select(['alpha.txt'], file('beta.txt'));
    expect(r).toEqual({ overwrite: false });
    expect(calls).toEqual([{ name: 'beta.txt', overwrite: false }]);
    expect(flow.pendingName()).toBeNull();
  });

  it('existing name: uploads nothing until confirm, then once with overwrite=true', async () => {
    const { calls, flow } = flowWithLog();
    const r = await flow.select(['alpha.txt'], file('alpha.txt'));
    expect(r).toEqual({ overwrite: true });
    expect(calls).toEqual([]);                 // NO immediate overwrite upload
    expect(flow.pendingName()).toBe('alpha.txt');

    await flow.confirm();
    expect(calls).toEqual([{ name: 'alpha.txt', overwrite: true }]);
    expect(flow.pendingName()).toBeNull();
  });

  it('cancel: never uploads and clears the pending file', async () => {
    const { calls, flow } = flowWithLog();
    await flow.select(['alpha.txt'], file('alpha.txt'));
    flow.cancel();
    expect(flow.pendingName()).toBeNull();
    await flow.confirm();                       // nothing pending -> no-op
    expect(calls).toEqual([]);
  });

  it('confirm is idempotent: a double confirm performs exactly one upload', async () => {
    const { calls, flow } = flowWithLog();
    await flow.select(['alpha.txt'], file('alpha.txt'));
    await flow.confirm();
    await flow.confirm();
    expect(calls).toEqual([{ name: 'alpha.txt', overwrite: true }]);
  });

  it('a single existing-name selection performs exactly one upload (never twice)', async () => {
    const { calls, flow } = flowWithLog();
    const r = await flow.select(['alpha.txt'], file('alpha.txt'));
    if (r.overwrite) await flow.confirm();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'alpha.txt', overwrite: true });
  });

  it('a single new-name selection performs exactly one upload and needs no confirm', async () => {
    const { calls, flow } = flowWithLog();
    const r = await flow.select(['alpha.txt'], file('beta.txt'));
    if (r.overwrite) await flow.confirm();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'beta.txt', overwrite: false });
  });
});
