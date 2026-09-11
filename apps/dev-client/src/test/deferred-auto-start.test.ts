import { describe, expect, it, vi } from 'vitest';
import { scheduleWorkspaceAutoStart, startWorkspaceConnections, type DeferredScheduler } from '../deferred-auto-start.js';

function manualScheduler() {
  const tasks: Array<{ cancelled: boolean; run: () => void }> = [];
  const schedule: DeferredScheduler = (run) => {
    const task = { cancelled: false, run };
    tasks.push(task);
    return () => { task.cancelled = true; };
  };
  return { schedule, flush: () => tasks.forEach((task) => { if (!task.cancelled) task.run(); }) };
}

describe('workspace deferred auto-start', () => {
  it('starts SSH and SFTP exactly once and lets each own its failure state', async () => {
    const ssh = vi.fn(async () => { throw new Error('ssh unavailable'); });
    const sftp = vi.fn(async () => undefined);
    await expect(startWorkspaceConnections(ssh, sftp)).resolves.toBeUndefined();
    expect(ssh).toHaveBeenCalledTimes(1);
    expect(sftp).toHaveBeenCalledTimes(1);
  });

  it('cancels the Strict Mode probe and starts SSH + SFTP once after remount', async () => {
    const queue = manualScheduler();
    const started = { current: false };
    const start = vi.fn(async () => undefined);

    const cancelProbe = scheduleWorkspaceAutoStart(start, started, queue.schedule);
    cancelProbe();
    scheduleWorkspaceAutoStart(start, started, queue.schedule);
    queue.flush();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not start after a real unmount before the deferred callback', () => {
    const queue = manualScheduler();
    const start = vi.fn();
    const cancel = scheduleWorkspaceAutoStart(start, { current: false }, queue.schedule);
    cancel();
    queue.flush();
    expect(start).not.toHaveBeenCalled();
  });

  it('guards duplicate scheduler delivery and absorbs a failed start', async () => {
    const started = { current: false };
    const start = vi.fn(() => Promise.reject(new Error('connection failed')));
    const schedule: DeferredScheduler = (run) => { run(); run(); return () => undefined; };
    expect(() => scheduleWorkspaceAutoStart(start, started, schedule)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
