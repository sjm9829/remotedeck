// Mobile terminal special-key bar.
//
// Touch keyboards cannot send control bytes such as ESC or Ctrl+C, so a phone
// user has to tear down a whole session just to interrupt a program (for
// example to quit Codex).  This module defines the on-screen key bar and the
// "sticky modifier" logic that lets an armed Ctrl/Alt prefix a key typed on the
// on-screen keyboard.  All logic is pure and DOM-free so it can be unit-tested.

export interface MobileKey {
  id: string;
  label: string;
  title: string;
  /** Exact bytes written to the terminal as if the user typed them. */
  data: string;
}

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false };

/** Flip one modifier and keep the other, mirroring a sticky toggle button. */
export function toggleModifier(state: ModifierState, name: 'ctrl' | 'alt'): ModifierState {
  return name === 'ctrl' ? { ...state, ctrl: !state.ctrl } : { ...state, alt: !state.alt };
}

const ESC = '\x1b';

// Row 1: the keys needed to control/quit a full-screen TUI (Esc quits Codex).
// Row 2: editing and navigation keys a touch keyboard is missing.
export const MOBILE_KEY_ROWS: MobileKey[][] = [
  [
    { id: 'esc', label: 'Esc', title: 'Escape (화면 프로그램 종료)', data: ESC },
    { id: 'ctrlc', label: '^C', title: 'Ctrl+C (인터럽트)', data: '\x03' },
    { id: 'ctrld', label: '^D', title: 'Ctrl+D (EOF / logout)', data: '\x04' },
    { id: 'ctrll', label: '^L', title: 'Ctrl+L (화면 지움)', data: '\x0c' },
    { id: 'tab', label: 'Tab', title: 'Tab (자동완성)', data: '\t' },
  ],
  [
    { id: 'up', label: '\u2191', title: '위쪽', data: ESC + '[A' },
    { id: 'down', label: '\u2193', title: '아래쪽', data: ESC + '[B' },
    { id: 'right', label: '\u27a1', title: '오른쪽', data: ESC + '[C' },
    { id: 'left', label: '\u2b05', title: '왼쪽', data: ESC + '[D' },
    { id: 'pgup', label: 'PgUp', title: '페이지 위', data: ESC + '[5~' },
    { id: 'pgdn', label: 'PgDn', title: '페이지 아래', data: ESC + '[6~' },
    { id: 'home', label: 'Home', title: 'Home', data: ESC + '[H' },
    { id: 'end', label: 'End', title: 'End', data: ESC + '[F' },
  ],
];

/** Flat list for rendering convenience (rows remain for layout). */
export const MOBILE_KEYS: MobileKey[] = MOBILE_KEY_ROWS.flat();

const ARROW_SEQUENCES: Record<string, string> = {
  ArrowUp: '[A',
  ArrowDown: '[B',
  ArrowRight: '[C',
  ArrowLeft: '[D',
  Home: '[H',
  End: '[F',
  PageUp: '[5~',
  PageDown: '[6~',
};

/** The control byte for Ctrl+<ch>, or null when ch has no Ctrl form. */
export function ctrlCodeForChar(ch: string): string | null {
  const upper = ch.toUpperCase();
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
    return String.fromCharCode(upper.charCodeAt(0) - 64);
  }
  switch (ch) {
    case ' ':
    case '@':
    case '2':
      return '\x00';
    case '[':
      return ESC;
    case '\\':
      return '\x1c';
    case ']':
      return '\x1d';
    case '^':
      return '\x1e';
    case '_':
      return '\x1f';
    default:
      return null;
  }
}

export interface KeyResolution {
  /** Bytes to send, or null when the terminal should handle the key itself. */
  data: string | null;
  /** True when the armed modifier was spent and must be cleared. */
  consumed: boolean;
}

/** xterm modifier parameter: 1 + Alt(2) + Ctrl(4). */
function modifierParam(mods: ModifierState): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/**
 * A press of the on-screen bar sends the key's own bytes. When Ctrl/Alt is armed,
 * navigation keys carry the modifier (Ctrl+← word jump, Alt+↑ …) and spend it;
 * keys with a fixed meaning (Esc, ^C, Tab …) ignore the armed modifier.
 */
export function buttonPress(key: MobileKey, mods: ModifierState = NO_MODIFIERS): KeyResolution {
  if (!mods.ctrl && !mods.alt) return { data: key.data, consumed: false };
  const param = modifierParam(mods);
  const cursor = /^\x1b\[([ABCDHF])$/.exec(key.data);
  if (cursor) return { data: `${ESC}[1;${param}${cursor[1]}`, consumed: true };
  const tilde = /^\x1b\[(\d+)~$/.exec(key.data);
  if (tilde) return { data: `${ESC}[${tilde[1]};${param}~`, consumed: true };
  return { data: key.data, consumed: false };
}

/**
 * Resolve a physical/software keyboard key while Ctrl/Alt modifiers are armed.
 * The sticky modifier is always consumed by the next keypress (single-use),
 * so an unmapped key falls through to the terminal untouched.
 */
export function resolveKeyboardKey(key: string, mods: ModifierState): KeyResolution {
  if (!mods.ctrl && !mods.alt) return { data: null, consumed: false };

  // Ctrl alone (optionally with Alt) has a direct control code for many keys.
  if (mods.ctrl) {
    const ctrl = ctrlCodeForChar(key);
    if (ctrl !== null) {
      return { data: mods.alt ? ESC + ctrl : ctrl, consumed: true };
    }
  }

  // Alt+letter sends ESC followed by the letter (Meta/Alt in most shells).
  if (mods.alt && key.length === 1) {
    return { data: ESC + key, consumed: true };
  }

  // Alt+navigation sends an ESC-prefixed escape sequence.
  const arrow = ARROW_SEQUENCES[key];
  if (mods.alt && arrow) return { data: ESC + arrow, consumed: true };

  // Armed but nothing mappable: let the terminal handle it and drop the modifier.
  return { data: null, consumed: true };
}
