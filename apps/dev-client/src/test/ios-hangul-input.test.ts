import { describe, expect, it } from 'vitest';
import { createHangulComposer, inputDelta, isHangulText, isIosDevice, type InputLike, type KeyLike } from '../ios-hangul-input.js';

const DEL = '\x7f';

// A tiny model of the iOS Korean keyboard typing into xterm's hidden textarea:
// an event that the composer leaves alone reaches "xterm", which sends the key itself
// and cancels the insertion; an event the composer takes is applied to the field.
function harness() {
  const textarea = { value: '' };
  const sent: string[] = [];
  let armed = false;
  const composer = createHangulComposer({ textarea, send: (d) => sent.push(d), modifiersArmed: () => armed });
  const ev = <T extends object>(props: T): T & { stopped: boolean; stopPropagation(): void } => ({ ...props, stopped: false, stopPropagation() { this.stopped = true; } });
  /** One key press that makes the field become `next` (insert or replace-last). */
  function type(key: string, next: string, opts: { keyCode?: number; replace?: boolean } = {}): void {
    const down = ev<KeyLike>({ key, keyCode: opts.keyCode ?? 71 } as KeyLike);
    composer.keydown(down);
    const press = ev<KeyLike>({ key, charCode: key.codePointAt(0) } as KeyLike);
    const tookPress = composer.keypress(press);
    if (!tookPress) { sent.push(`xterm:${key}`); return; } // xterm.js sent it and cancelled the insertion
    if (opts.replace) {
      textarea.value = textarea.value.slice(0, -1);
      composer.input(ev<InputLike>({ inputType: 'deleteContentBackward', data: null } as InputLike));
    }
    textarea.value = next;
    composer.input(ev<InputLike>({ inputType: 'insertText', data: next.slice(-1) } as InputLike));
  }
  function plainKey(key: string, keyCode: number): void {
    const down = ev<KeyLike>({ key, keyCode } as KeyLike);
    if (!composer.keydown(down)) sent.push(`xterm:${key}`);
  }
  /** What a shell line editor holds after receiving everything sent so far. */
  function shellLine(): string {
    let line: string[] = [];
    for (const chunk of sent) {
      if (chunk.startsWith('xterm:')) { const k = chunk.slice(6); if (k === 'Backspace') line.pop(); else if (k === 'Enter') line = []; else line.push(k); continue; }
      for (const ch of chunk) { if (ch === DEL) line.pop(); else line.push(ch); }
    }
    return line.join('');
  }
  return { textarea, sent, composer, type, plainKey, shellLine, arm: (v: boolean) => { armed = v; } };
}

describe('inputDelta', () => {
  it('types an appended tail', () => { expect(inputDelta('', 'ㅎ')).toBe('ㅎ'); expect(inputDelta('한', '한ㄱ')).toBe('ㄱ'); });
  it('erases the replaced character then types the new one', () => { expect(inputDelta('ㅎ', '하')).toBe(DEL + '하'); expect(inputDelta('한', '하나')).toBe(DEL + '하나'); });
  it('erases only what was removed', () => { expect(inputDelta('한글', '한')).toBe(DEL); expect(inputDelta('한', '한')).toBe(''); });
  it('counts characters, not UTF-16 units', () => { expect(inputDelta('😀', 'ㅎ')).toBe(DEL + 'ㅎ'); });
});

describe('isHangulText', () => {
  it('accepts jamo and syllables only', () => {
    expect(isHangulText('ㅎ')).toBe(true); expect(isHangulText('한글')).toBe(true); expect(isHangulText('ㅏ')).toBe(true);
    expect(isHangulText('a')).toBe(false); expect(isHangulText('한a')).toBe(false); expect(isHangulText('')).toBe(false); expect(isHangulText('Enter')).toBe(false);
  });
});

describe('isIosDevice', () => {
  it('detects iPhone, iPad and iPadOS desktop-class Safari', () => {
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 10 })).toBe(false);
  });
});

describe('Hangul composer', () => {
  it('builds 한글 from jamo instead of sending ㅎㅏㄴㄱㅡㄹ', () => {
    const h = harness();
    h.type('ㅎ', 'ㅎ'); h.type('ㅏ', '하', { replace: true }); h.type('ㄴ', '한', { replace: true });
    h.type('ㄱ', '한ㄱ'); h.type('ㅡ', '한그', { replace: true }); h.type('ㄹ', '한글', { replace: true });
    expect(h.shellLine()).toBe('한글');
    expect(h.sent.some((c) => c.startsWith('xterm:'))).toBe(false);
  });

  it('moves a final consonant to the next syllable (한 + ㅏ -> 하나)', () => {
    const h = harness();
    h.type('ㅎ', 'ㅎ'); h.type('ㅏ', '하', { replace: true }); h.type('ㄴ', '한', { replace: true });
    h.textarea.value = '하나';
    h.composer.keydown({ key: 'ㅏ', keyCode: 75, stopPropagation() {} });
    h.composer.input({ inputType: 'insertReplacementText', data: '하나', stopPropagation() {} });
    expect(h.shellLine()).toBe('하나');
  });

  it('works when the key code is 229 and the key name is not the character', () => {
    const h = harness();
    for (const [next, replace] of [['ㅎ', false], ['하', true], ['한', true]] as const) {
      h.composer.keydown({ key: 'Unidentified', keyCode: 229, stopPropagation() {} });
      h.textarea.value = next;
      h.composer.input({ inputType: replace ? 'insertReplacementText' : 'insertText', data: next, stopPropagation() {} });
    }
    expect(h.shellLine()).toBe('한');
  });

  it('adopts a Hangul insertion that arrives without any keydown', () => {
    const h = harness();
    h.textarea.value = 'ㅎ';
    expect(h.composer.input({ inputType: 'insertText', data: 'ㅎ', stopPropagation() {} })).toBe(true);
    h.textarea.value = '하';
    h.composer.input({ inputType: 'insertReplacementText', data: '하', stopPropagation() {} });
    expect(h.shellLine()).toBe('하');
  });

  it('a space or Enter ends the syllable and is left to xterm.js', () => {
    const h = harness();
    h.type('ㅎ', 'ㅎ'); h.type('ㅏ', '하', { replace: true });
    h.plainKey(' ', 32);
    expect(h.textarea.value).toBe('');
    h.type('ㄴ', 'ㄴ'); // must start a new syllable, not turn 하 into 한
    expect(h.shellLine()).toBe('하 ㄴ');
    h.plainKey('Enter', 13);
    expect(h.textarea.value).toBe('');
  });

  it('Backspace is handled by xterm.js and erases the syllable in progress', () => {
    const h = harness();
    h.type('ㅎ', 'ㅎ'); h.type('ㅏ', '하', { replace: true });
    h.plainKey('Backspace', 8);
    expect(h.shellLine()).toBe('');
    h.type('ㄱ', 'ㄱ');
    expect(h.shellLine()).toBe('ㄱ');
  });

  it('leaves Latin keys, modifier chords and armed sticky modifiers to xterm.js', () => {
    const h = harness();
    h.type('a', 'a');
    expect(h.sent).toEqual(['xterm:a']);
    const chord = { key: 'ㅊ', keyCode: 67, ctrlKey: true, stopped: false, stopPropagation() { this.stopped = true; } };
    expect(h.composer.keydown(chord)).toBe(false);
    expect(chord.stopped).toBe(false);
    h.arm(true);
    expect(h.composer.keydown({ key: 'ㅊ', keyCode: 67, stopPropagation() {} })).toBe(false);
  });

  it('does not touch real compositions (other IMEs) or pastes', () => {
    const h = harness();
    expect(h.composer.keydown({ key: 'ㅎ', keyCode: 229, isComposing: true, stopPropagation() {} })).toBe(false);
    expect(h.composer.input({ inputType: 'insertCompositionText', data: 'ㅎ', isComposing: true, stopPropagation() {} })).toBe(false);
    h.textarea.value = '붙여넣기';
    expect(h.composer.input({ inputType: 'insertFromPaste', data: '붙여넣기', stopPropagation() {} })).toBe(false);
    expect(h.sent).toEqual([]);
    // A composition that starts after a 229 keydown hands the field back.
    h.composer.keydown({ key: 'Process', keyCode: 229, stopPropagation() {} });
    h.composer.compositionstart();
    h.textarea.value = 'に';
    expect(h.composer.input({ inputType: 'insertCompositionText', data: 'に', stopPropagation() {} })).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('reset (blur) forgets the syllable', () => {
    const h = harness();
    h.type('ㅎ', 'ㅎ');
    h.composer.reset();
    expect(h.textarea.value).toBe('');
    h.type('ㅏ', 'ㅏ');
    expect(h.shellLine()).toBe('ㅎㅏ');
  });
});
