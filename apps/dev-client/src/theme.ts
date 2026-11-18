// Light / dark theme, following the Workbench app.
//
// Framed inside the Workbench (same origin, /remotedeck/), RemoteDeck reads the
// Workbench's own choice from localStorage `workbench.theme` ('system' | 'light'
// | 'dark') and follows changes to it (storage event). Opened on its own, or
// with 'system', it follows the device (prefers-color-scheme).
//
// The resolved theme lands on <html data-theme>, where App.css switches its
// tokens; terminals ask terminalTheme() and subscribe to changes.

import type { ITheme } from '@xterm/xterm';

export type ResolvedTheme = 'light' | 'dark';

export const WORKBENCH_THEME_KEY = 'workbench.theme';

type Listener = (theme: ResolvedTheme) => void;
const listeners = new Set<Listener>();
let current: ResolvedTheme = 'dark';

function storedChoice(storage: Pick<Storage, 'getItem'> | null): 'system' | 'light' | 'dark' {
  try {
    const value = storage?.getItem(WORKBENCH_THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** The theme to use for a stored Workbench choice and the device preference. */
export function resolveTheme(choice: 'system' | 'light' | 'dark', prefersLight: boolean): ResolvedTheme {
  if (choice !== 'system') return choice;
  return prefersLight ? 'light' : 'dark';
}

function compute(): ResolvedTheme {
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  return resolveTheme(storedChoice(typeof localStorage === 'undefined' ? null : localStorage), prefersLight);
}

function apply(): void {
  const next = compute();
  document.documentElement.dataset.theme = next;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

export function currentTheme(): ResolvedTheme {
  return current;
}

/** Call once before the first render. */
export function initTheme(): void {
  current = compute();
  document.documentElement.dataset.theme = current;
  window.addEventListener('storage', (event) => { if (event.key === null || event.key === WORKBENCH_THEME_KEY) apply(); });
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', apply);
}

/** Runs `listener` whenever the resolved theme changes; returns the unsubscribe. */
export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const DARK: ITheme = {
  background: '#111113', foreground: '#ececee', cursor: '#9ec5ff', cursorAccent: '#111113',
  selectionBackground: '#9ec5ff40',
};

// ANSI colours chosen to stay readable on white (the xterm defaults are made for black).
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff',
  selectionBackground: '#0969da33',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};

export function terminalTheme(theme: ResolvedTheme = current): ITheme {
  return theme === 'light' ? LIGHT : DARK;
}
