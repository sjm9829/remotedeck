import { describe, expect, it, vi } from 'vitest';
import { createHeartbeat } from '../heartbeat.js';

function setup(opts: { interval?: number; deadAfter?: number } = {}) {
  let t = 0;
  const repeats: { fn: () => void; ms: number; id: number }[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const send = vi.fn(); const onDead = vi.fn();
  const hb = createHeartbeat({
    send, onDead, intervalMs: opts.interval ?? 100, deadAfterMs: opts.deadAfter ?? 250, now: () => t,
    setRepeat: (fn, ms) => { const id = nextId++; repeats.push({ fn, ms, id }); return id; },
    clearRepeat: (h) => { const i = repeats.findIndex((r) => r.id === h); if (i >= 0) repeats.splice(i, 1); },
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((r) => r.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  return { hb, send, onDead, repeats, timers, advance: (ms: number) => { t += ms; } };
}

describe('heartbeat', () => {
  it('pings on every tick while frames keep arriving', () => {
    const h = setup(); h.hb.start();
    for (let i = 0; i < 5; i++) { h.advance(100); h.hb.touch(); h.repeats[0].fn(); }
    expect(h.send).toHaveBeenCalledTimes(5);
    expect(h.onDead).not.toHaveBeenCalled();
  });
  it('declares the socket dead once after deadAfterMs of silence and stops', () => {
    const h = setup(); h.hb.start();
    h.advance(100); h.repeats[0].fn();
    h.advance(100); h.repeats[0].fn();
    h.advance(100); h.repeats[0].fn();
    expect(h.onDead).toHaveBeenCalledTimes(1);
    expect(h.repeats).toHaveLength(0);
  });
  it('a probe that is answered cancels the dead timer', () => {
    const h = setup(); h.hb.start();
    h.hb.probe(40);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.hb.touch();
    expect(h.timers).toHaveLength(0);
    expect(h.onDead).not.toHaveBeenCalled();
  });
  it('an unanswered probe fires onDead', () => {
    const h = setup(); h.hb.start();
    h.hb.probe(40);
    h.timers[0].fn();
    expect(h.onDead).toHaveBeenCalledTimes(1);
  });
  it('is inert after stop and survives a throwing send', () => {
    const h = setup(); h.hb.start(); h.hb.stop();
    h.hb.probe(); expect(h.send).not.toHaveBeenCalled();
    const bad = setup(); bad.send.mockImplementation(() => { throw new Error('closed'); });
    bad.hb.start(); expect(() => bad.repeats[0].fn()).not.toThrow();
  });
});
