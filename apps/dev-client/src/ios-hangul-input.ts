// Korean (Hangul) input on iOS / iPadOS.
//
// Desktop browsers and Android compose Hangul through composition events, which
// xterm.js handles.  iOS Safari does not: its Korean keyboard inserts a jamo into
// the focused field and then *replaces* that character as the syllable grows
// (ㅎ -> 하 -> 한), with plain keydown/keypress/input events and no composition.
// xterm.js sends each key from `keypress` and cancels the insertion, so the field
// stays empty, iOS has nothing to combine with, and the shell receives ㅎ ㅏ ㄴ.
//
// The fix: for Hangul keys, keep xterm.js out of the way so iOS edits the hidden
// textarea normally, then mirror every change of the textarea to the terminal as
// "erase what was replaced (DEL) + type what is new".  The shell sees ㅎ, then
// DEL 하, then DEL 한 and ends up with 한.

const DEL = '\x7f';

/** True for a string made only of Hangul syllables / jamo (any block). */
export function isHangulText(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const hangul = (c >= 0xac00 && c <= 0xd7a3) // syllables
      || (c >= 0x3130 && c <= 0x318f) // compatibility jamo (what keyboards send)
      || (c >= 0x1100 && c <= 0x11ff) // jamo
      || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xd7b0 && c <= 0xd7ff); // extended jamo
    if (!hangul) return false;
  }
  return true;
}

/**
 * Bytes that turn what the terminal already received (`prev`) into `next`:
 * one DEL per character after the common prefix, then the new tail.
 */
export function inputDelta(prev: string, next: string): string {
  const a = Array.from(prev);
  const b = Array.from(next);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return DEL.repeat(a.length - same) + b.slice(same).join('');
}

/** iPhone / iPad, including iPadOS Safari which reports itself as a Mac. */
export function isIosDevice(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (!nav) return false;
  if (/iPad|iPhone|iPod/.test(nav.userAgent ?? '')) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

export interface KeyLike {
  key?: string;
  keyCode?: number;
  charCode?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  stopPropagation(): void;
}

export interface InputLike {
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
  stopPropagation(): void;
}

export interface HangulComposerOptions {
  /** The field iOS types into (xterm's hidden textarea). */
  textarea: { value: string };
  /** Deliver bytes to the shell as user input. */
  send: (data: string) => void;
  /** Skip while a sticky Ctrl/Alt from the key bar is armed. */
  modifiersArmed?: () => boolean;
}

export interface HangulComposer {
  /** Each handler returns true when it took the event away from xterm.js. */
  keydown(event: KeyLike): boolean;
  keypress(event: KeyLike): boolean;
  input(event: InputLike): boolean;
  /** A real composition started (another IME): hand the field back to xterm.js. */
  compositionstart(): void;
  /** Forget the syllable in progress (focus lost, terminal reset). */
  reset(): void;
}

// Edits that the Korean keyboard produces while a syllable is being built.
const OWNED_INPUT_TYPES = new Set(['insertText', 'insertReplacementText', 'deleteContentBackward']);
// Safety valve: the field is emptied at every non-Hangul key, so this is never hit in practice.
const MAX_TRACKED_CHARS = 512;

/**
 * State machine, free of DOM access so it can be unit-tested.  The handlers must be
 * registered in the capture phase on an ancestor of the textarea: stopPropagation()
 * there keeps the event from xterm.js while the browser still performs the edit.
 */
export function createHangulComposer(opts: HangulComposerOptions): HangulComposer {
  const { textarea, send } = opts;
  let tracking = false; // true while the textarea holds text mirrored to the shell
  let mirrored = ''; // what the shell has received for the current textarea content

  const begin = (): void => { if (!tracking) { tracking = true; mirrored = textarea.value; } };
  const reset = (): void => {
    if (!tracking && !textarea.value) return;
    tracking = false; mirrored = '';
    // Emptying the field also ends the keyboard's syllable, so the next jamo starts fresh.
    textarea.value = '';
  };
  const usesModifier = (event: KeyLike): boolean => Boolean(event.ctrlKey || event.altKey || event.metaKey) || Boolean(opts.modifiersArmed?.());

  return {
    keydown(event) {
      if (event.isComposing) return false; // a real composition: xterm.js handles it
      // 229 is the "handled by the keyboard" key code: the character only shows up in the
      // input event that follows, so the field must be left to the browser as well.
      if (!usesModifier(event) && (isHangulText(event.key) || event.keyCode === 229)) {
        begin();
        event.stopPropagation();
        return true;
      }
      // Any other key (space, Enter, arrows, Backspace, Latin letters) ends the syllable.
      // xterm.js handles the key itself; a Backspace therefore erases the whole syllable.
      reset();
      return false;
    },
    keypress(event) {
      if (event.isComposing || usesModifier(event)) return false;
      const char = event.charCode ? String.fromCodePoint(event.charCode) : event.key;
      if (!isHangulText(char)) return false;
      begin();
      event.stopPropagation(); // not cancelled: the browser inserts the jamo into the field
      return true;
    },
    input(event) {
      if (event.isComposing || event.inputType === 'insertCompositionText') return false;
      const owned = OWNED_INPUT_TYPES.has(event.inputType ?? '');
      if (!tracking) {
        // No keydown was seen (some keyboards skip it): adopt a Hangul insertion as it arrives.
        if (!owned || !isHangulText(event.data)) return false;
        const value = textarea.value;
        const data = event.data ?? '';
        tracking = true;
        mirrored = value.endsWith(data) ? value.slice(0, value.length - data.length) : '';
      } else if (!owned) {
        // A paste, cut or drop went into the field through another path: resynchronise only.
        mirrored = textarea.value;
        return false;
      }
      event.stopPropagation();
      const value = textarea.value;
      const delta = inputDelta(mirrored, value);
      mirrored = value;
      if (delta) send(delta);
      if (Array.from(value).length > MAX_TRACKED_CHARS) reset();
      return true;
    },
    compositionstart() { tracking = false; mirrored = ''; },
    reset,
  };
}

/** Wire a composer to a terminal's DOM. Returns a dispose function. */
export function attachHangulComposer(root: HTMLElement, textarea: HTMLTextAreaElement, opts: Omit<HangulComposerOptions, 'textarea'>): () => void {
  const composer = createHangulComposer({ textarea, ...opts });
  const onKeyDown = (event: KeyboardEvent): void => { composer.keydown(event); };
  const onKeyPress = (event: KeyboardEvent): void => { composer.keypress(event); };
  const onInput = (event: Event): void => { composer.input(event as InputEvent); };
  const onBlur = (): void => composer.reset();
  const onCompositionStart = (): void => composer.compositionstart();
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('keypress', onKeyPress, true);
  root.addEventListener('input', onInput, true);
  textarea.addEventListener('blur', onBlur);
  root.addEventListener('compositionstart', onCompositionStart, true);
  return () => {
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('keypress', onKeyPress, true);
    root.removeEventListener('input', onInput, true);
    textarea.removeEventListener('blur', onBlur);
    root.removeEventListener('compositionstart', onCompositionStart, true);
  };
}
