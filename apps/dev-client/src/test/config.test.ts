// config.test.ts — tests the real resolveConfig() implementation and verifies
// that same-origin mode produces a UI without credential inputs.
//
// What is tested (with the actual implementation, no duplicated logic):
//   1. resolveConfig() with env: 'direct' mode → mode='direct', baseUrl=''
//   2. resolveConfig() with env: 'same-origin' → mode='same-origin', correct baseUrl
//   3. resolveConfig() with env: missing mode → 'same-origin' (fail-safe)
//   4. resolveConfig() with env: invalid mode → 'same-origin' (fail-safe)
//   5. resolveConfig() with env: '/remotedeck/' base normalisation
//   6. App renders NO token/API-base inputs when mode='same-origin'
//   7. App renders token/API-base inputs when mode='direct'

import { describe, it, expect, vi } from 'vitest';
import { resolveConfig } from '../config.js';

// ── resolveConfig unit tests (imports the real implementation) ───────────────

describe('resolveConfig()', () => {
  it('explicit direct mode → mode=direct, baseUrl empty', () => {
    const cfg = resolveConfig({ VITE_REMOTEDECK_MODE: 'direct' });
    expect(cfg.mode).toBe('direct');
    expect(cfg.baseUrl).toBe('');
  });

  it('explicit same-origin mode with sub-path → baseUrl = /remotedeck', () => {
    const cfg = resolveConfig({
      VITE_REMOTEDECK_MODE: 'same-origin',
      VITE_REMOTEDECK_BASE: '/remotedeck/',
    });
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('/remotedeck');
  });

  it('same-origin with root base → baseUrl empty string', () => {
    const cfg = resolveConfig({
      VITE_REMOTEDECK_MODE: 'same-origin',
      VITE_REMOTEDECK_BASE: '/',
    });
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('');
  });

  it('same-origin with BASE_URL fallback → strips trailing slash', () => {
    const cfg = resolveConfig({
      VITE_REMOTEDECK_MODE: 'same-origin',
      BASE_URL: '/remotedeck/',
    });
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('/remotedeck');
  });

  it('missing mode → same-origin (fail-safe)', () => {
    const cfg = resolveConfig({});
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('');  // defaults to root
  });

  it('invalid mode → same-origin (fail-safe)', () => {
    const cfg = resolveConfig({ VITE_REMOTEDECK_MODE: 'garbage' });
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('');
  });

  it('invalid mode with base → same-origin with correct baseUrl', () => {
    const cfg = resolveConfig({
      VITE_REMOTEDECK_MODE: 'typo-mode',
      VITE_REMOTEDECK_BASE: '/remotedeck/',
    });
    expect(cfg.mode).toBe('same-origin');
    expect(cfg.baseUrl).toBe('/remotedeck');
  });

  it('/remotedeck/ with multiple trailing slashes → single-strip', () => {
    const cfg = resolveConfig({
      VITE_REMOTEDECK_MODE: 'same-origin',
      VITE_REMOTEDECK_BASE: '/remotedeck///',
    });
    expect(cfg.baseUrl).toBe('/remotedeck');
  });
});

// ── UI rendering: same-origin hides credential inputs ──────────────────────
//
// The <App/> gates its dev credential inputs on the build-time constant
// `import.meta.env.VITE_REMOTEDECK_MODE === 'direct'` so that a same-origin
// production build dead-code-eliminates them entirely (the token never reaches
// the bundle). We therefore set import.meta.env per-test — exactly how Vite
// would inline it at build time — in addition to stubbing config + xterm, and
// assert the credential <input> elements are absent in same-origin mode and
// present in direct mode.

describe('App credential UI (renderToString)', () => {
  function setupMocks(env: Record<string, string>) {
    for (const k of Object.keys(import.meta.env)) delete (import.meta.env as any)[k];
    Object.assign(import.meta.env, env);
    vi.doMock('../config.js', () => ({
      resolveConfig: () =>
        env.VITE_REMOTEDECK_MODE === 'direct'
          ? { mode: 'direct', baseUrl: '' }
          : { mode: 'same-origin', baseUrl: '/remotedeck' },
    }));
    vi.doMock('@xterm/xterm', () => ({
      Terminal: class {
        loadAddon() {} open() {} write() {} writeln() {} reset() {} dispose() {} onData() {}
        rows = 24; cols = 80;
      },
    }));
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
  }

  it('same-origin mode: no API base / token inputs rendered', async () => {
    vi.resetModules();
    setupMocks({ VITE_REMOTEDECK_MODE: 'same-origin', VITE_REMOTEDECK_BASE: '/remotedeck/' });

    const { App } = await import('../App.js');
    const { renderToString } = await import('react-dom/server');
    const html = renderToString((await import('react')).createElement(App));

    // Credential inputs must NOT be present
    expect(html).not.toContain('aria-label="API base"');
    expect(html).not.toContain('aria-label="API token"');
  });

  it('direct mode: API base and token inputs ARE rendered', async () => {
    vi.resetModules();
    setupMocks({ VITE_REMOTEDECK_MODE: 'direct' });

    const { App } = await import('../App.js');
    const { renderToString } = await import('react-dom/server');
    const html = renderToString((await import('react')).createElement(App));

    expect(html).toContain('aria-label="API base"');
    expect(html).toContain('aria-label="API token"');
  });
});
