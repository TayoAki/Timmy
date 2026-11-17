/**
 * Uploading a file from the browser, on a real workspace.
 *
 * Two requests: the first tells the server what is coming (what for, what kind, how big) and gets back an id and
 * where to send the bytes; the second sends them. The server checks both, and only then can a page or an email
 * refer to the file. A page saves the reference ("asset:" and the id), never the picture itself.
 */
import type { MailFile } from '../data/types';
import { MAX_FILE_BYTES, PICTURE_TYPES, assetRef, attachmentTypeFor, fileSize, type UploadPurpose } from '../lib/files';

interface Kept {
  assetId: string;
  type: string;
  size: number;
  name: string | null;
}

const answer = async (res: Response): Promise<Record<string, unknown>> => (await res.json().catch(() => ({}))) as Record<string, unknown>;

async function upload(bytes: Blob, purpose: UploadPurpose, type: string, name?: string): Promise<Kept> {
  if (bytes.size > MAX_FILE_BYTES) throw new Error(`That file is ${fileSize(bytes.size)}. Timmy keeps files up to ${fileSize(MAX_FILE_BYTES)}.`);
  const announced = await fetch('/api/v1/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose, type, size: bytes.size, name }) });
  const told = (await answer(announced)) as { error?: string; upload?: { method: string; url: string; headers: Record<string, string> } };
  if (!announced.ok || !told.upload) throw new Error(told.error ?? 'That file couldn’t be uploaded. Try again.');
  const sent = await fetch(told.upload.url, { method: told.upload.method, credentials: 'same-origin', headers: told.upload.headers, body: bytes });
  const kept = (await answer(sent)) as Partial<Kept> & { error?: string };
  if (!sent.ok || !kept.assetId) throw new Error(kept.error ?? 'That file couldn’t be uploaded. Try again.');
  return kept as Kept;
}

/**
 * Draws a picked picture onto a canvas and reads it back. The copy is no larger than `max` pixels on its long
 * side, and carries nothing but the picture: where and when a photo was taken, and with what, stay behind.
 * A GIF is left as it is, because redrawing it would stop it moving.
 */
async function redraw(file: File, max: number): Promise<Blob> {
  if (file.type === 'image/svg+xml') throw new Error('Timmy can’t keep SVG pictures. Use a PNG, JPEG, GIF or WebP.');
  if (file.type === 'image/gif') return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That picture couldn’t be opened. Use a PNG, JPEG, GIF or WebP.'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    // A PNG stays a PNG (it may be see-through) and a WebP stays a WebP where the browser can write one; anything else becomes a JPEG.
    const want = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, want, 0.86));
    if (!blob || !PICTURE_TYPES.includes(blob.type)) throw new Error('That picture couldn’t be prepared. Try a PNG or JPEG.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Uploads a picture for a page, a cover or the website chat, and returns the reference to save in its place. */
export async function uploadPicture(file: File, purpose: Exclude<UploadPurpose, 'attachment'>, max: number): Promise<string> {
  const blob = await redraw(file, max);
  return assetRef((await upload(blob, purpose, blob.type)).assetId);
}

/** Uploads a file to send with an email, exactly as it is. Returns what the email carries for it. */
export async function uploadAttachment(file: File): Promise<MailFile> {
  const type = attachmentTypeFor(file.name);
  if (!type) throw new Error(`“${file.name}” can’t be attached. Timmy sends PDFs, Office and OpenDocument files, text files and pictures.`);
  const kept = await upload(file, 'attachment', type, file.name);
  return { id: kept.assetId, name: kept.name ?? file.name, type: kept.type, size: kept.size };
}
