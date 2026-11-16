/**
 * A short fingerprint of a draft as the person saw it, so the server can tell if it changed before they pressed Send.
 * Files attached to the draft are part of what was seen: a different file is a different draft.
 */
export function draftHash(d: { subject: string; body: string; files?: { id?: string }[] } | undefined | null): string {
  if (!d) return '';
  const files = d.files?.length ? `\n${d.files.map((f) => f.id ?? '').join(',')}` : '';
  const text = `${d.subject}\n${d.body}${files}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}
