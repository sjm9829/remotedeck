// Host folders, stored as a `folder:<name>` tag on the host.
//
// The server has no folder concept, but it persists tags and supports partial host
// updates, so a reserved tag gives folders that sync across every device for free
// and need no schema change. One folder per host; folders exist while a host uses them.

import type { Host } from '@remotedeck/types';

export const FOLDER_PREFIX = 'folder:';
const MAX_FOLDER_NAME = 40;

export function isFolderTag(tag: string): boolean {
  return tag.trim().toLocaleLowerCase().startsWith(FOLDER_PREFIX);
}

/** Make a user-typed folder name safe to store: single-spaced, no commas, bounded length. */
export function normalizeFolderName(name: string): string {
  return name.replace(/[,\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME).trim();
}

/** The host's folder name, or '' when it is not in a folder. */
export function folderOf(host: Pick<Host, 'tags'>): string {
  const tag = host.tags.find(isFolderTag);
  return tag ? normalizeFolderName(tag.trim().slice(FOLDER_PREFIX.length)) : '';
}

/** Tags a person should see and edit: everything except the folder marker. */
export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isFolderTag(tag));
}

/** Replace the folder marker in `tags` (an empty folder removes it); other tags are untouched. */
export function setFolderTag(tags: readonly string[], folder: string): string[] {
  const name = normalizeFolderName(folder);
  const rest = visibleTags(tags);
  return name ? [...rest, `${FOLDER_PREFIX}${name}`] : rest;
}

/** Rename `from` to `to` in a tag list; returns the same tags when the host is not in `from`. */
export function renameFolderTag(tags: readonly string[], from: string, to: string): string[] {
  const current = tags.find(isFolderTag);
  if (!current || normalizeFolderName(current.trim().slice(FOLDER_PREFIX.length)) !== from) return [...tags];
  return setFolderTag(tags, to);
}

export interface HostGroups<T extends Pick<Host, 'tags'>> {
  folders: { name: string; hosts: T[] }[];
  loose: T[];
}

/** Split an already-ordered host list into folders (alphabetical) and unfiled hosts, keeping the input order inside each. */
export function groupHosts<T extends Pick<Host, 'tags'>>(hosts: readonly T[]): HostGroups<T> {
  const byFolder = new Map<string, T[]>();
  const loose: T[] = [];
  for (const host of hosts) {
    const folder = folderOf(host);
    if (!folder) { loose.push(host); continue; }
    const bucket = byFolder.get(folder);
    if (bucket) bucket.push(host); else byFolder.set(folder, [host]);
  }
  const folders = [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map(([name, list]) => ({ name, hosts: list }));
  return { folders, loose };
}

/** Distinct folder names used by `hosts`, alphabetical (for the editor's suggestions). */
export function folderNames(hosts: readonly Pick<Host, 'tags'>[]): string[] {
  return groupHosts(hosts).folders.map((folder) => folder.name);
}
