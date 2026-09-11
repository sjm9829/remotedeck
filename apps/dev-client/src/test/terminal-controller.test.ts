// Unit tests for the extracted terminal resize/lifecycle controller.
// Runs in the node environment (no DOM): the window and ResizeObserver are
// injected as fakes so registration AND cleanup are directly observable.

import { describe, it, expect } from 'vitest';
import { createResizeController } from '../terminal-controller.js';

type Handler = (...args: any[]) => void;

function fakeWindow() {
  const handlers = new Map<string, Handler[]>();
  const win = {
    addEventListener(type: string, fn: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: Handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  const fire = (type: string) => (handlers.get(type) ?? []).forEach((f) => f());
  const count = (type: string) => (handlers.get(type) ?? []).length;
  return { win: win as unknown as Window, fire, count };
}

function fakeObserver() {
  let instances = 0;
  let disconnected = 0;
  let observed: unknown[] = [];
  class RO {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; instances++; }
    observe(el: unknown) { observed.push(el); }
    disconnect() { disconnected++; }
    trigger() { this.cb(); }
  }
  return {
    ctor: RO as unknown as typeof ResizeObserver,
    get instances() { return instances; },
    get disconnected() { return disconnected; },
    get observed() { return observed; },
  };
}

describe('createResizeController', () => {
  it('start() registers resize + orientationchange listeners, observes target, and fits once', () => {
    let fits = 0;
    const { win, count } = fakeWindow();
    const ro = fakeObserver();
    const target = {};
    const c = createResizeController({
      fit: { fit: () => { fits++; } },
      getSize: () => ({ rows: 24, cols: 80 }),
      target: target as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });

    c.start();

    expect(count('resize')).toBe(1);
    expect(count('orientationchange')).toBe(1);
    expect(ro.instances).toBe(1);
    expect(ro.observed).toContain(target);
    expect(fits).toBe(1); // initial fit
    c.dispose();
  });

  it('dispose() removes every listener and disconnects the observer', () => {
    const { win, count } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => {} },
      getSize: () => ({ rows: 24, cols: 80 }),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start();
    expect(count('resize')).toBe(1);
    expect(ro.instances).toBe(1);

    c.dispose();

    expect(count('resize')).toBe(0);
    expect(count('orientationchange')).toBe(0);
    expect(ro.disconnected).toBe(1);
  });

  it('dispose() is idempotent — a second call does not double-disconnect', () => {
    const { win } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => {} },
      getSize: () => ({ rows: 24, cols: 80 }),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start();
    c.dispose();
    c.dispose();
    expect(ro.disconnected).toBe(1);
  });

  it('a resize event fits again and sends the new geometry only when it changed', () => {
    let fits = 0;
    const sent: Array<{ rows: number; cols: number }> = [];
    let size = { rows: 24, cols: 80 };
    const { win, fire } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => { fits++; } },
      getSize: () => size,
      send: (s) => sent.push(s),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start(); // fit once, sends 24x80 (first key)
    expect(fits).toBe(1);
    expect(sent).toEqual([{ rows: 24, cols: 80 }]);

    fire('resize'); // same size -> fit but no duplicate send
    expect(fits).toBe(2);
    expect(sent.length).toBe(1);

    size = { rows: 30, cols: 100 };
    fire('resize'); // changed -> fit + send
    expect(fits).toBe(3);
    expect(sent).toEqual([{ rows: 24, cols: 80 }, { rows: 30, cols: 100 }]);

    // ResizeObserver callback also fits
    fire('resize');
    c.dispose();
  });

  it('orientationchange triggers a fit', () => {
    let fits = 0;
    const { win, fire } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => { fits++; } },
      getSize: () => ({ rows: 24, cols: 80 }),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start();
    const before = fits;
    fire('orientationchange');
    expect(fits).toBe(before + 1);
    c.dispose();
  });

  it('fitNow() fits on demand (used on tab switch)', () => {
    let fits = 0;
    const { win } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => { fits++; } },
      getSize: () => ({ rows: 24, cols: 80 }),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start();
    const before = fits;
    c.fitNow();
    expect(fits).toBe(before + 1);
    c.dispose();
  });

  it('a fit that throws is swallowed and never sends', () => {
    const sent: unknown[] = [];
    const { win } = fakeWindow();
    const ro = fakeObserver();
    const c = createResizeController({
      fit: { fit: () => { throw new Error('not visible'); } },
      getSize: () => ({ rows: 24, cols: 80 }),
      send: (s) => sent.push(s),
      target: {} as Element,
      win,
      ResizeObserverCtor: ro.ctor,
    });
    c.start();
    c.fitNow();
    expect(sent).toEqual([]);
    c.dispose();
  });
});
