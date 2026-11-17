/**
 * Uploaded files: what kinds there are, how big they may be, and how a screen shows one.
 *
 * The browser and the server both read this file. The browser uses it to pick a type from a file's name and to
 * turn a saved reference into an address it can load; the server uses the same lists when it decides what to keep.
 * The server always has the last word.
 */

/** The most one uploaded file may weigh. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What an upload is for. A picture on a page, a page's cover, the website chat's picture, or a file to send with an email. */
export const UPLOAD_PURPOSES = ['page-image', 'page-cover', 'chat-icon', 'attachment'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** Pictures the screens may show. SVG is left out on purpose: it can carry a script. */
export const PICTURE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * What may go out with an email: common documents and pictures, each with the endings its name may have.
 * Anything not listed is refused, which is how programs, scripts, archives and web pages stay out.
 */
export const ATTACHMENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/markdown': ['md'],
  'application/rtf': ['rtf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['ods'],
  'application/vnd.oasis.opendocument.presentation': ['odp'],
};

/** How many files one email may carry, and how much they may weigh together (mail providers stop at about 25 MB once encoded). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENTS_BYTES = 18 * 1024 * 1024;

/** The part of a file's name after its last dot, in lower case: "Report.PDF" → "pdf". Empty when there is none. */
export function endingOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 && at < name.length - 1 ? name.slice(at + 1).toLowerCase() : '';
}

/** The type an attachment has, going by its name. Null when it is not a kind that can be sent. */
export function attachmentTypeFor(name: string): string | null {
  const ending = endingOf(name);
  if (!ending) return null;
  return Object.keys(ATTACHMENT_TYPES).find((type) => ATTACHMENT_TYPES[type]!.includes(ending)) ?? null;
}

/** The endings a file picker should offer for attachments: ".pdf,.png,…". */
export const ATTACHMENT_ENDINGS = Object.values(ATTACHMENT_TYPES)
  .flat()
  .map((e) => `.${e}`)
  .join(',');

/** A file's size in words: "840 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/* ───────────── References to uploaded files ───────────── */

/** An uploaded file is saved in a page or a setting by reference, "asset:" and its id, never as its bytes. */
const ASSET_REF = /^asset:([\w-]{1,80})$/;

export const assetRef = (id: string) => `asset:${id}`;

/** The asset id inside a reference, or null when the value is something else (a web address, an inline picture). */
export function assetIdOf(value: unknown): string | null {
  return typeof value === 'string' ? (ASSET_REF.exec(value)?.[1] ?? null) : null;
}

/**
 * The address a screen loads a picture from. A reference to an uploaded picture becomes the API's address for it,
 * which only members of the workspace can read; anything else (a web address, an inline picture) is used as it is.
 */
export function pictureUrl(value: string): string {
  const id = assetIdOf(value);
  return id ? `/api/v1/assets/${id}` : value;
}
