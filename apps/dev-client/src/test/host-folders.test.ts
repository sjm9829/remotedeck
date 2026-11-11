import { describe, expect, it } from 'vitest';
import { folderNames, folderOf, groupHosts, isFolderTag, normalizeFolderName, renameFolderTag, setFolderTag, visibleTags } from '../host-folders.js';

const h = (name: string, tags: string[]) => ({ name, tags });

describe('host folders', () => {
  it('reads the folder from a reserved tag', () => {
    expect(folderOf(h('a', ['x', 'folder:Homelab']))).toBe('Homelab');
    expect(folderOf(h('a', ['Folder: Lab  Net ']))).toBe('Lab Net');
    expect(folderOf(h('a', ['x']))).toBe('');
    expect(folderOf(h('a', ['folder:']))).toBe('');
  });
  it('hides the marker from the editable tags', () => {
    expect(visibleTags(['a', 'folder:X', 'archived'])).toEqual(['a', 'archived']);
    expect(isFolderTag(' FOLDER:x')).toBe(true);
    expect(isFolderTag('folders')).toBe(false);
  });
  it('sets, replaces and clears the folder without touching other tags', () => {
    expect(setFolderTag(['a'], 'Homelab')).toEqual(['a', 'folder:Homelab']);
    expect(setFolderTag(['a', 'folder:Old'], 'New')).toEqual(['a', 'folder:New']);
    expect(setFolderTag(['a', 'folder:Old'], '  ')).toEqual(['a']);
    expect(setFolderTag(['folder:A', 'folder:B'], 'C')).toEqual(['folder:C']);
  });
  it('sanitizes folder names', () => {
    expect(normalizeFolderName('  a,\n b\t c ')).toBe('a b c');
    expect(normalizeFolderName('x'.repeat(80))).toHaveLength(40);
  });
  it('renames only hosts that are in the source folder', () => {
    expect(renameFolderTag(['a', 'folder:Old'], 'Old', 'New')).toEqual(['a', 'folder:New']);
    expect(renameFolderTag(['a', 'folder:Other'], 'Old', 'New')).toEqual(['a', 'folder:Other']);
    expect(renameFolderTag(['a'], 'Old', 'New')).toEqual(['a']);
  });
  it('groups hosts into alphabetical folders and keeps input order inside', () => {
    const hosts = [h('z', []), h('b2', ['folder:B']), h('a1', ['folder:A']), h('b1', ['folder:B']), h('y', ['archived'])];
    const groups = groupHosts(hosts);
    expect(groups.folders.map((f) => f.name)).toEqual(['A', 'B']);
    expect(groups.folders[1].hosts.map((x) => x.name)).toEqual(['b2', 'b1']);
    expect(groups.loose.map((x) => x.name)).toEqual(['z', 'y']);
    expect(folderNames(hosts)).toEqual(['A', 'B']);
    expect(groupHosts([])).toEqual({ folders: [], loose: [] });
  });
});
