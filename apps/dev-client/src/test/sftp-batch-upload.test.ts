import { describe, expect, it } from 'vitest';
import { createBatchUploadFlow } from '../sftp-batch-upload.js';

type F = { name: string };
const nameOf = (f: F) => f.name;

describe('batch upload flow', () => {
  it('uploads only brand-new names immediately, parking conflicts', async () => {
    const calls: { name: string; overwrite: boolean }[] = [];
    const flow = createBatchUploadFlow<F>(nameOf, async (f, overwrite) => { calls.push({ name: f.name, overwrite }); });
    const result = flow.add(['existing.txt'], [{ name: 'a.txt' }, { name: 'existing.txt' }]);
    await Promise.resolve();
    expect(result).toEqual({ uploaded: 1, conflicts: ['existing.txt'] });
    expect(calls).toEqual([{ name: 'a.txt', overwrite: false }]);
    expect(flow.pendingNames()).toEqual(['existing.txt']);
  });

  it('confirmAll re-uploads every parked file once, with overwrite', async () => {
    const calls: { name: string; overwrite: boolean }[] = [];
    const flow = createBatchUploadFlow<F>(nameOf, async (f, overwrite) => { calls.push({ name: f.name, overwrite }); });
    flow.add(['x'], [{ name: 'x' }, { name: 'y' }]);
    await flow.confirmAll();
    expect(calls).toEqual([{ name: 'y', overwrite: false }, { name: 'x', overwrite: true }]);
    expect(flow.pendingNames()).toEqual([]);
  });

  it('cancel discards parked files without uploading them', async () => {
    const calls: string[] = [];
    const flow = createBatchUploadFlow<F>(nameOf, async (f, overwrite) => { calls.push(`${f.name}:${overwrite}`); });
    flow.add(['x'], [{ name: 'x' }]);
    flow.cancel();
    await flow.confirmAll();
    expect(calls).toEqual([]);
  });

  it('never uploads the same parked file twice across confirm', async () => {
    let count = 0;
    const flow = createBatchUploadFlow<F>(nameOf, async () => { count += 1; });
    flow.add(['x'], [{ name: 'x' }]);
    await flow.confirmAll();
    await flow.confirmAll();
    expect(count).toBe(1);
  });
});
