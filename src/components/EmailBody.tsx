/**
 * An email's body, the way a mail reader shows it.
 *
 * On a real workspace, a synced message is shown as its sender laid it out: the server fetches the original HTML when
 * the message is opened and cleans it (server/src/mail/original.ts), and it is shown here in a frame of its own that
 * runs nothing, where its styles can only restyle the email. Pictures from other sites stay out until the person asks,
 * because loading one tells the sender the email was opened. Plain-text email, and every message in the demo, is laid
 * out here: paragraphs and line breaks kept, links and addresses clickable, the quoted history folded behind "•••".
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';
import type { Message, Thread } from '../data/types';
import { isLive } from '../live/clock';
import { api } from '../live/api';

/* ───────────── Plain text ───────────── */

const LINKABLE = /\b(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]|www\.[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;

/** Text with its web and email addresses made into links that open in a new tab. */
export function Linked({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINKABLE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const href = raw.includes('@') && !/^https?:|^www\./i.test(raw) ? `mailto:${raw}` : /^www\./i.test(raw) ? `https://${raw}` : raw;
    out.push(
      <a key={at} href={href} target="_blank" rel="noopener noreferrer nofollow" className="mail-link">
        {raw}
      </a>,
    );
    last = at + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Where the quoted history under a reply begins, by the lines mail apps put there. -1 when there is none. */
function quoteStart(lines: string[]): number {
  const marker = lines.findIndex((l, i) => {
    const s = l.trim();
    return i > 0 && (/^On .{5,120} wrote:$/.test(s) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(s) || /^From: .+@.+/.test(s) || /^_{8,}$/.test(s));
  });
  if (marker > 0) return marker;
  // Otherwise the run of "> " lines at the end.
  let i = lines.length;
  while (i > 0 && (lines[i - 1]!.trim().startsWith('>') || !lines[i - 1]!.trim())) i--;
  return i < lines.length && i > 0 && lines.slice(i).some((l) => l.trim().startsWith('>')) ? i : -1;
}

const paragraphsOf = (text: string) =>
  text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim());

/** A plain-text email: paragraphs and line breaks as written, links clickable, quoted history folded. */
export function EmailText({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = quoteStart(lines);
  const main = cut > 0 ? lines.slice(0, cut).join('\n') : text;
  const quoted = cut > 0 ? lines.slice(cut).join('\n') : '';
  return (
    <div className="mail-text">
      {paragraphsOf(main).map((p, i) => (
        <p key={i}>
          <Linked text={p} />
        </p>
      ))}
      {quoted.trim() && (
        <>
          <button type="button" className="mail-quoted-toggle" aria-expanded={showQuoted} onClick={() => setShowQuoted((x) => !x)} title={showQuoted ? 'Hide the quoted text' : 'Show the quoted text'}>
            •••
          </button>
          {showQuoted && (
            <div className="mail-quoted">
              {paragraphsOf(quoted.replace(/^> ?/gm, '')).map((p, i) => (
                <p key={i}>
                  <Linked text={p} />
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────── HTML, in a frame of its own ───────────── */

const frameDoc = (html: string, images: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? ' https:' : ''}">
<base target="_blank">
<style>
html, body { margin: 0; padding: 0; background: #fff; color: #1c1b19; }
body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
/* A picture left out (from another site, until asked for) leaves no broken-image box behind. */
img:not([src]) { display: none; }
table { max-width: 100%; }
a { color: #3343c4; }
blockquote { margin: 0 0 0 0.8ex; border-left: 2px solid #d5d1c7; padding-left: 1ex; color: #4d4a44; }
pre { white-space: pre-wrap; }
</style></head><body>${html}</body></html>`;

/**
 * The cleaned HTML in a sandboxed frame: no scripts, no forms, no plugins, links open in a new tab. It is sized to its
 * content, so the email reads as part of the thread rather than a box that scrolls on its own.
 */
export function EmailFrame({ html, images, title }: { html: string; images: boolean; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    let watcher: ResizeObserver | null = null;
    const fit = () => {
      const doc = el.contentDocument;
      if (!doc?.documentElement) return;
      setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 40), 20000));
    };
    const ready = () => {
      fit();
      const body = el.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        watcher?.disconnect();
        watcher = new ResizeObserver(fit);
        watcher.observe(body);
      }
    };
    el.addEventListener('load', ready);
    return () => {
      el.removeEventListener('load', ready);
      watcher?.disconnect();
    };
  }, [html, images]);
  return (
    <iframe
      ref={frame}
      className="mail-frame"
      title={title}
      // Nothing in the email can run. allow-same-origin lets this page measure the email's height; with no scripts
      // allowed inside, nothing in the email can use it.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={frameDoc(html, images)}
      style={{ height }}
    />
  );
}

/* ───────────── The body of one message ───────────── */

type Original = Awaited<ReturnType<typeof api.mailOriginal>>;

export function EmailBody({ t, m }: { t: Thread; m: Message }) {
  // A message Timmy sent that the mailbox hasn't returned yet has only what was written here.
  const fetchable = isLive() && !!t.ext?.threadKey && !!t.ext.connectionId;
  const [images, setImages] = useState(false);
  const [original, setOriginal] = useState<Original | null>(null);
  useEffect(() => {
    if (!fetchable) return;
    let gone = false;
    api
      .mailOriginal(t.id, m.id, images)
      .then((r) => !gone && setOriginal(r))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [fetchable, t.id, m.id, images]);

  if (original?.html !== undefined) {
    return (
      <>
        {original.blocked > 0 && !images && (
          <p className="mail-images-off">
            <ImageOff size={14} aria-hidden />
            <span>Pictures in this email are hidden, so the sender can’t tell you opened it.</span>
            <button type="button" className="btn btn-xs" onClick={() => setImages(true)}>
              Show pictures
            </button>
          </p>
        )}
        <div className="mail-frame-wrap">
          <EmailFrame html={original.html} images={images} title={`Email from ${t.subject}`} />
        </div>
      </>
    );
  }
  const text = original?.text?.trim() ? original.text : m.body.join('\n\n');
  return <EmailText text={text} />;
}
