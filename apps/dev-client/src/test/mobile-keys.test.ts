import { describe, expect, it } from 'vitest';
import {
  MOBILE_KEY_ROWS,
  NO_MODIFIERS,
  buttonPress,
  ctrlCodeForChar,
  resolveKeyboardKey,
  toggleModifier,
} from '../mobile-keys.js';

describe('mobile key bar data', () => {
  it('the first row carries the escape/interrupt keys a TUI needs', () => {
    const ids = MOBILE_KEY_ROWS[0].map((key) => key.id);
    expect(ids).toContain('esc');
    expect(ids).toContain('ctrlc');
    expect(MOBILE_KEY_ROWS[0].find((key) => key.id === 'esc')?.data).toBe('\x1b');
    expect(MOBILE_KEY_ROWS[0].find((key) => key.id === 'ctrlc')?.data).toBe('\x03');
  });

  it('every button carries a non-empty byte payload and a unique id', () => {
    const flat = MOBILE_KEY_ROWS.flat();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((key) => key.data.length > 0)).toBe(true);
    expect(new Set(flat.map((key) => key.id)).size).toBe(flat.length);
  });

  it('button presses send their own bytes and never touch modifiers', () => {
    const tab = MOBILE_KEY_ROWS[0].find((key) => key.id === 'tab')!;
    expect(buttonPress(tab)).toEqual({ data: '\t', consumed: false });
    const down = MOBILE_KEY_ROWS[1].find((key) => key.id === 'down')!;
    expect(buttonPress(down).data).toBe('\x1b[B');
  });
});

describe('ctrl code mapping', () => {
  it('maps letters to 1..26', () => {
    expect(ctrlCodeForChar('c')).toBe('\x03');
    expect(ctrlCodeForChar('C')).toBe('\x03');
    expect(ctrlCodeForChar('d')).toBe('\x04');
    expect(ctrlCodeForChar('z')).toBe('\x1a');
  });

  it('maps the bracket and control punctuation', () => {
    expect(ctrlCodeForChar('[')).toBe('\x1b');
    expect(ctrlCodeForChar(' ')).toBe('\x00');
    expect(ctrlCodeForChar('_')).toBe('\x1f');
    expect(ctrlCodeForChar('q')).not.toBeNull();
  });

  it('returns null for keys with no control form', () => {
    expect(ctrlCodeForChar('Enter')).toBeNull();
    expect(ctrlCodeForChar('5')).toBeNull();
  });
});

describe('sticky modifier state', () => {
  it('toggles one modifier while preserving the other', () => {
    expect(toggleModifier(NO_MODIFIERS, 'ctrl')).toEqual({ ctrl: true, alt: false });
    const withAlt = toggleModifier({ ctrl: true, alt: false }, 'alt');
    expect(withAlt).toEqual({ ctrl: true, alt: true });
    expect(toggleModifier(withAlt, 'ctrl')).toEqual({ ctrl: false, alt: true });
  });
});

describe('keyboard resolution with armed modifiers', () => {
  it('does nothing when no modifier is armed', () => {
    expect(resolveKeyboardKey('c', NO_MODIFIERS)).toEqual({ data: null, consumed: false });
  });

  it('ctrl armed turns a typed letter into its control byte', () => {
    expect(resolveKeyboardKey('c', { ctrl: true, alt: false })).toEqual({ data: '\x03', consumed: true });
    expect(resolveKeyboardKey('d', { ctrl: true, alt: false })).toEqual({ data: '\x04', consumed: true });
  });

  it('alt armed prefixes a letter with escape', () => {
    expect(resolveKeyboardKey('f', { ctrl: false, alt: true })).toEqual({ data: '\x1bf', consumed: true });
  });

  it('ctrl+alt combines escape with the control byte', () => {
    expect(resolveKeyboardKey('c', { ctrl: true, alt: true })).toEqual({ data: '\x1b\x03', consumed: true });
  });

  it('alt armed prefixes navigation keys', () => {
    expect(resolveKeyboardKey('ArrowRight', { ctrl: false, alt: true })).toEqual({ data: '\x1b[C', consumed: true });
  });

  it('spends the modifier and lets an unmapped key fall through', () => {
    expect(resolveKeyboardKey('Enter', { ctrl: true, alt: false })).toEqual({ data: null, consumed: true });
  });
});

describe('buttonPress with armed modifiers', () => {
  const left = { id: 'left', label: '←', title: '왼쪽', data: '\x1b[D' };
  const pgup = { id: 'pgup', label: 'PgUp', title: '페이지 위', data: '\x1b[5~' };
  const esc = { id: 'esc', label: 'Esc', title: 'Escape', data: '\x1b' };
  it('adds the xterm modifier parameter to cursor keys and spends the modifier', () => {
    expect(buttonPress(left, { ctrl: true, alt: false })).toEqual({ data: '\x1b[1;5D', consumed: true });
    expect(buttonPress(left, { ctrl: false, alt: true })).toEqual({ data: '\x1b[1;3D', consumed: true });
    expect(buttonPress(left, { ctrl: true, alt: true })).toEqual({ data: '\x1b[1;7D', consumed: true });
  });
  it('handles tilde keys', () => {
    expect(buttonPress(pgup, { ctrl: true, alt: false })).toEqual({ data: '\x1b[5;5~', consumed: true });
  });
  it('leaves fixed-meaning keys and unarmed presses untouched', () => {
    expect(buttonPress(esc, { ctrl: true, alt: false })).toEqual({ data: '\x1b', consumed: false });
    expect(buttonPress(left, { ctrl: false, alt: false })).toEqual({ data: '\x1b[D', consumed: false });
  });
});
