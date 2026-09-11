// Terminal resize + lifecycle controller.
//
// The terminal area must call FitAddon.fit() whenever the layout changes
// (initial mount, tab switch, orientation change, container resize) and, when
// attached, send the new { rows, cols } over the session WebSocket.  All the
// listeners/observers it registers are owned by the returned `dispose()` so the
// React component can clean them up on unmount.
//
// It is extracted from <App/> and depends only on injected primitives so it can
// be unit-tested without a DOM.

export interface FitLike {
  fit(): void;
}

export interface Size {
  rows: number;
  cols: number;
}

export interface ResizeControllerOptions {
  fit: FitLike;
  /** Current cell size, read at the moment of a fit. */
  getSize: () => Size;
  /** Send a resize frame to the server. Optional (terminal may not be attached). */
  send?: (size: Size) => void;
  /** Container observed by the ResizeObserver (the terminal mount element). */
  target: Element;
  /** Injectable for tests; defaults to the global window. */
  win?: { addEventListener: typeof window.addEventListener; removeEventListener: typeof window.removeEventListener };
  /** Injectable ResizeObserver constructor for tests; defaults to global ResizeObserver. */
  ResizeObserverCtor?: typeof ResizeObserver;
}

export interface ResizeController {
  /** Fit once, then start watching for layout changes. */
  start(): void;
  /** Fit once (used on tab switch / orientation change). Best-effort. */
  fitNow(): void;
  /** Remove every listener/observer this controller registered. Idempotent. */
  dispose(): void;
}

export function createResizeController(opts: ResizeControllerOptions): ResizeController {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  const ROTor = opts.ResizeObserverCtor ??
    (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);

  let observer: { observe(target: Element): void; disconnect(): void } | null = null;
  let started = false;
  let last = '';

  // Fit, remember the resulting size, and (if attached) push the new geometry.
  function doFit(): void {
    try {
      opts.fit.fit();
    } catch {
      return; // not visible / not open yet
    }
    let size: Size;
    try {
      size = opts.getSize();
    } catch {
      return;
    }
    const key = `${size.rows}x${size.cols}`;
    if (key === last) return;
    last = key;
    if (opts.send) {
      try {
        opts.send(size);
      } catch {
        /* send failure is non-fatal for layout */
      }
    }
  }

  const onWinResize = () => doFit();

  function start(): void {
    if (started) return;
    started = true;
    doFit();
    win?.addEventListener('resize', onWinResize);
    win?.addEventListener('orientationchange', onWinResize);
    if (ROTor && opts.target) {
      const ob = new ROTor(() => doFit());
      ob.observe(opts.target);
      observer = ob;
    }
  }

  function fitNow(): void {
    doFit();
  }

  function dispose(): void {
    win?.removeEventListener('resize', onWinResize);
    win?.removeEventListener('orientationchange', onWinResize);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    started = false;
  }

  return { start, fitNow, dispose };
}
