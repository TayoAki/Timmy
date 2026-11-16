/** A short fingerprint of a draft as the person saw it, so the server can tell if it changed before they pressed Send. */
export function draftHash(d: { subject: string; body: string } | undefined | null): string {
  if (!d) return '';
  const text = `${d.subject}\n${d.body}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}
