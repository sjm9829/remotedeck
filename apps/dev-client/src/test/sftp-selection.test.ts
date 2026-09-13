import { describe, expect, it } from 'vitest';
import {
  clearSelection, emptySelection, moveCursor, pruneSelection, selectAll, selectEntry,
  selectedInOrder, selectionCount,
} from '../sftp-selection.js';

const V = ['a', 'b', 'c', 'd', 'e'];

describe('selectEntry', () => {
  it('plain click selects only the clicked entry', () => {
    const out = selectEntry(V, 'c', {}, { selected: new Set(['a', 'b']), anchor: 'a' });
    expect([...out.selected]).toEqual(['c']);
    expect(out.anchor).toBe('c');
  });
  it('ctrl toggles an entry in and out of the set', () => {
    const added = selectEntry(V, 'd', { additive: true }, { selected: new Set(['a']), anchor: 'a' });
    expect([...added.selected].sort()).toEqual(['a', 'd']);
    expect(added.anchor).toBe('d');
    const removed = selectEntry(V, 'a', { additive: true }, added);
    expect([...removed.selected]).toEqual(['d']);
  });
  it('shift selects a contiguous visible range anchored at the start', () => {
    const out = selectEntry(V, 'd', { range: true }, { selected: new Set(['b']), anchor: 'b' });
    expect(selectedInOrder(out, V)).toEqual(['b', 'c', 'd']);
    expect(out.anchor).toBe('b');
  });
  it('shift with no anchor selects just the target', () => {
    const out = selectEntry(V, 'd', { range: true }, emptySelection);
    expect([...out.selected]).toEqual(['d']);
  });
  it('shift falls back to a single select when the anchor is gone', () => {
    const out = selectEntry(V, 'c', { range: true }, { selected: new Set(['z']), anchor: 'z' });
    expect([...out.selected]).toEqual(['c']);
  });
});

describe('selectAll / clear', () => {
  it('selects every visible entry', () => {
    expect(selectionCount(selectAll(V))).toBe(5);
  });
  it('clearing yields an empty selection', () => {
    expect(selectionCount(clearSelection())).toBe(0);
  });
});

describe('pruneSelection', () => {
  it('drops entries removed by a refresh and clears a lost anchor', () => {
    const out = pruneSelection({ selected: new Set(['a', 'b']), anchor: 'b' }, ['a', 'c']);
    expect([...out.selected]).toEqual(['a']);
    expect(out.anchor).toBeNull();
  });
  it('keeps a surviving anchor', () => {
    const out = pruneSelection({ selected: new Set(['a', 'b']), anchor: 'b' }, ['a', 'b', 'd']);
    expect(out.anchor).toBe('b');
    expect([...out.selected].sort()).toEqual(['a', 'b']);
  });
});

describe('selectedInOrder', () => {
  it('returns names in on-screen order regardless of click order', () => {
    const sel = { selected: new Set(['e', 'a', 'c']), anchor: 'e' };
    expect(selectedInOrder(sel, V)).toEqual(['a', 'c', 'e']);
  });
});

describe('moveCursor', () => {
  it('starts at the first entry from an empty selection when moving down', () => {
    expect(moveCursor(V, emptySelection, +1).anchor).toBe('a');
  });
  it('starts at the last entry when moving up from empty', () => {
    expect(moveCursor(V, emptySelection, -1).anchor).toBe('e');
  });
  it('steps down and clamps at the end', () => {
    expect(moveCursor(V, { selected: new Set(['b']), anchor: 'b' }, +1).anchor).toBe('c');
    expect(moveCursor(V, { selected: new Set(['e']), anchor: 'e' }, +1).anchor).toBe('e');
  });
  it('clamps at the top', () => {
    expect(moveCursor(V, { selected: new Set(['a']), anchor: 'a' }, -1).anchor).toBe('a');
  });
  it('on an empty list returns an empty selection', () => {
    expect(selectionCount(moveCursor([], emptySelection, +1))).toBe(0);
  });
});
