// Multi-selection model for a single SFTP file pane (DOM-free, unit-testable).
//
// A selection is the set of currently highlighted entry names plus an "anchor"
// used for shift-click range selection. All functions operate on the *visible,
// sorted* name list (the order shown to the user), so range and Ctrl+A behave
// exactly as they look on screen. Selection never performs an action itself.

export interface Selection {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const emptySelection: Selection = { selected: new Set<string>(), anchor: null };

export interface ClickModifiers {
  /** Ctrl/⌘: toggle this entry in the set (or start a new set if it is not a toggle of the current anchor). */
  additive?: boolean;
  /** Shift: extend a contiguous range from the anchor to this entry, replacing the set. */
  range?: boolean;
}

/** Apply a mouse click on `name` (present in `visible`) to `current`. */
export function selectEntry(
  visible: readonly string[],
  name: string,
  mods: ClickModifiers,
  current: Selection,
): Selection {
  if (mods.range) {
    if (current.anchor === null) return { selected: new Set([name]), anchor: name };
    const a = visible.indexOf(current.anchor);
    const b = visible.indexOf(name);
    if (a === -1 || b === -1) return { selected: new Set([name]), anchor: name };
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { selected: new Set(visible.slice(lo, hi + 1)), anchor: current.anchor };
  }
  if (mods.additive) {
    const next = new Set(current.selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return { selected: next, anchor: name };
  }
  return { selected: new Set([name]), anchor: name };
}

export function selectAll(names: readonly string[]): Selection {
  return { selected: new Set(names), anchor: names[0] ?? null };
}

export function clearSelection(): Selection {
  return emptySelection;
}

/** After a refresh, drop names that are no longer in `visible`; keep the anchor only if it survives. */
export function pruneSelection(sel: Selection, visible: readonly string[]): Selection {
  if (sel.selected.size === 0) return sel;
  const present = new Set(visible);
  const selected = new Set([...sel.selected].filter((n) => present.has(n)));
  const anchor = sel.anchor !== null && present.has(sel.anchor) ? sel.anchor : (selected.size === sel.selected.size ? sel.anchor : null);
  return { selected, anchor };
}

/** The selected names in visible (on-screen) order, used by bulk actions. */
export function selectedInOrder(sel: Selection, visible: readonly string[]): string[] {
  return visible.filter((n) => sel.selected.has(n));
}

export function selectionCount(sel: Selection): number {
  return sel.selected.size;
}

/** Move a single-selection cursor up (-1) or down (+1) across `visible`, clamped. */
export function moveCursor(visible: readonly string[], current: Selection, delta: number): Selection {
  if (visible.length === 0) return emptySelection;
  const index = current.anchor !== null ? visible.indexOf(current.anchor) : -1;
  let next = index;
  if (index === -1) next = delta > 0 ? 0 : visible.length - 1;
  else next = Math.min(visible.length - 1, Math.max(0, index + delta));
  return { selected: new Set([visible[next]]), anchor: visible[next] };
}
