// Application-level WebSocket heartbeat with dead-connection detection.
//
// Browsers do not reliably report half-open sockets (mobile network switches,
// iOS suspending a background tab, idle reverse proxies). The client sends a
// `ping` frame on an interval and treats *any* inbound frame as proof of life.
// If nothing arrives for `deadAfterMs`, or a visibility probe goes unanswered,
// `onDead` fires once so the owner can tear the socket down and re-attach.

export interface HeartbeatOptions {
  send: () => void;
  onDead: () => void;
  intervalMs?: number;
  deadAfterMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  clearRepeat?: (handle: unknown) => void;
}

export interface Heartbeat {
  start(): void;
  stop(): void;
  /** Call for every inbound frame. */
  touch(): void;
  /** Ping now and declare the socket dead if nothing answers within `timeoutMs`. */
  probe(timeoutMs?: number): void;
}

export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? 20_000;
  const deadAfterMs = opts.deadAfterMs ?? 50_000;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setRepeat = opts.setRepeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearRepeat = opts.clearRepeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let repeat: unknown = null;
  let probeTimer: unknown = null;
  let lastSeen = now();
  let running = false;

  const clearProbe = () => { if (probeTimer !== null) { clearTimer(probeTimer); probeTimer = null; } };
  const dead = () => { if (!running) return; stop(); opts.onDead(); };
  const safeSend = () => { try { opts.send(); } catch { /* socket already gone; the dead check will catch it */ } };

  function tick(): void {
    if (!running) return;
    if (now() - lastSeen > deadAfterMs) { dead(); return; }
    safeSend();
  }

  function start(): void {
    stop();
    running = true;
    lastSeen = now();
    repeat = setRepeat(tick, intervalMs);
  }

  function stop(): void {
    running = false;
    if (repeat !== null) { clearRepeat(repeat); repeat = null; }
    clearProbe();
  }

  function touch(): void {
    lastSeen = now();
    clearProbe();
  }

  function probe(timeoutMs = 4_000): void {
    if (!running) return;
    clearProbe();
    safeSend();
    probeTimer = setTimer(() => { probeTimer = null; dead(); }, timeoutMs);
  }

  return { start, stop, touch, probe };
}
