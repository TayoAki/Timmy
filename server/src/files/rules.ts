/**
 * What may be uploaded, decided before a file is kept and again when its bytes arrive.
 *
 * Two questions are asked. First, of what the browser says it is about to send: is it for something Timmy
 * knows, small enough, and of a kind that fits that use? Second, of the bytes themselves: do they look like
 * what was promised? A file is never trusted for its name or its declared type alone.
 *
 * Nothing here scans for viruses. A document that passes these checks can still be harmful to open.
 */
import { ATTACHMENT_TYPES, MAX_FILE_BYTES, PICTURE_TYPES, UPLOAD_PURPOSES, endingOf, fileSize, type UploadPurpose } from '../../../src/lib/files';

export interface Declared {
  purpose: UploadPurpose;
  type: string;
  size: number;
  name: string | null;
}

/** Endings of programs, scripts, installers, shortcuts, web pages and documents that run macros. Named so the refusal can say why. */
const RUNS_CODE = new Set([
  'exe', 'dll', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh', 'hta', 'lnk', 'reg', 'jar', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  'sh', 'bash', 'zsh', 'command', 'py', 'rb', 'pl', 'php', 'html', 'htm', 'xhtml', 'svg', 'xml', 'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppsm', 'iso', 'img',
]);
/** Declared types that are programs, scripts or pages, whatever the file is called. */
const TYPE_RUNS_CODE = /^(application\/(x-msdownload|x-msdos-program|x-executable|x-sh|x-shellscript|x-bat|javascript|ecmascript|java-archive|x-httpd-php|xhtml\+xml|vnd\.microsoft\.portable-executable|vnd\.android\.package-archive|x-apple-diskimage|hta)|text\/(html|javascript|ecmascript|x-python|x-shellscript|x-php)|image\/svg\+xml)$/;

/** Characters that make a name show differently from what it is: control characters, and marks that reverse the reading order. */
const HIDDEN = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;

/** A file name as it will be kept, or why it can't be. */
export function nameProblem(name: string): string | null {
  if (name.length > 200) return 'That file’s name is too long.';
  if (HIDDEN.test(name) || /[\\/]/.test(name) || name.startsWith('.')) return 'That file’s name has characters Timmy can’t keep. Rename it and try again.';
  return null;
}

const isPurpose = (v: unknown): v is UploadPurpose => typeof v === 'string' && (UPLOAD_PURPOSES as readonly string[]).includes(v);

/**
 * Reads what the browser says it is about to upload. Returns the upload as Timmy will record it, or the
 * reason it is refused, in words for the person.
 */
export function readDeclared(body: unknown): { ok: true; declared: Declared } | { ok: false; reason: string; status: 400 | 413 | 415 } {
  const b = (body ?? {}) as Record<string, unknown>;
  const refuse = (reason: string, status: 400 | 413 | 415 = 400) => ({ ok: false as const, reason, status });
  if (!isPurpose(b.purpose)) return refuse('Say what the file is for: a picture on a page, a cover, the chat’s picture or an attachment.');
  if (typeof b.type !== 'string' || b.type.length > 120) return refuse('Say what kind of file it is.');
  if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size <= 0) return refuse('Say how big the file is.');
  if (b.size > MAX_FILE_BYTES) return refuse(`That file is ${fileSize(b.size)}. Timmy keeps files up to ${fileSize(MAX_FILE_BYTES)}.`, 413);
  if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') return refuse('That file’s name isn’t valid.');
  const type = b.type.split(';')[0]!.trim().toLowerCase();
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
  if (name) {
    const bad = nameProblem(name);
    if (bad) return refuse(bad);
  }
  const ending = name ? endingOf(name) : '';
  // Said first and plainly, whatever the purpose: nothing that runs is kept.
  if (TYPE_RUNS_CODE.test(type) || RUNS_CODE.has(ending)) return refuse('Timmy doesn’t keep programs, scripts or web pages. Send a document or a picture instead.', 415);

  if (b.purpose !== 'attachment') {
    if (!PICTURE_TYPES.includes(type)) return refuse('That picture isn’t a kind Timmy can keep. Use a PNG, JPEG, GIF or WebP.', 415);
    if (ending && !ATTACHMENT_TYPES[type]!.includes(ending)) return refuse('That picture’s name doesn’t match its kind.', 415);
    return { ok: true, declared: { purpose: b.purpose, type, size: b.size, name } };
  }
  if (!name) return refuse('An attachment needs its file name.');
  const endings = Object.hasOwn(ATTACHMENT_TYPES, type) ? ATTACHMENT_TYPES[type]! : null;
  if (!endings) return refuse('That kind of file can’t be attached. Timmy sends PDFs, Office and OpenDocument files, text files and pictures.', 415);
  if (!endings.includes(ending)) return refuse('That file’s name doesn’t match its kind, so it can’t be attached.', 415);
  return { ok: true, declared: { purpose: 'attachment', type, size: b.size, name } };
}

/* ───────────── The bytes themselves ───────────── */

const starts = (b: Uint8Array, sig: readonly number[] | string, at = 0): boolean => {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== (typeof sig === 'string' ? sig.charCodeAt(i) : sig[i])) return false;
  return true;
};

/**
 * How a program for Windows, Linux or macOS, or a script with a "run me with" first line, begins.
 * A Windows program starts with the letters MZ followed by binary; plain text that happens to start with
 * those two letters (a price list in Mozambican meticais, say) is not one.
 */
function looksLikeProgram(b: Uint8Array): boolean {
  const head = b.subarray(0, 64);
  return (
    (starts(b, 'MZ') && head.includes(0)) ||
    starts(b, [0x7f, 0x45, 0x4c, 0x46]) ||
    starts(b, [0xfe, 0xed, 0xfa, 0xce]) ||
    starts(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
    starts(b, [0xce, 0xfa, 0xed, 0xfe]) ||
    starts(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
    starts(b, [0xca, 0xfe, 0xba, 0xbe]) ||
    /^#![ \t]*\//.test(String.fromCharCode(...head))
  );
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLD_OFFICE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Text has no zero bytes, unless it says at its start that it is two-byte text (as a spreadsheet's "Unicode text" export does). */
function looksLikeText(b: Uint8Array): boolean {
  if (starts(b, [0xff, 0xfe]) || starts(b, [0xfe, 0xff])) return true;
  return !b.includes(0) && !starts(b, ZIP) && !starts(b, OLD_OFFICE) && !starts(b, '%PDF-');
}

/** Whether bytes begin the way a file of this type does. */
function looksLike(type: string, b: Uint8Array): boolean {
  switch (type) {
    case 'image/png':
      return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return starts(b, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return starts(b, 'GIF87a') || starts(b, 'GIF89a');
    case 'image/webp':
      return starts(b, 'RIFF') && starts(b, 'WEBP', 8);
    case 'application/pdf':
      return starts(b, '%PDF-');
    case 'application/rtf':
      return starts(b, '{\\rtf');
    case 'application/msword':
    case 'application/vnd.ms-excel':
    case 'application/vnd.ms-powerpoint':
      return starts(b, OLD_OFFICE);
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      return looksLikeText(b);
    default:
      // The newer Office and the OpenDocument formats are all zip files inside.
      return /^application\/vnd\.(openxmlformats-officedocument|oasis\.opendocument)\./.test(type) && starts(b, ZIP);
  }
}

/**
 * Looks at the bytes that arrived for an upload. Returns why they are refused, or null when they are what
 * was declared: exactly that many bytes, and beginning the way a file of that kind begins.
 */
export function bytesProblem(declared: { type: string; size: number }, bytes: Uint8Array): string | null {
  if (bytes.length !== declared.size) return 'The file that arrived isn’t the size that was announced, so it wasn’t kept.';
  if (looksLikeProgram(bytes)) return 'Timmy doesn’t keep programs or scripts.';
  if (!looksLike(declared.type, bytes)) return 'The file that arrived isn’t the kind that was announced, so it wasn’t kept.';
  return null;
}

/** Whether a kept file of this type is a picture a screen may show. */
export const isPictureType = (type: string) => PICTURE_TYPES.includes(type);
