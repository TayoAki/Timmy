/**
 * A link that opens the mail app's own compose window, filled in. Cold email
 * goes out this way: the person sends it from their mail app, and Timmy never
 * sends it through the provider's API.
 */
export interface ComposeFields {
  to: string;
  subject: string;
  body: string;
  /** The signed-in mailbox, so Gmail opens the right account when several are signed in. */
  from?: string;
}

/** Past this length browsers and Gmail start cutting links short. */
export const COMPOSE_LINK_MAX = 6000;

/** Microsoft's own consumer domains (outlook.com, hotmail.co.uk, live.fr and the like), and nothing that merely starts the same way. */
const PERSONAL_OUTLOOK = /@(outlook|hotmail|live|msn)\.(com|[a-z]{2}|com?\.[a-z]{2})$/i;

export function composeLink(app: 'gmail' | 'outlook' | 'mailto', f: ComposeFields): { url: string; bodyFits: boolean } {
  const enc = encodeURIComponent;
  const build = (body: string) => {
    if (app === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1${f.from ? `&authuser=${enc(f.from)}` : ''}&to=${enc(f.to)}&su=${enc(f.subject)}&body=${enc(body)}`;
    // Work and school accounts open in Outlook on the web at office.com; personal ones (outlook.com, hotmail.com, live.com, msn.com) at live.com.
    if (app === 'outlook') return `https://${PERSONAL_OUTLOOK.test(f.from ?? '') ? 'outlook.live.com/mail/0' : 'outlook.office.com/mail'}/deeplink/compose?to=${enc(f.to)}&subject=${enc(f.subject)}&body=${enc(body)}`;
    return `mailto:${enc(f.to)}?subject=${enc(f.subject)}&body=${enc(body)}`;
  };
  const full = build(f.body);
  // A body too long for a link is left out; the caller copies it to the clipboard for pasting.
  return full.length <= COMPOSE_LINK_MAX ? { url: full, bodyFits: true } : { url: build(''), bodyFits: false };
}
