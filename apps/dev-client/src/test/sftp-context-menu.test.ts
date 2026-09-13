import { describe, expect, it } from 'vitest';
import { contextMenuItems } from '../sftp-context-menu.js';

const ids = (state: Parameters<typeof contextMenuItems>[0]) => contextMenuItems(state).map((i) => i.id);

describe('contextMenuItems', () => {
  it('offers open for a directory, download for a file', () => {
    expect(ids({ entry: { name: 'd', type: 'directory' }, selectionCount: 1, dual: false })).toContain('open');
    expect(ids({ entry: { name: 'f', type: 'file' }, selectionCount: 1, dual: false })).toContain('download');
    expect(ids({ entry: { name: 'd', type: 'directory' }, selectionCount: 1, dual: false })).not.toContain('download');
  });
  it('offers rename only for a single selection', () => {
    expect(ids({ entry: { name: 'f', type: 'file' }, selectionCount: 1, dual: false })).toContain('rename');
    expect(ids({ entry: { name: 'f', type: 'file' }, selectionCount: 3, dual: false })).not.toContain('rename');
  });
  it('offers cross-pane move only in dual mode', () => {
    expect(ids({ entry: { name: 'f', type: 'file' }, selectionCount: 1, dual: false })).not.toContain('move');
    expect(ids({ entry: { name: 'f', type: 'file' }, selectionCount: 1, dual: true })).toContain('move');
  });
  it('always ends with a delete action labelled by count', () => {
    const many = contextMenuItems({ entry: { name: 'f', type: 'file' }, selectionCount: 4, dual: false });
    expect(many.at(-1)).toMatchObject({ id: 'delete', danger: true, label: '4개 삭제' });
    const one = contextMenuItems({ entry: { name: 'f', type: 'file' }, selectionCount: 1, dual: false });
    expect(one.at(-1)).toMatchObject({ id: 'delete', danger: true, label: '삭제' });
  });
});
