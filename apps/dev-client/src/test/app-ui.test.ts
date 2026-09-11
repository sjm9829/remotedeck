// SSR UI tests for the production <App/>.
//
// `import.meta.env.VITE_REMOTEDECK_MODE` is set per-test so the build-time
// `DEV_DIRECT` flag resolves the same way Vite would inline it. xterm and the
// SDK are stubbed at module load. Effects do not run under renderToString, so
// no WebSocket/terminal side effects occur here.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {} open() {} write() {} writeln() {} reset() {} dispose() {} onData() {}
    rows = 24; cols = 80;
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@remotedeck/client-sdk', () => ({
  RemoteDeckClient: class {
    status() { return Promise.resolve({ sessions: { total: 0 } }); }
    listHosts() { return Promise.resolve([]); }
  },
}));

const SAME_ORIGIN_ENV = { VITE_REMOTEDECK_MODE: 'same-origin', VITE_REMOTEDECK_BASE: '/remotedeck/' };
const DIRECT_ENV = { VITE_REMOTEDECK_MODE: 'direct' };

async function render(env: Record<string, string>): Promise<string> {
  // Replace import.meta.env contents so App's DEV_DIRECT constant resolves.
  for (const k of Object.keys(import.meta.env)) delete (import.meta.env as any)[k];
  Object.assign(import.meta.env, env);

  vi.doMock('./config.js', () => ({
    resolveConfig: () =>
      env.VITE_REMOTEDECK_MODE === 'direct'
        ? { mode: 'direct', baseUrl: '' }
        : { mode: 'same-origin', baseUrl: (env.VITE_REMOTEDECK_BASE ?? '/').replace(/\/+$/, '') },
  }));
  vi.resetModules();

  const { App } = await import('../App.js');
  const { renderToString } = await import('react-dom/server');
  return renderToString((await import('react')).createElement(App));
}

describe('App — same-origin (production) UI contract', () => {
  it('renders no API/token credential inputs', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).not.toContain('aria-label="API base"');
    expect(html).not.toContain('aria-label="API token"');
    expect(html).not.toMatch(/API (base|token)/);
  });

  it('renders no demo mutation strings', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).not.toContain('dev-secret');
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('Add credential');
    expect(html).not.toContain('Add host');
    expect(html.toLowerCase()).not.toContain('dev client');
  });

  it('renders as an embedded tool without a redundant product header', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).not.toContain('<header');
    expect(html).not.toContain('HomeLab Console');
    expect(html).not.toContain('href="/"');
    expect(html).toContain('aria-label="저장된 호스트"');
    expect(html).toContain('aria-label="호스트 검색"');
    expect(html).toContain('+ 호스트');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="서버 세션"');
    expect(html).toContain('더블클릭 또는 ＋로 새 탭');
  });

  it('provides accessible labels on the primary controls', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).toContain('aria-label="저장된 호스트"');
    expect(html).toContain('aria-label="원격 작업 공간"');
    expect(html).toContain('aria-label="호스트 새로고침"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-controls="rd-host-drawer"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('온라인 상태 아님');
    expect(html).toContain('접속 가능 여부가 아니라 저장된 호스트 키의 검증 상태');
  });

  it('renders terminal and SFTP together and keeps an inactive workspace mounted', async () => {
    await render(SAME_ORIGIN_ENV);
    const { WorkspacePane } = await import('../App.js');
    const React = await import('react');
    const { renderToString } = await import('react-dom/server');
    const host = {
      id: 'h1', name: 'K6', hostname: 'k6.internal', port: 22, username: 'operator',
      credentialId: null, tags: ['compute'], hostKeyFingerprint: null, hostKeyTrusted: false,
      createdAt: '', updatedAt: '',
    };
    const client = {} as any;
    const html = renderToString(React.createElement(React.Fragment, null,
      React.createElement(WorkspacePane, { tab: { id: 'tab-1', hostId: 'h1', label: 'K6 · 1', sessionId: null, sftpSessionId: null }, host, client, active: true }),
      React.createElement(WorkspacePane, { tab: { id: 'tab-2', hostId: 'h1', label: 'K6 · 2', sessionId: null, sftpSessionId: null }, host, client, active: false }),
    ));
    expect(html).toContain('aria-label="K6 SFTP 파일"');
    expect(html).toContain('aria-label="K6 터미널"');
    expect(html.indexOf('aria-label="K6 터미널"')).toBeLessThan(html.indexOf('aria-label="K6 SFTP 파일"'));
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-label="K6 작업 보기"');
    expect(html).toContain('data-mobile-view="terminal"');
    expect(html).toContain('data-ssh-collapsed="false"');
    expect(html).toContain('data-sftp-collapsed="false"');
    expect(html).toContain('aria-label="SSH 접기"');
    expect(html).toContain('aria-label="SFTP 접기"');
    expect(html).not.toContain('SSH + SFTP 연결');
    expect(html).not.toContain('SSH 해제');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('data-workspace-id="tab-1"');
    expect(html).toMatch(/aria-label="K6 · 2 작업 공간"[^>]*hidden=""[^>]*data-workspace-id="tab-2"/);
  });
});

describe('App — destructive-confirm modals (renderToString)', () => {
  // Overwrite (destructive) and delete confirmations must NOT render until the
  // user triggers them — proving uploads/deletes never auto-confirm at idle.
  it('renders no overwrite / delete / prompt dialogs at idle', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).not.toContain('aria-label="덮어쓰기 확인"');
    expect(html).not.toContain('aria-label="삭제 확인"');
    expect(html).not.toContain('aria-label="새 폴더 이름"');
  });

  it('offers host creation from the empty workspace', async () => {
    const html = await render(SAME_ORIGIN_ENV);
    expect(html).toContain('첫 호스트 추가</button>');
    expect(html).toContain('+ 호스트</button>');
  });
});

describe('App — direct (dev) UI contract', () => {
  it('renders the API base + token inputs only in direct mode', async () => {
    const html = await render(DIRECT_ENV);
    expect(html).toContain('aria-label="API base"');
    expect(html).toContain('aria-label="API token"');
    // Still a real Workbench client (no demo mutations or standalone product chrome)
    expect(html).not.toContain('<header');
    expect(html).not.toContain('dev-secret');
    expect(html).not.toContain('example.com');
  });
});
