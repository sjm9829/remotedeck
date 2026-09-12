import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, clampSplit, isDescendant, otherSide,
  planMove, resizeSplitWithKey, uniqueName,
} from '../dual-pane.js';

describe('pane identity', () => {
  it('maps a to b and back', () => {
    expect(otherSide('a')).toBe('b');
    expect(otherSide('b')).toBe('a');
  });
});

describe('split width', () => {
  it('clamps within bounds', () => {
    expect(clampSplit(DEFAULT_SPLIT)).toBe(0.5);
    expect(clampSplit(0)).toBe(MIN_SPLIT);
    expect(clampSplit(1)).toBe(MAX_SPLIT);
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
  });
  it('resizes with keyboard, widening A on ArrowLeft', () => {
    expect(resizeSplitWithKey(0.5, 'ArrowLeft')).toBeCloseTo(0.55);
    expect(resizeSplitWithKey(0.5, 'ArrowRight')).toBeCloseTo(0.45);
    expect(resizeSplitWithKey(0.5, 'Home')).toBe(MIN_SPLIT);
    expect(resizeSplitWithKey(0.5, 'End')).toBe(MAX_SPLIT);
    expect(resizeSplitWithKey(0.5, 'a')).toBe(0.5);
    // never exceeds bounds
    expect(resizeSplitWithKey(MAX_SPLIT, 'ArrowLeft')).toBe(MAX_SPLIT);
  });
});

describe('isDescendant', () => {
  it('treats every non-root path as inside the root', () => {
    expect(isDescendant('', 'a/b')).toBe(true);
    expect(isDescendant('', '')).toBe(false);
  });
  it('detects subtree nesting', () => {
    expect(isDescendant('a', 'a/b/c')).toBe(true);
    expect(isDescendant('a', 'a')).toBe(false);
    expect(isDescendant('a', 'ab/c')).toBe(false); // sibling prefix, not nested
    expect(isDescendant('a/b', 'a')).toBe(false);
  });
});

describe('uniqueName', () => {
  it('keeps a free name and suffixes collisions', () => {
    expect(uniqueName('report.pdf', ['a.txt', 'b.txt'])).toBe('report.pdf');
    expect(uniqueName('report.pdf', ['report.pdf'])).toBe('report (1).pdf');
    expect(uniqueName('report.pdf', ['report.pdf', 'report (1).pdf'])).toBe('report (2).pdf');
  });
  it('suffixes extension-less names before the number', () => {
    expect(uniqueName('notes', ['notes'])).toBe('notes (1)');
    expect(uniqueName('notes', ['notes', 'notes (1)'])).toBe('notes (2)');
  });
  it('does not treat leading-dot dotfiles as extensions', () => {
    expect(uniqueName('.env', ['.env'])).toBe('.env (1)');
  });
});

describe('planMove', () => {
  it('rejects moving within the same directory', () => {
    expect(planMove('a/b', 'a/b', { name: 'x', type: 'file' }, [])).toEqual({ ok: false, reason: 'same-dir' });
    // root '' and '/' normalize to the same directory
    expect(planMove('', '/', { name: 'x', type: 'file' }, [])).toEqual({ ok: false, reason: 'same-dir' });
  });
  it('plans a file move and de-conflicts the destination name', () => {
    const p = planMove('left', 'right', { name: 'a.txt', type: 'file' }, ['a.txt']);
    expect(p).toEqual({ ok: true, from: 'left/a.txt', to: 'right/a (1).txt' });
  });
  it('plans a plain move when the destination name is free', () => {
    expect(planMove('left', 'right', { name: 'a.txt', type: 'file' }, ['other']))
      .toEqual({ ok: true, from: 'left/a.txt', to: 'right/a.txt' });
  });
  it('blocks moving a directory into its own subtree', () => {
    expect(planMove('', 'proj/build', { name: 'proj', type: 'directory' }, []))
      .toEqual({ ok: false, reason: 'into-subtree' });
    expect(planMove('a', 'a/x/inner', { name: 'x', type: 'directory' }, []))
      .toEqual({ ok: false, reason: 'into-subtree' });
  });
  it('allows moving a directory into a sibling subdirectory', () => {
    // a/sub is not inside a/x, so the move is valid: a/x -> a/sub/x
    expect(planMove('a', 'a/sub', { name: 'x', type: 'directory' }, []))
      .toEqual({ ok: true, from: 'a/x', to: 'a/sub/x' });
  });
  it('allows moving a directory into an unrelated directory', () => {
    expect(planMove('a', 'b', { name: 'x', type: 'directory' }, []))
      .toEqual({ ok: true, from: 'a/x', to: 'b/x' });
  });
  it('moves into the root from a subdir', () => {
    expect(planMove('a/b', '', { name: 'f', type: 'file' }, []))
      .toEqual({ ok: true, from: 'a/b/f', to: 'f' });
  });
});
