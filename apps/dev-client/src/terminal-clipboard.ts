// Clipboard helpers for the terminal: copying text out, and getting images in.
//
// An SSH terminal has no clipboard channel, so a pasted image is uploaded to the
// remote host over SFTP and its path is typed into the terminal instead (the form
// CLI tools such as Claude Code or Codex accept for attaching an image).

export const PASTE_IMAGE_DIR = 'tmp';
export const PASTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
};

export function isImageType(type: string | undefined | null): boolean {
  return typeof type === 'string' && type.startsWith('image/');
}

/** Remote file name for a pasted image: unique, sortable, free of shell-special characters. */
export function pasteImageName(type: string, now: Date, index = 0, random: () => number = Math.random): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(random() * 0x10000).toString(16).padStart(4, '0');
  const ext = IMAGE_EXTENSIONS[type] ?? 'png';
  return `remotedeck-paste-${stamp}-${suffix}${index ? `-${index + 1}` : ''}.${ext}`;
}

interface TransferLike {
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | readonly string[] | null;
}

/** Image files carried by a paste or drop. */
export function imageFilesFrom(transfer: TransferLike | null | undefined): File[] {
  if (!transfer?.files) return [];
  return Array.from(transfer.files).filter((file) => isImageType(file.type));
}

/**
 * Whether a paste should be treated as an image. Text wins when both are present:
 * spreadsheets and office apps put a picture of the selection next to the text.
 */
export function pasteCarriesImage(transfer: TransferLike | null | undefined): boolean {
  if (imageFilesFrom(transfer).length === 0) return false;
  return !Array.from(transfer?.types ?? []).includes('text/plain');
}

export interface ClipboardContent {
  images: File[];
  text: string;
  /** The browser offers no readable clipboard here (plain http, or permission denied). */
  unavailable: boolean;
}

interface ClipboardLike {
  read?: () => Promise<ReadonlyArray<{ types: readonly string[]; getType(type: string): Promise<Blob> }>>;
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

/** Read the clipboard for the paste button: images first, else text. */
export async function readClipboard(clipboard: ClipboardLike | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined, now: () => Date = () => new Date()): Promise<ClipboardContent> {
  if (!clipboard) return { images: [], text: '', unavailable: true };
  if (typeof clipboard.read === 'function') {
    try {
      const items = await clipboard.read();
      const images: File[] = [];
      let text = '';
      for (const item of items) {
        const imageType = item.types.find((type) => isImageType(type));
        if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
        else if (imageType) {
          const blob = await item.getType(imageType);
          images.push(new File([blob], pasteImageName(imageType, now(), images.length), { type: imageType }));
        }
      }
      if (images.length || text) return { images: text ? [] : images, text, unavailable: false };
    } catch { /* fall through to readText: read() can be refused where readText is allowed */ }
  }
  if (typeof clipboard.readText === 'function') {
    try { return { images: [], text: await clipboard.readText(), unavailable: false }; } catch { /* denied */ }
  }
  return { images: [], text: '', unavailable: true };
}

/**
 * Copy text to the clipboard. The async clipboard API only exists on https (and
 * localhost); elsewhere the legacy copy command still works from a user gesture.
 */
export async function copyText(text: string, doc: Document | undefined = typeof document !== 'undefined' ? document : undefined, clipboard: ClipboardLike | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined): Promise<boolean> {
  if (!text) return false;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try { await clipboard.writeText(text); return true; } catch { /* denied: try the legacy command */ }
  }
  return legacyCopy(text, doc);
}

function legacyCopy(text: string, doc: Document | undefined): boolean {
  if (!doc || typeof doc.execCommand !== 'function') return false;
  const previous = doc.activeElement as HTMLElement | null;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  doc.body.appendChild(area);
  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy');
  } catch { ok = false; }
  area.remove();
  try { previous?.focus?.({ preventScroll: true }); } catch { /* element gone */ }
  return ok;
}

interface BufferLineLike { isWrapped: boolean; translateToString(trimRight?: boolean): string }
interface BufferLike { length: number; getLine(index: number): BufferLineLike | undefined }

/**
 * The terminal's text (scrollback + screen) as plain lines, with soft-wrapped rows
 * joined back into the line the program printed. Used by the text view, where touch
 * devices can select with the native handles.
 */
export function bufferText(buffer: BufferLike, maxLines = 2000): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines).join('\n');
}

const OSC52_MAX_BASE64 = 2 * 1024 * 1024;

/**
 * Text a program asks to put on the clipboard with OSC 52 ("52;c;<base64>").
 * Full-screen programs that take over the mouse (Claude Code, tmux, vim) select text
 * themselves and copy this way, so without it "copy" silently does nothing.
 * A read request ("?") is never answered: a remote host must not see the local clipboard.
 */
export function parseOsc52(data: string): string | null {
  const split = data.indexOf(';');
  if (split < 0) return null;
  const payload = data.slice(split + 1).trim();
  if (!payload || payload === '?' || payload.length > OSC52_MAX_BASE64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    return text || null;
  } catch { return null; }
}

/** Ctrl+V / Ctrl+Shift+V (and Shift+Insert): leave to the browser so it fires a real paste. */
export function isPasteShortcut(event: { type?: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): boolean {
  if (event.type !== 'keydown' || event.altKey) return false;
  const key = (event.key ?? '').toLowerCase();
  if (key === 'v' && (event.ctrlKey || event.metaKey)) return true;
  return key === 'insert' && Boolean(event.shiftKey) && !event.ctrlKey && !event.metaKey;
}
