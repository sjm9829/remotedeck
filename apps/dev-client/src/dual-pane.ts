// SFTP dual-pane (split window) presentation and transfer logic.
// DOM-free and unit-testable; App.tsx wires these into two side-by-side panes.

import { joinSftpPath, normalizeSftpPath } from './sftp-path.js';

export type PaneSide = 'a' | 'b';

/** The opposite pane, used by the cross-pane move action. */
export function otherSide(side: PaneSide): PaneSide {
  return side === 'a' ? 'b' : 'a';
}

// ---- Horizontal split width (fraction of width given to pane A) ----
export const MIN_SPLIT = 0.25;
export const MAX_SPLIT = 0.75;
export const DEFAULT_SPLIT = 0.5;

export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction));
}

/** Keyboard resize of the vertical divider. ArrowLeft widens A, ArrowRight narrows it. */
export function resizeSplitWithKey(fraction: number, key: string, step = 0.05): number {
  const current = clampSplit(fraction);
  if (key === 'ArrowLeft') return clampSplit(current + step);
  if (key === 'ArrowRight') return clampSplit(current - step);
  if (key === 'Home') return MIN_SPLIT;
  if (key === 'End') return MAX_SPLIT;
  return current;
}

/** True when `targetDir` is inside (a strict descendant of) `dir`. Root is ''. */
export function isDescendant(dir: string, targetDir: string): boolean {
  const base = normalizeSftpPath(dir);
  const target = normalizeSftpPath(targetDir);
  if (base === '') return target !== '';
  return target.startsWith(base + '/');
}

/** Produce an unused name by appending " (n)" when `name` already exists. */
export function uniqueName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export type MovePlan = { ok: true; from: string; to: string } | { ok: false; reason: 'same-dir' | 'into-subtree' };

/**
 * Plan a server-side move of `name` (a listing entry in `sourceDir`) into `destDir`.
 * Uses a rename; the destination name is de-conflicted with the target directory's
 * existing entries. Returns a reason instead of a plan when the move is a no-op
 * (same directory) or would move a directory into its own subtree.
 */
export function planMove(
  sourceDir: string,
  destDir: string,
  entry: { name: string; type: string },
  destExisting: readonly string[],
): MovePlan {
  const source = normalizeSftpPath(sourceDir);
  const dest = normalizeSftpPath(destDir);
  if (source === dest) return { ok: false, reason: 'same-dir' };
  if (entry.type === 'directory' && isDescendant(joinSftpPath(source, entry.name), dest)) {
    return { ok: false, reason: 'into-subtree' };
  }
  const from = joinSftpPath(source, entry.name);
  const to = joinSftpPath(dest, uniqueName(entry.name, destExisting));
  return { ok: true, from, to };
}
