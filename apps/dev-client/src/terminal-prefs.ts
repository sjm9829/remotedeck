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

export function loadFontSize(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fontSize?: unknown };
    return typeof parsed.fontSize === 'number' && Number.isFinite(parsed.fontSize) ? clampFontSize(parsed.fontSize) : null;
  } catch {
    return null;
  }
}

export function saveFontSize(size: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: clampFontSize(size) }));
  } catch {
    // Private browsing or quota: the preference simply does not persist.
  }
}
