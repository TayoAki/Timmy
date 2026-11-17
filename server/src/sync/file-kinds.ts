/** What Google Drive and OneDrive have in common: how a file's type is named, and how much of one is read. */

/** The most of one file's text that is handed to the model in one go, and that is kept for searching. */
export const MAX_FILE_TEXT = 24_000;

export type FileText = { ok: true; name: string; kind: string; text: string; truncated: boolean } | { ok: false; reason: string };

/** How far one pass over a file list got. A pass that stops early is carried on by the next one. */
export interface FilesSync {
  pages: number;
  files: number;
  done: boolean;
}

/** What reading one file through its connection came to: its words, or why there are none. */
export type Read = { text: string } | { reason: string };

/** A file on the workspace's list, as the readers need it. */
export interface ListedFile {
  connectionId: string;
  toolkit: string;
  id: string;
  name: string;
  kind: string;
  mime: string;
  size?: number;
  /** OneDrive: the drive the file is in. */
  driveId?: string;
}

/** What a person would call the file's type. */
export function fileKind(mimeType: string): string {
  const known: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Form',
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
    'application/msword': 'Word document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel workbook',
    'application/vnd.ms-excel': 'Excel workbook',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint deck',
    'text/csv': 'CSV file',
    'text/plain': 'Text file',
  };
  if (Object.hasOwn(known, mimeType)) return known[mimeType]!;
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return 'File';
}
