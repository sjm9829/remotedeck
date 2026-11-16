import { describe, expect, it, vi } from 'vitest';
import { bufferText, copyText, imageFilesFrom, isPasteShortcut, parseOsc52, pasteCarriesImage, pasteImageName, readClipboard } from '../terminal-clipboard.js';

const png = () => new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });

describe('pasteImageName', () => {
  it('is timestamped, unique-suffixed and shell-safe', () => {
    const name = pasteImageName('image/png', new Date(2026, 10, 16, 14, 3, 9), 0, () => 0.5);
    expect(name).toBe('remotedeck-paste-20261116-140309-8000.png');
    expect(pasteImageName('image/jpeg', new Date(2026, 0, 2, 3, 4, 5), 1, () => 0)).toBe('remotedeck-paste-20260102-030405-0000-2.jpg');
    expect(pasteImageName('image/x-unknown', new Date(), 0)).toMatch(/^[A-Za-z0-9.-]+\.png$/);
  });
});

describe('paste detection', () => {
  it('picks image files only', () => {
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(imageFilesFrom({ files: [png(), text] })).toHaveLength(1);
    expect(imageFilesFrom(null)).toEqual([]);
  });
  it('an image-only paste is an image; text next to an image stays text', () => {
    expect(pasteCarriesImage({ files: [png()], types: ['Files'] })).toBe(true);
    expect(pasteCarriesImage({ files: [png()], types: ['text/html', 'Files'] })).toBe(true);
    expect(pasteCarriesImage({ files: [png()], types: ['text/plain', 'text/html', 'Files'] })).toBe(false);
    expect(pasteCarriesImage({ files: [], types: ['text/plain'] })).toBe(false);
  });
});

describe('readClipboard', () => {
  const item = (map: Record<string, Blob>) => ({ types: Object.keys(map), getType: (t: string) => Promise.resolve(map[t]) });
  it('returns images from the clipboard', async () => {
    const res = await readClipboard({ read: async () => [item({ 'image/png': new Blob([new Uint8Array(4)], { type: 'image/png' }) })] }, () => new Date(2026, 10, 16, 1, 2, 3));
    expect(res.unavailable).toBe(false);
    expect(res.images).toHaveLength(1);
    expect(res.images[0].type).toBe('image/png');
    expect(res.images[0].name).toMatch(/^remotedeck-paste-20261116-010203-[0-9a-f]{4}\.png$/);
  });
  it('prefers text when present', async () => {
    const res = await readClipboard({ read: async () => [item({ 'text/plain': new Blob(['hello']), 'image/png': new Blob([new Uint8Array(1)]) })] });
    expect(res).toEqual({ images: [], text: 'hello', unavailable: false });
  });
  it('falls back to readText, and reports an unreadable clipboard', async () => {
    expect(await readClipboard({ read: async () => { throw new Error('denied'); }, readText: async () => 'abc' })).toEqual({ images: [], text: 'abc', unavailable: false });
    expect(await readClipboard({ readText: async () => { throw new Error('denied'); } })).toEqual({ images: [], text: '', unavailable: true });
    expect(await readClipboard(undefined)).toEqual({ images: [], text: '', unavailable: true });
  });
});

describe('copyText', () => {
  // Minimal document: records the temporary textarea and what the copy command saw.
  function fakeDocument(result: boolean) {
    const state = { copied: [] as string[], attached: 0, refocused: 0 };
    const doc = {
      activeElement: { focus: () => { state.refocused++; } },
      body: { appendChild: () => { state.attached++; } },
      createElement: () => {
        const area = { value: '', style: { cssText: '' }, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { state.attached--; } };
        (doc as any).current = area;
        return area;
      },
      execCommand: (command: string) => { if (command === 'copy') state.copied.push((doc as any).current.value); return result; },
    };
    return { doc: doc as unknown as Document, state };
  }
  it('uses the clipboard API when available', async () => {
    const writeText = vi.fn(async () => undefined);
    const { doc, state } = fakeDocument(true);
    expect(await copyText('hi', doc, { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(state.copied).toEqual([]);
  });
  it('falls back to the copy command without the API (plain http) or when it is refused', async () => {
    const { doc, state } = fakeDocument(true);
    expect(await copyText('hi', doc, undefined)).toBe(true);
    expect(await copyText('yo', doc, { writeText: async () => { throw new Error('denied'); } })).toBe(true);
    expect(state.copied).toEqual(['hi', 'yo']);
    expect(state.attached).toBe(0); // the temporary textarea is removed
    expect(state.refocused).toBe(2); // focus goes back to the terminal
  });
  it('reports failure', async () => {
    expect(await copyText('hi', fakeDocument(false).doc, undefined)).toBe(false);
    expect(await copyText('', fakeDocument(true).doc, undefined)).toBe(false);
    expect(await copyText('hi', undefined, undefined)).toBe(false);
  });
});

describe('bufferText', () => {
  const buf = (rows: Array<[string, boolean?]>) => ({ length: rows.length, getLine: (i: number) => ({ isWrapped: Boolean(rows[i][1]), translateToString: () => rows[i][0] }) });
  it('joins wrapped rows and drops trailing blank rows', () => {
    expect(bufferText(buf([['$ echo a very long', false], [' line', true], ['a very long line', false], ['', false], ['', false]]))).toBe('$ echo a very long line\na very long line');
  });
  it('keeps only the newest lines', () => {
    expect(bufferText(buf([['1'], ['2'], ['3']]), 2)).toBe('2\n3');
  });
});

describe('parseOsc52', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  it('decodes clipboard text, including Korean', () => {
    expect(parseOsc52(`c;${b64('hello')}`)).toBe('hello');
    expect(parseOsc52(`;${b64('한글 복사 😀')}`)).toBe('한글 복사 😀');
    expect(parseOsc52(`pc;${b64('line1\nline2')}`)).toBe('line1\nline2');
  });
  it('never answers a read request and rejects junk', () => {
    expect(parseOsc52('c;?')).toBeNull();
    expect(parseOsc52('c;')).toBeNull();
    expect(parseOsc52('nonsense')).toBeNull();
    expect(parseOsc52('c;not base64!')).toBeNull();
  });
});

describe('isPasteShortcut', () => {
  it('matches Ctrl+V, Ctrl+Shift+V, Cmd+V and Shift+Insert on keydown only', () => {
    expect(isPasteShortcut({ type: 'keydown', key: 'v', ctrlKey: true })).toBe(true);
    expect(isPasteShortcut({ type: 'keydown', key: 'V', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isPasteShortcut({ type: 'keydown', key: 'v', metaKey: true })).toBe(true);
    expect(isPasteShortcut({ type: 'keydown', key: 'Insert', shiftKey: true })).toBe(true);
    expect(isPasteShortcut({ type: 'keyup', key: 'v', ctrlKey: true })).toBe(false);
    expect(isPasteShortcut({ type: 'keydown', key: 'v' })).toBe(false);
    expect(isPasteShortcut({ type: 'keydown', key: 'v', ctrlKey: true, altKey: true })).toBe(false);
    expect(isPasteShortcut({ type: 'keydown', key: 'c', ctrlKey: true })).toBe(false);
  });
});
