// Right-click context-menu actions for one SFTP entry (DOM-free, unit-testable).
//
// Produces the ordered, enabled menu items for `entry` given the pane state.
// Mirrors FileZilla / MobaXterm conventions: "open" only for directories,
// "rename" only when exactly one row is selected, transfer actions only for
// files, and the cross-pane actions only when the split (dual) view is on.

export interface ContextEntry { name: string; type: string }

export type ContextActionId =
  | 'open'
  | 'download'
  | 'rename'
  | 'move'
  | 'delete';

export interface ContextItem {
  id: ContextActionId;
  label: string;
  danger?: boolean;
}

export interface ContextMenuState {
  /** The entry under the cursor. */
  entry: ContextEntry;
  /** How many rows are currently selected (the clicked row counts as >=1). */
  selectionCount: number;
  /** True when the split (two-pane) view is active. */
  dual: boolean;
}

export function contextMenuItems(state: ContextMenuState): ContextItem[] {
  const { entry, selectionCount, dual } = state;
  const single = selectionCount === 1;
  const items: ContextItem[] = [];
  if (entry.type === 'directory') items.push({ id: 'open', label: '열기' });
  else items.push({ id: 'download', label: '다운로드' });
  if (single) items.push({ id: 'rename', label: '이름 변경' });
  if (dual) items.push({ id: 'move', label: '다른 창으로 이동' });
  items.push({ id: 'delete', label: selectionCount > 1 ? `${selectionCount}개 삭제` : '삭제', danger: true });
  return items;
}
