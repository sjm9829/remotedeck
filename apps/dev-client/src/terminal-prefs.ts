// Terminal presentation preferences (font size) and constants.
//
// Preferences live in localStorage so they persist per browser/device: a phone and a
// desktop legitimately want different sizes. Nothing sensitive is stored here.

import type { RemoteDeckLayout } from './responsive-layout.js';

export const FONT_MIN = 10;
export const FONT_MAX = 24;
export const TERMINAL_SCROLLBACK = 10_000;

/** System monospace stacks first; CJK-capable monospaces keep Korean cells aligned. */
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Roboto Mono", "D2Coding", "Noto Sans Mono CJK KR", ui-monospace, monospace';

const STORAGE_KEY = 'remotedeck:prefs:v1';

export function defaultFontSize(layout: RemoteDeckLayout): number {
  return layout === 'mobile' ? 13 : 14;
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return 14;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
}

export function stepFontSize(current: number, delta: number): number {
  return clampFontSize(current + delta);
}

type Prefs = { fontSize?: unknown; dock?: unknown };

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Prefs) : {};
  } catch {
    return {};
  }
}

function writePrefs(update: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPrefs(), ...update }));
  } catch {
    // Private browsing or quota: the preference simply does not persist.
  }
}

export function loadFontSize(): number | null {
  const { fontSize } = readPrefs();
  return typeof fontSize === 'number' && Number.isFinite(fontSize) ? clampFontSize(fontSize) : null;
}

export function saveFontSize(size: number): void {
  writePrefs({ fontSize: clampFontSize(size) });
}

export type SftpDock = 'right' | 'bottom';

export function loadDock(): SftpDock | null {
  const { dock } = readPrefs();
  return dock === 'right' || dock === 'bottom' ? dock : null;
}

export function saveDock(dock: SftpDock): void {
  writePrefs({ dock });
}
