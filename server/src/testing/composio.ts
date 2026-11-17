/**
 * The stand-in for Composio: mailboxes, calendars and drives kept in memory. The server uses it in place of the
 * real provider when `config.fakeProviders` is on (tests, the browser suites, staging), as chosen in
 * providers/composio.ts. Tests drive it through `fakeComposio()`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { newId } from '../lib/ids';
import { htmlToText } from '../sync/message';
import type { ComposioProvider, ProviderEvent, StagedFile, ToolResult } from '../providers/composio';
import { DownloadRefused } from '../providers/composio-download';
import { eventFrom, signWebhook, verifyWebhookSignature } from '../providers/composio-webhook';
import { fakeFileTool } from './composio-files';

export interface FakeMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  at: Date;
  /** Where the message sits, in Gmail's words. The stand-in Outlook reads the same list as folders (ARCHIVE is its Archive folder). */
  labels: string[];
  /** Outlook only: the categories on the message. */
  categories?: string[];
  /** Outlook only: the HTML body, when it differs from a plain rendering of `body`. */
  html?: string;
  /** The files the message carries: what a recipient would get. */
  attachments?: FakeAttachment[];
}

/** A file on a stand-in message, described by what arrived: its name, type, size and the SHA-256 of its bytes. */
export interface FakeAttachment {
  name: string;
  mimetype: string;
  size: number;
  sha256: string;
  /** Outlook only: a picture placed inside the body (a signature's logo). Outlook does not count it in `hasAttachments`. */
  inline?: boolean;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  owner: string;
  trashed?: boolean;
  /** The link Drive gives for opening the file. Set only to test what is done with an odd one. */
  link?: string;
  /** What the file says: a doc's text (blank lines split paragraphs), a sheet's rows, or a deck's slides. */
  text?: string;
  rows?: (string | number)[][];
  /** When it was shared with the person (Drive's sharedWithMeTime), for a file someone else owns. */
  sharedAt?: string;
  /** OneDrive: the file's own bytes, when a test needs exact ones (a damaged file); else built from `text` or `rows`. */
  bytes?: Uint8Array;
  /** OneDrive: the size the drive reports, when it should differ from the bytes' own. */
  size?: number;
  /** OneDrive: the number of the change that last touched it, and whether that change deleted it. */
  seq?: number;
  deleted?: boolean;
}

/** An event on a stand-in calendar. Google Calendar and Outlook accounts keep the same list and show it in their own shapes. */
export interface FakeEvent {
  id: string;
  summary: string;
  /** ISO instants. */
  start: string;
  end: string;
  /** Everyone on the event by address. The account's own address may be among them. */
  attendees: string[];
  /** Set on events Timmy created with invitations sent. */
  invited?: boolean;
  /** Who organizes it. Left out, the account itself does. */
  organizer?: string;
  description?: string;
  location?: string;
  /** One time of a repeating event. */
  recurring?: boolean;
}

export interface FakeMailbox {
  address: string;
  status: 'INITIATED' | 'ACTIVE';
  toolkit: string;
  userId: string;
  messages: FakeMessage[];
  events: FakeEvent[];
  /** What the stand-in calendar told guests because of a write: who heard what, about which event. */
  notices: { about: 'invited' | 'changed' | 'cancelled'; event: string; to: string[] }[];
  /** Ids of events that were deleted. Google still shows such an event, as cancelled, when asked for it by id. */
  cancelled: string[];
  /** Labels the person or Timmy made: name → id. */
  labels: Map<string, string>;
  /** Drive only: the files in the account. */
  files: FakeFile[];
  /** OneDrive only: the next list of changes answers that its link has expired, as Microsoft's sometimes does. */
  resyncRequired?: boolean;
  /** What the person allowed when connecting. Left out, everything the app asks for. */
  scopes?: string[];
  /** Outlook only: the mailbox has no well-known Archive folder (older Microsoft 365 mailboxes may not). */
  noArchive?: boolean;
  /** Outlook only: folders made in the mailbox, by display name → id. */
  folders?: Map<string, string>;
}

/**
 * A stand-in for Composio that keeps mailboxes in memory. It answers the same
 * tool slugs with the same shapes the real toolkits return, so the sync and
 * send code paths run unchanged in tests.
 */
export class FakeComposio implements ComposioProvider {
  /** Random per process, so a deployed server running the fake cannot be fed events by someone who read the code. */
  readonly secret = `fake-${randomBytes(16).toString('hex')}`;
  accounts = new Map<string, FakeMailbox>();
  triggers = new Map<string, { slug: string; connectedAccountId: string; userId: string }>();
  /** Every tool call, for assertions and for counting calls. */
  calls: { slug: string; args: Record<string, unknown>; connectedAccountId: string }[] = [];
  /** Make the next execution of a slug fail: 'error' is a clean refusal, 'timeout' leaves the outcome unknown. */
  failNext = new Map<string, 'error' | 'timeout' | 'sent-then-timeout' | 'partial' | 'dropped'>();
  /** The address the next connect flow will sign in as. */
  nextAddress = '';
  /** The permissions the next connect flow grants, once; null grants everything asked for. */
  nextScopes: string[] | null = null;
  /** Files handed over with `stageFile`, by the key each was given, with the tool it was handed over for. */
  staged = new Map<string, { toolSlug: string; toolkit: string; bytes: Uint8Array }>();
  /** Files handed back by a download tool, by the address given for each. */
  downloads = new Map<string, { bytes: Uint8Array; connectedAccountId: string }>();
  /** The number of the last change made in a stand-in drive. */
  fileSeq = 0;

  reset() {
    this.accounts.clear();
    this.triggers.clear();
    this.calls = [];
    this.failNext.clear();
    this.nextAddress = '';
    this.nextScopes = null;
    this.staged.clear();
    this.downloads.clear();
  }

  /** Puts a downloaded file in the stand-in store, at an address on Composio's own store host. */
  stash(connectedAccountId: string, bytes: Uint8Array): string {
    const url = `https://storage.composio.dev/fake/downloads/${newId('dl')}`;
    this.downloads.set(url, { bytes, connectedAccountId });
    return url;
  }

  /** What the real provider's download does, from the stand-in store: a larger file than asked for is refused. */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const held = this.downloads.get(url);
    this.calls.push({ slug: 'FILES_DOWNLOAD', args: { url }, connectedAccountId: held?.connectedAccountId ?? '' });
    if (!held) throw new DownloadRefused('the file store answered 404');
    if (held.bytes.length > maxBytes) throw new DownloadRefused('the file is larger than Timmy reads');
    return held.bytes;
  }

  /** Changes a stand-in file as a person would in the drive itself; the drive's list of changes then carries it. */
  changeFile(connectedAccountId: string, id: string, patch: Partial<FakeFile>): FakeFile {
    const f = this.accounts.get(connectedAccountId)?.files.find((x) => x.id === id);
    if (!f) throw new Error('no such fake file');
    return Object.assign(f, patch, { seq: ++this.fileSeq });
  }

  /**
   * What Composio's client does in `files.upload`: the bytes go to Composio's store under a key that names
   * the toolkit and the tool, and the caller gets the reference a tool's file argument takes.
   * `failNext.set('FILES_UPLOAD', 'error')` makes the next hand-over fail, as a refused upload does.
   */
  async stageFile(input: { toolSlug: string; toolkit: string; name: string; type: string; bytes: Uint8Array }): Promise<StagedFile> {
    this.calls.push({ slug: 'FILES_UPLOAD', args: { toolSlug: input.toolSlug, toolkit: input.toolkit, name: input.name, type: input.type, size: input.bytes.length }, connectedAccountId: '' });
    if (this.failNext.get('FILES_UPLOAD')) {
      this.failNext.delete('FILES_UPLOAD');
      throw new Error('Failed to upload file (fake)');
    }
    const s3key = `fake/${input.toolkit}/${input.toolSlug}/request/${createHash('md5').update(input.bytes).digest('hex')}-${newId('f')}`;
    this.staged.set(s3key, { toolSlug: input.toolSlug, toolkit: input.toolkit, bytes: new Uint8Array(input.bytes) });
    return { name: input.name, mimetype: input.type, s3key };
  }

  /**
   * Reads a tool's file argument the way the real tools do. Each file must be a reference with a name, a type
   * with a slash in it and a key, and the key must be one that was handed over for this very tool. Anything
   * else is refused before the tool does anything. `single` is for a tool that takes one file, not a list.
   */
  private filesOf(slug: string, toolkit: string, value: unknown, single = false): { files: FakeAttachment[] } | { error: string } {
    if (value === undefined || value === null) return { files: [] };
    if (Array.isArray(value) && single) return { error: 'Invalid request data provided - attachment: Input should be a valid dictionary' };
    const files: FakeAttachment[] = [];
    for (const v of Array.isArray(value) ? value : [value]) {
      const f = v as { name?: unknown; mimetype?: unknown; s3key?: unknown } | null;
      if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !f.name || typeof f.mimetype !== 'string' || typeof f.s3key !== 'string') return { error: 'Invalid request data provided - attachment: Input should be a valid FileUploadable (name, mimetype, s3key)' };
      if (!f.mimetype.includes('/')) return { error: 'Invalid request data provided - attachment: mimetype must contain a "/" separator' };
      const held = this.staged.get(f.s3key);
      if (!held || held.toolSlug !== slug || held.toolkit !== toolkit) return { error: 'Invalid request data provided - attachment: no file was uploaded for this tool under that s3key' };
      files.push({ name: f.name, mimetype: f.mimetype, size: held.bytes.length, sha256: createHash('sha256').update(held.bytes).digest('hex') });
    }
    return { files };
  }

  async link({ userId, toolkit, callbackUrl }: { userId: string; toolkit: string; callbackUrl: string }) {
    const connectedAccountId = newId('ca_fake');
    this.accounts.set(connectedAccountId, { address: this.nextAddress || `${userId.slice(0, 8)}@example.test`, status: 'INITIATED', toolkit, userId, messages: [], events: [], notices: [], cancelled: [], labels: new Map(), files: [], ...(this.nextScopes ? { scopes: [...this.nextScopes] } : {}) });
    this.nextScopes = null;
    const redirectUrl = `${config.publicUrl}/api/test/fake-connect?account=${connectedAccountId}&to=${encodeURIComponent(callbackUrl)}`;
    return { redirectUrl, connectedAccountId, authConfigId: `ac_fake_${toolkit}` };
  }

  /** What Google's consent screen does in real life. */
  completeConnect(connectedAccountId: string) {
    const a = this.accounts.get(connectedAccountId);
    if (a) a.status = 'ACTIVE';
  }

  async account(connectedAccountId: string) {
    const a = this.accounts.get(connectedAccountId);
    return { status: a?.status ?? 'FAILED', label: a?.address };
  }

  async disconnect(connectedAccountId: string) {
    this.accounts.delete(connectedAccountId);
  }

  async createTrigger(slug: string, input: { userId: string; connectedAccountId: string }) {
    // Microsoft refuses to announce calendar changes to an app that may not read the calendar.
    const box = this.accounts.get(input.connectedAccountId);
    if (slug === 'OUTLOOK_EVENT_CHANGE_TRIGGER' && box && !FakeComposio.mayReadCalendar(box)) throw new Error('Subscription validation request failed: insufficient privileges to subscribe to events (fake)');
    const triggerId = newId('ti_fake');
    this.triggers.set(triggerId, { slug, connectedAccountId: input.connectedAccountId, userId: input.userId });
    return { triggerId };
  }

  async deleteTrigger(triggerId: string) {
    this.triggers.delete(triggerId);
  }

  async ensureWebhook() {
    return { secret: this.secret };
  }

  parseWebhook(headers: Headers, rawBody: string, secret: string): ProviderEvent {
    const id = verifyWebhookSignature(headers, rawBody, secret);
    return eventFrom(id, rawBody);
  }

  /** Whether an account was allowed to read the calendar when it was connected. Outlook was once asked for mail only. */
  static mayReadCalendar(box: FakeMailbox): boolean {
    return !box.scopes || box.scopes.some((s) => /^Calendars\./.test(s));
  }

  /** Puts a message in a fake mailbox and returns the signed webhook Composio would send for it. */
  deliver(connectedAccountId: string, m: Partial<FakeMessage> & { from: string; subject: string; body: string }) {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const msg: FakeMessage = { id: m.id ?? newId('m'), threadId: m.threadId ?? newId('t'), from: m.from, to: m.to ?? [box.address], cc: m.cc, subject: m.subject, body: m.body, at: m.at ?? new Date(), labels: m.labels ?? ['INBOX', 'UNREAD'], ...(m.categories ? { categories: [...m.categories] } : {}), ...(m.attachments ? { attachments: m.attachments.map((a) => ({ ...a })) } : {}) };
    box.messages.push(msg);
    const outlook = box.toolkit === 'outlook';
    const slug = outlook ? 'OUTLOOK_MESSAGE_TRIGGER' : 'GMAIL_NEW_GMAIL_MESSAGE';
    // Outlook's event carries a preview under an id that is not the one the listing tools use, as the real one does.
    const data = outlook
      ? { event_type: 'created', id: `mutable-${msg.id}`, message: { id: `mutable-${msg.id}`, conversation_id: msg.threadId, subject: msg.subject, body_preview: msg.body.slice(0, 255), is_read: false } }
      : { id: msg.id, message_id: msg.id, thread_id: msg.threadId, label_ids: msg.labels, sender: msg.from, to: msg.to.join(', '), subject: msg.subject, message_text: msg.body, message_timestamp: msg.at.toISOString() };
    const signed = this.event(connectedAccountId, slug, data);
    return { message: msg, webhook: signed.webhook, hasTrigger: signed.hasTrigger };
  }

  /** The signed webhook Composio would send for one trigger event on an account. */
  event(connectedAccountId: string, slug: string, data: Record<string, unknown>) {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const trigger = [...this.triggers.entries()].find(([, t]) => t.connectedAccountId === connectedAccountId && t.slug === slug);
    const body = JSON.stringify({ id: newId('evt'), type: 'composio.trigger.message', timestamp: new Date().toISOString(), metadata: { trigger_slug: slug, trigger_id: trigger?.[0] ?? '', connected_account_id: connectedAccountId, user_id: box.userId }, data });
    const id = newId('wh');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signWebhook(id, timestamp, body, this.secret) };
    return { webhook: { headers, body }, hasTrigger: !!trigger };
  }

  /** Puts a file in a stand-in Drive. */
  addFile(connectedAccountId: string, f: Partial<FakeFile> & { name: string }): FakeFile {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const file: FakeFile = { id: f.id ?? newId('file'), name: f.name, mimeType: f.mimeType ?? 'application/vnd.google-apps.document', modifiedTime: f.modifiedTime ?? new Date().toISOString(), owner: f.owner ?? box.address, trashed: f.trashed, link: f.link, text: f.text, rows: f.rows, sharedAt: f.sharedAt, bytes: f.bytes, size: f.size, seq: ++this.fileSeq };
    box.files = [...box.files.filter((x) => x.id !== file.id), file];
    return file;
  }

  private wire(m: FakeMessage) {
    return {
      messageId: m.id,
      threadId: m.threadId,
      messageTimestamp: m.at.toISOString(),
      labelIds: m.labels,
      sender: m.from,
      to: m.to.join(', '),
      cc: (m.cc ?? []).join(', '),
      subject: m.subject,
      messageText: m.body,
      preview: { body: m.body.slice(0, 160), subject: m.subject },
      attachmentList: (m.attachments ?? []).map((a, i) => ({ attachmentId: `att-${m.id}-${i}`, filename: a.name, mimeType: a.mimetype })),
    };
  }

  /** The id of the folder a mailbox files archived mail in: the well-known Archive, or one named Archive that was made later. */
  private archiveFolder(box: FakeMailbox | undefined): string {
    return box?.noArchive ? (box.folders?.get('Archive') ?? 'fld-none') : 'fld-archive';
  }

  /** A message as Microsoft Graph returns it. */
  private graph(m: FakeMessage, box?: FakeMailbox) {
    const sender = /^(.*)<([^<>]+)>\s*$/.exec(m.from);
    const folder = m.labels.includes('DRAFT') ? 'drafts' : m.labels.includes('SENT') ? 'sentitems' : m.labels.includes('INBOX') ? 'inbox' : m.labels.includes('ARCHIVE') ? 'archive' : m.labels.includes('TRASH') ? 'deleteditems' : m.labels.includes('SPAM') ? 'junkemail' : 'other';
    const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      id: m.id,
      conversationId: m.threadId,
      subject: m.subject,
      from: { emailAddress: { name: sender ? sender[1]!.trim().replace(/^"|"$/g, '') : '', address: sender ? sender[2]!.trim() : m.from } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (m.cc ?? []).map((address) => ({ emailAddress: { address } })),
      receivedDateTime: m.at.toISOString(),
      sentDateTime: m.at.toISOString(),
      isRead: !m.labels.includes('UNREAD'),
      isDraft: m.labels.includes('DRAFT'),
      parentFolderId: folder === 'archive' ? this.archiveFolder(box) : `fld-${folder}`,
      categories: m.categories ?? [],
      // Outlook hands bodies over as HTML, with a head and styles around the words.
      body: { contentType: 'html', content: m.html ?? `<html><head><style>p { margin: 0 }</style></head><body>${m.body.split(/\n\n+/).map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join('')}</body></html>` },
      bodyPreview: m.body.slice(0, 255),
      // Like Outlook, pictures placed inside the body do not count.
      hasAttachments: !!m.attachments?.some((a) => !a.inline),
    };
  }

  /** An event as Google Calendar returns it. The organizer and the account's own entry are marked "self", as Google marks them. */
  private googleEvent(box: FakeMailbox, e: FakeEvent) {
    const organizer = e.organizer ?? box.address;
    return {
      id: e.id,
      status: 'confirmed',
      summary: e.summary,
      start: { dateTime: e.start },
      end: { dateTime: e.end },
      organizer: { email: organizer, ...(organizer === box.address ? { self: true } : {}) },
      ...(e.attendees.length ? { attendees: e.attendees.map((email) => ({ email, responseStatus: 'needsAction', ...(email === box.address ? { self: true } : {}), ...(email === organizer ? { organizer: true } : {}) })) } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      ...(e.recurring ? { recurringEventId: e.id.split('_')[0] } : {}),
    };
  }

  /**
   * An event as Microsoft Graph returns it: times as a wall clock in UTC, the organizer named apart from the people
   * invited, and only a preview of the body. Like Graph, it returns just the properties `select` names.
   */
  private graphEvent(box: FakeMailbox, e: FakeEvent, select?: string[]) {
    const organizer = e.organizer ?? box.address;
    const clock = (iso: string) => ({ dateTime: `${new Date(iso).toISOString().slice(0, 23)}0000`, timeZone: 'UTC' });
    const full: Record<string, unknown> = {
      id: e.id,
      subject: e.summary,
      start: clock(e.start),
      end: clock(e.end),
      isAllDay: false,
      isCancelled: false,
      isOrganizer: organizer === box.address,
      organizer: { emailAddress: { name: '', address: organizer } },
      attendees: e.attendees.filter((a) => a !== organizer).map((address) => ({ type: 'required', status: { response: 'none', time: '0001-01-01T00:00:00Z' }, emailAddress: { name: '', address } })),
      location: { displayName: e.location ?? '' },
      bodyPreview: (e.description ?? '').replace(/\n/g, '\r\n').slice(0, 255),
      type: e.recurring ? 'occurrence' : 'singleInstance',
      seriesMasterId: e.recurring ? `series-${e.id.slice(-12)}` : null,
      showAs: 'busy',
      importance: 'normal',
      sensitivity: 'normal',
      categories: [],
      responseStatus: { response: organizer === box.address ? 'organizer' : 'notResponded', time: '0001-01-01T00:00:00Z' },
      webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(e.id)}`,
    };
    return select ? Object.fromEntries(['id', ...select].filter((k) => k in full).map((k) => [k, full[k]])) : full;
  }

  async execute(slug: string, args: Record<string, unknown>, who: { userId: string; connectedAccountId: string }): Promise<ToolResult> {
    this.calls.push({ slug, args, connectedAccountId: who.connectedAccountId });
    const box = this.accounts.get(who.connectedAccountId);
    if (!box || box.status !== 'ACTIVE') return { successful: false, data: {}, error: 'No active connection for this account' };
    if (box.userId !== who.userId) return { successful: false, data: {}, error: 'Connected account does not belong to this user' };
    // An account connected without calendar permission: Microsoft Graph answers every calendar call with 403.
    if (/^OUTLOOK_(GET_CALENDAR_VIEW|GET_EVENT|CALENDAR_CREATE_EVENT|UPDATE_CALENDAR_EVENT|DELETE_CALENDAR_EVENT|CANCEL_EVENT)$/.test(slug) && !FakeComposio.mayReadCalendar(box)) {
      return { successful: false, data: {}, error: '403 Forbidden: {"error":{"code":"ErrorAccessDenied","message":"Access is denied. Check credentials and try again."}}' };
    }
    const fail = this.failNext.get(slug);
    if (fail === 'error') {
      this.failNext.delete(slug);
      return { successful: false, data: {}, error: 'The provider refused the request (fake)' };
    }
    if (fail === 'timeout') {
      this.failNext.delete(slug);
      throw new Error('ETIMEDOUT (fake)');
    }
    const ok = (data: Record<string, unknown>): ToolResult => ({ successful: true, data, error: null });
    const refuse = (error: string): ToolResult => ({ successful: false, data: {}, error });
    /** The other people on an event: who a calendar tells about it. */
    const guestsOf = (e: FakeEvent) => e.attendees.filter((a) => a !== box.address);
    const WHO_IS_TOLD = ['all', 'externalOnly', 'none'];
    /** The wall-clock form Outlook's calendar tools take: no zone, no offset. */
    const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/;
    switch (slug) {
      case 'GMAIL_GET_PROFILE':
        return ok({ response_data: { emailAddress: box.address, messagesTotal: box.messages.length, threadsTotal: new Set(box.messages.map((m) => m.threadId)).size, historyId: '1' } });
      case 'GMAIL_FETCH_EMAILS': {
        const max = Number(args.max_results ?? 25);
        const start = Number(args.page_token ?? 0);
        const q = String(args.query ?? '');
        const after = /after:(\d+)/.exec(q)?.[1];
        const inSent = /in:sent/.test(q);
        let list = [...box.messages].sort((a, b) => b.at.getTime() - a.at.getTime());
        // Like Gmail, the trash and spam are left out unless they are asked for.
        if (args.include_spam_trash !== true) list = list.filter((m) => !m.labels.includes('TRASH') && !m.labels.includes('SPAM'));
        if (after) list = list.filter((m) => m.at.getTime() / 1000 >= Number(after));
        if (inSent) list = list.filter((m) => m.labels.includes('SENT'));
        const subject = /subject:"([^"]+)"/.exec(q)?.[1];
        if (subject) list = list.filter((m) => m.subject === subject);
        const page = list.slice(start, start + max);
        // Asked not to be verbose, the real tool promises ids, the time, the sender, the subject and the labels, and no body.
        const brief = (m: FakeMessage) => {
          const { messageText: _text, preview: _preview, attachmentList: _files, ...rest } = this.wire(m);
          return rest;
        };
        return ok({ messages: page.map((m) => (args.verbose === false ? brief(m) : this.wire(m))), nextPageToken: start + max < list.length ? String(start + max) : null, resultSizeEstimate: list.length });
      }
      case 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID': {
        const list = box.messages.filter((m) => m.threadId === args.thread_id).sort((a, b) => a.at.getTime() - b.at.getTime());
        return ok({ messages: list.map((m) => this.wire(m)), id: args.thread_id });
      }
      case 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID': {
        const m = box.messages.find((x) => x.id === args.message_id);
        return m ? ok(this.wire(m)) : { successful: false, data: {}, error: 'Message not found' };
      }
      case 'GMAIL_SEND_EMAIL':
      case 'GMAIL_REPLY_TO_THREAD': {
        const reply = slug === 'GMAIL_REPLY_TO_THREAD';
        const first = reply ? box.messages.find((m) => m.threadId === args.thread_id) : undefined;
        const attached = this.filesOf(slug, 'gmail', args.attachment);
        if ('error' in attached) return { successful: false, data: {}, error: attached.error };
        const msg: FakeMessage = {
          id: newId('m'),
          threadId: reply ? String(args.thread_id) : newId('t'),
          from: box.address,
          to: [String(args.recipient_email ?? ''), ...((args.extra_recipients as string[] | undefined) ?? [])].filter(Boolean),
          cc: (args.cc as string[] | undefined) ?? [],
          subject: reply ? `Re: ${(first?.subject ?? '').replace(/^Re:\s*/i, '')}` : String(args.subject ?? ''),
          body: String(reply ? args.message_body ?? '' : args.body ?? ''),
          at: new Date(),
          labels: ['SENT'],
          ...(attached.files.length ? { attachments: attached.files } : {}),
        };
        box.messages.push(msg);
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after send (fake)');
        }
        return ok({ response_data: { id: msg.id, threadId: msg.threadId, labelIds: msg.labels } });
      }
      case 'GMAIL_LIST_LABELS':
        return ok({ labels: [...['INBOX', 'SENT', 'UNREAD'].map((id) => ({ id, name: id, type: 'system' })), ...[...box.labels].map(([name, id]) => ({ id, name, type: 'user' }))] });
      case 'GMAIL_CREATE_LABEL': {
        const name = String(args.label_name ?? '');
        if (!name || /[,/]/.test(name) || box.labels.has(name)) return { successful: false, data: {}, error: 'Invalid or duplicate label name' };
        const id = `Label_${box.labels.size + 1}`;
        box.labels.set(name, id);
        return ok({ response_data: { id, name } });
      }
      case 'GMAIL_MODIFY_THREAD_LABELS': {
        const list = box.messages.filter((m) => m.threadId === args.thread_id);
        if (!list.length) return { successful: false, data: {}, error: 'Thread not found' };
        const add = (args.add_label_ids as string[] | undefined) ?? [];
        const remove = (args.remove_label_ids as string[] | undefined) ?? [];
        const real = new Set(['INBOX', 'SENT', 'UNREAD', ...box.labels.values()]);
        // Gmail refuses a label id it doesn't know, for adding and for removing.
        if ([...add, ...remove].some((id) => !real.has(id))) return { successful: false, data: {}, error: 'Invalid label id' };
        for (const m of list) m.labels = [...new Set([...m.labels.filter((l) => !remove.includes(l)), ...add])];
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the change (fake)');
        }
        return ok({ success: true, response_dict: { id: args.thread_id } });
      }
      case 'GOOGLECALENDAR_CREATE_EVENT': {
        const start = new Date(`${String(args.start_datetime)}${args.timezone === 'UTC' ? 'Z' : ''}`);
        const minutes = Number(args.event_duration_hour ?? 0) * 60 + Number(args.event_duration_minutes ?? 0);
        if (Number.isNaN(start.getTime()) || minutes <= 0 || Number(args.event_duration_minutes ?? 0) > 59) return { successful: false, data: {}, error: 'Invalid start or duration' };
        // Who is told about the event is one of three words; anything else is refused, as the real tool refuses it.
        if (!['all', 'externalOnly', 'none'].includes(args.send_updates as string)) return { successful: false, data: {}, error: 'Invalid send_updates' };
        const event = { id: newId('gev'), summary: String(args.summary ?? ''), start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), attendees: (args.attendees as string[] | undefined) ?? [], invited: args.send_updates === 'all' };
        box.events.push(event);
        if (event.invited && event.attendees.length) box.notices.push({ about: 'invited', event: event.id, to: [...event.attendees] });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was created (fake)');
        }
        return ok({ response_data: { id: event.id, summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end } } });
      }
      case 'GOOGLECALENDAR_EVENTS_LIST': {
        // Like Google: the events that overlap the span asked for, earliest first, a page at a time.
        const from = args.timeMin ? new Date(String(args.timeMin)).getTime() : -Infinity;
        const to = args.timeMax ? new Date(String(args.timeMax)).getTime() : Infinity;
        if (Number.isNaN(from) || Number.isNaN(to)) return refuse('Bad Request: timeMin and timeMax must be RFC3339 timestamps');
        const max = Number(args.maxResults ?? 250);
        const start = Number(args.pageToken ?? 0);
        const list = box.events.filter((e) => new Date(e.end).getTime() > from && new Date(e.start).getTime() < to).sort((a, b) => a.start.localeCompare(b.start));
        return ok({ items: list.slice(start, start + max).map((e) => this.googleEvent(box, e)), nextPageToken: start + max < list.length ? String(start + max) : null });
      }
      case 'GOOGLECALENDAR_EVENTS_GET': {
        if (typeof args.event_id !== 'string') return refuse('Invalid request data provided: event_id is required');
        const e = box.events.find((x) => x.id === args.event_id);
        // A deleted event is still shown for a while, as cancelled.
        if (!e) return box.cancelled.includes(args.event_id) ? ok({ id: args.event_id, status: 'cancelled' }) : refuse('Not Found');
        return ok(this.googleEvent(box, e));
      }
      case 'GOOGLECALENDAR_PATCH_EVENT': {
        if (typeof args.calendar_id !== 'string' || typeof args.event_id !== 'string') return refuse('Invalid request data provided: calendar_id and event_id are required');
        if (args.send_updates !== undefined && !WHO_IS_TOLD.includes(args.send_updates as string)) return refuse('Invalid send_updates');
        if (args.attendees !== undefined && !(Array.isArray(args.attendees) && args.attendees.every((a) => typeof a === 'string'))) return refuse('Invalid attendees: a list of email addresses is expected');
        const e = box.events.find((x) => x.id === args.event_id);
        if (!e) return refuse('Not Found');
        // What everyone on an event sees can only be changed by its organizer.
        if ((e.organizer ?? box.address) !== box.address) return refuse('Shared properties can only be changed by the organizer of the event (forbiddenForNonOrganizer)');
        // A time with no zone of its own is read as UTC, as the tool does when no `timezone` is given.
        const at = (v: unknown) => new Date(/(z|[+-]\d{2}:?\d{2})$/i.test(String(v)) ? String(v) : `${String(v)}Z`);
        const length = new Date(e.end).getTime() - new Date(e.start).getTime();
        const starts = args.start_time !== undefined ? at(args.start_time) : new Date(e.start);
        const ends = args.end_time !== undefined ? at(args.end_time) : args.start_time !== undefined ? new Date(starts.getTime() + length) : new Date(e.end);
        if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) return refuse('The specified time range is empty (timeRangeEmpty)');
        const before = guestsOf(e);
        if (typeof args.summary === 'string') e.summary = args.summary;
        if (typeof args.description === 'string') e.description = args.description || undefined;
        if (typeof args.location === 'string') e.location = args.location || undefined;
        if (args.attendees !== undefined) e.attendees = (args.attendees as string[]).map((a) => a.toLowerCase());
        e.start = starts.toISOString();
        e.end = ends.toISOString();
        // Google tells the guests only when asked to: those who stay, those who were added and those who were taken off.
        const told = [...new Set([...before, ...guestsOf(e)])];
        if (args.send_updates === 'all' && told.length) box.notices.push({ about: 'changed', event: e.id, to: told });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was changed (fake)');
        }
        return ok(this.googleEvent(box, e));
      }
      case 'GOOGLECALENDAR_DELETE_EVENT': {
        if (typeof args.event_id !== 'string') return refuse('Invalid request data provided: event_id is required');
        if (args.send_updates !== undefined && !WHO_IS_TOLD.includes(args.send_updates as string)) return refuse('Invalid send_updates');
        const i = box.events.findIndex((x) => x.id === args.event_id);
        if (i < 0) return refuse(box.cancelled.includes(args.event_id) ? 'Resource has been deleted' : 'Not Found');
        const [e] = box.events.splice(i, 1);
        box.cancelled.push(e!.id);
        if ((e!.organizer ?? box.address) === box.address && args.send_updates === 'all' && guestsOf(e!).length) box.notices.push({ about: 'cancelled', event: e!.id, to: guestsOf(e!) });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was deleted (fake)');
        }
        return ok({ response_data: { status: 'success' } });
      }
      /* ───── Outlook ───── */
      case 'OUTLOOK_GET_PROFILE':
        return ok({ id: 'user-1', mail: box.address, userPrincipalName: box.address, displayName: 'Stand-in person' });
      case 'OUTLOOK_GET_MAIL_FOLDER': {
        const name = String(args.mail_folder_id ?? '').toLowerCase();
        if (!['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'].includes(name) || (name === 'archive' && box.noArchive)) return { successful: false, data: {}, error: 'The specified folder could not be found in the store. (ErrorFolderNotFound)' };
        return ok({ id: `fld-${name}`, displayName: name });
      }
      case 'OUTLOOK_CREATE_MAIL_FOLDER': {
        const name = String(args.display_name ?? '').trim();
        if (!name) return refuse('Invalid request data provided: display_name is required');
        // A top-level folder of the same name: Outlook refuses a second one, or hands back the first when asked to.
        const existing = name.toLowerCase() === 'archive' && !box.noArchive ? 'fld-archive' : [...(box.folders ?? [])].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
        if (existing) return args.return_existing_if_exists === true ? ok({ id: existing, displayName: name, parentFolderId: 'fld-root', childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0, isHidden: false }) : refuse('A folder with the specified name already exists. (ErrorFolderExists)');
        box.folders = box.folders ?? new Map();
        const id = `fld-made-${box.folders.size + 1}-${randomBytes(4).toString('hex')}`;
        box.folders.set(name, id);
        return ok({ id, displayName: name, parentFolderId: 'fld-root', childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0, isHidden: args.is_hidden === true });
      }
      case 'OUTLOOK_DELETE_MESSAGE': {
        if (typeof args.message_id !== 'string') return refuse('Invalid request data provided: message_id is required');
        const i = box.messages.findIndex((x) => x.id === args.message_id);
        if (i < 0) return refuse('The specified object was not found in the store. (ErrorItemNotFound)');
        box.messages.splice(i, 1);
        return ok({});
      }
      case 'OUTLOOK_LIST_MESSAGES': {
        const filter = String(args.filter ?? '');
        // Outlook refuses to sort a filtered list unless the filter starts with the property it sorts by.
        if (filter && !/^receivedDateTime /.test(filter)) return { successful: false, data: {}, error: 'InefficientFilter: the restriction or sort order is too complex for this operation' };
        const conversation = /conversationId eq '((?:[^']|'')*)'/.exec(filter)?.[1]?.replace(/''/g, "'");
        const since = args.received_date_time_ge ? new Date(String(args.received_date_time_ge)).getTime() : 0;
        if (Number.isNaN(since)) return { successful: false, data: {}, error: 'Invalid date' };
        const folder = String(args.folder ?? 'inbox').toLowerCase();
        const max = Number(args.top ?? 10);
        const start = Number(args.page_token ?? 0);
        let list = [...box.messages].sort((a, b) => b.at.getTime() - a.at.getTime()).filter((m) => m.at.getTime() >= since);
        if (conversation !== undefined) list = list.filter((m) => m.threadId === conversation);
        if (folder === 'archive' && box.noArchive) return refuse('The specified folder could not be found in the store. (ErrorFolderNotFound)');
        if (folder !== 'allfolders') list = list.filter((m) => this.graph(m, box).parentFolderId === (folder.startsWith('fld-') ? folder : `fld-${folder}`));
        const page = list.slice(start, start + max);
        // Like Outlook, only the properties that were selected come back (the id always does).
        const select = Array.isArray(args.select) ? (args.select as string[]) : null;
        const only = (g: Record<string, unknown>) => (select ? Object.fromEntries(Object.entries(g).filter(([k]) => k === 'id' || select.includes(k))) : g);
        return ok({ value: page.map((m) => only(this.graph(m, box))), ...(start + max < list.length ? { next_page_token: String(start + max) } : {}) });
      }
      case 'OUTLOOK_CREATE_DRAFT': {
        const attached = this.filesOf(slug, 'outlook', args.attachment);
        if ('error' in attached) return { successful: false, data: {}, error: attached.error };
        const msg: FakeMessage = { id: newId('om'), threadId: newId('conv'), from: box.address, to: ((args.to_recipients as string[] | undefined) ?? []).map(String), cc: ((args.cc_recipients as string[] | undefined) ?? []).map(String), subject: String(args.subject ?? ''), body: String(args.body ?? ''), at: new Date(), labels: ['DRAFT'], ...(attached.files.length ? { attachments: attached.files } : {}) };
        box.messages.push(msg);
        return ok(this.graph(msg, box));
      }
      case 'OUTLOOK_CREATE_DRAFT_REPLY': {
        const original = box.messages.find((m) => m.id === args.message_id);
        if (!original) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        // Outlook addresses the reply itself, to whoever wrote the message, and quotes that message under a rule.
        const author = /<([^<>]+)>\s*$/.exec(original.from)?.[1] ?? original.from;
        const msg: FakeMessage = { id: newId('om'), threadId: original.threadId, from: box.address, to: [author], cc: [], subject: `Re: ${original.subject.replace(/^Re:\s*/i, '')}`, body: '', html: `<html><head></head><body><hr><div><b>From:</b> ${author}</div><div>${original.body}</div></body></html>`, at: new Date(), labels: ['DRAFT'] };
        box.messages.push(msg);
        return ok(this.graph(msg, box));
      }
      case 'OUTLOOK_UPDATE_EMAIL': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        const list = (v: unknown) => (v as { address?: string }[]).map((r) => String(r.address ?? ''));
        if (args.to_recipients) m.to = list(args.to_recipients);
        if (args.cc_recipients) m.cc = list(args.cc_recipients);
        if (args.categories) m.categories = (args.categories as string[]).map(String);
        if (args.body) {
          const b = args.body as { contentType?: string; content?: string };
          if (String(b.contentType).toLowerCase() === 'html') {
            m.html = String(b.content ?? '');
            // What a reader sees above the rule: the reply itself, without the quoted message.
            m.body = htmlToText(m.html.split(/<hr\b/i)[0]!);
          } else m.body = String(b.content ?? '');
        }
        return ok(this.graph(m, box));
      }
      case 'OUTLOOK_ADD_MAIL_ATTACHMENT': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m || !m.labels.includes('DRAFT')) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        const attached = this.filesOf(slug, 'outlook', args.attachment, true);
        if ('error' in attached) return { successful: false, data: {}, error: attached.error };
        if (attached.files.length !== 1) return { successful: false, data: {}, error: 'Either attachment or contentBytes is required' };
        // The tool is for small files. Microsoft takes under 3 MB this way; anything larger needs an upload session.
        if (attached.files[0]!.size >= 3 * 1024 * 1024) return { successful: false, data: {}, error: 'The attachment is too large for this request (3 MB); use an upload session' };
        // 'dropped' answers as if all went well and keeps nothing, to show the check made before sending.
        if (fail === 'dropped') this.failNext.delete(slug);
        else m.attachments = [...(m.attachments ?? []), attached.files[0]!];
        return ok({ '@odata.type': '#microsoft.graph.fileAttachment', id: newId('att'), name: attached.files[0]!.name, size: attached.files[0]!.size, isInline: false, lastModifiedDateTime: new Date().toISOString() });
      }
      case 'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        // The size given is deliberately not the file's own length: Microsoft's figure can count wrapping around the
        // file, so the check made before sending goes by name and must not depend on size.
        return ok({ response_data: { value: (m.attachments ?? []).map((a, i) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: `att-${m.id}-${i}`, name: a.name, contentType: a.mimetype, size: a.size + 172, isInline: !!a.inline })) } });
      }
      case 'OUTLOOK_SEND_DRAFT': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m || !m.labels.includes('DRAFT')) return { successful: false, data: {}, error: 'The message is not a draft' };
        if (!m.to.length) return { successful: false, data: {}, error: 'At least one recipient is required' };
        m.labels = ['SENT'];
        m.at = new Date();
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after send (fake)');
        }
        return ok({});
      }
      case 'OUTLOOK_BATCH_UPDATE_MESSAGES':
      case 'OUTLOOK_BATCH_MOVE_MESSAGES': {
        const move = slug === 'OUTLOOK_BATCH_MOVE_MESSAGES';
        const items = move ? ((args.message_ids as string[] | undefined) ?? []).map((id) => ({ message_id: id, patch: {} as { categories?: string[] } })) : ((args.updates as { message_id: string; patch: { categories?: string[] } }[] | undefined) ?? []);
        if (!items.length || items.length > 20) return { successful: false, data: {}, error: 'A batch takes between 1 and 20 messages' };
        const to = String(args.destination_id ?? '').toLowerCase();
        // A folder made later and named Archive is where archived mail goes in a mailbox without the well-known one.
        const madeArchive = !!to && [...(box.folders ?? [])].some(([n, id]) => n === 'Archive' && id.toLowerCase() === to);
        // Each move in the batch is its own request: in a mailbox with no Archive folder every one of them fails.
        if (move && to === 'archive' && box.noArchive) return ok({ results: items.map((it) => ({ message_id: it.message_id, success: false, error: 'The specified folder could not be found in the store. (ErrorFolderNotFound)' })), total_requested: items.length, total_succeeded: 0, total_failed: items.length });
        if (move && !['inbox', 'archive'].includes(to) && !madeArchive) return { successful: false, data: {}, error: 'The destination folder could not be found' };
        // 'partial' applies the first change of the batch and refuses the rest, as a throttled mailbox does.
        const partial = fail === 'partial';
        if (partial) this.failNext.delete(slug);
        let done = 0;
        const results = items.map((it, i) => {
          const m = box.messages.find((x) => x.id === it.message_id);
          if (!m || (partial && i > 0)) return { message_id: it.message_id, success: false };
          if (move) m.labels = [...m.labels.filter((l) => l !== 'INBOX' && l !== 'ARCHIVE'), to === 'inbox' ? 'INBOX' : 'ARCHIVE'];
          else if (it.patch.categories) m.categories = it.patch.categories.map(String);
          done++;
          return { message_id: it.message_id, success: true };
        });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the change (fake)');
        }
        return ok({ results, total_requested: items.length, total_succeeded: done, total_failed: items.length - done });
      }
      /* ───── Outlook's calendar ───── */
      case 'OUTLOOK_GET_CALENDAR_VIEW': {
        const from = new Date(String(args.start_datetime ?? ''));
        const to = new Date(String(args.end_datetime ?? ''));
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return refuse('Invalid request data provided: start_datetime and end_datetime are required ISO 8601 date-times');
        const top = Number(args.top ?? 20);
        if (!(Number.isInteger(top) && top >= 1 && top <= 1000)) return refuse('Invalid request data provided: top must be between 1 and 1000');
        if (args.timezone !== undefined && args.timezone !== 'UTC') return refuse('The stand-in calendar only answers in UTC');
        const start = Number(args.page_token ?? 0);
        // What comes back when nothing is selected. `isOrganizer` is not on Outlook's own default list.
        const select = Array.isArray(args.select) ? (args.select as string[]) : ['id', 'subject', 'start', 'end', 'location', 'attendees', 'organizer', 'isAllDay', 'isCancelled', 'showAs', 'importance', 'responseStatus', 'webLink', 'bodyPreview', 'categories', 'sensitivity'];
        const list = box.events.filter((e) => new Date(e.end) > from && new Date(e.start) < to).sort((a, b) => a.start.localeCompare(b.start));
        return ok({ value: list.slice(start, start + top).map((e) => this.graphEvent(box, e, select)), ...(start + top < list.length ? { next_page_token: String(start + top) } : {}) });
      }
      case 'OUTLOOK_GET_EVENT': {
        if (typeof args.event_id !== 'string') return refuse('Invalid request data provided: event_id is required');
        const e = box.events.find((x) => x.id === args.event_id);
        return e ? ok(this.graphEvent(box, e)) : refuse('The specified object was not found in the store. (ErrorItemNotFound)');
      }
      case 'OUTLOOK_CALENDAR_CREATE_EVENT': {
        if (typeof args.subject !== 'string' || typeof args.time_zone !== 'string' || !WALL_CLOCK.test(String(args.start_datetime ?? '')) || !WALL_CLOCK.test(String(args.end_datetime ?? ''))) return refuse('Invalid request data provided: subject, start_datetime, end_datetime and time_zone are required, and the times are wall-clock times with no zone');
        if (args.time_zone !== 'UTC') return refuse('The stand-in calendar only keeps UTC');
        const starts = new Date(`${String(args.start_datetime)}Z`);
        const ends = new Date(`${String(args.end_datetime)}Z`);
        if (!(starts < ends)) return refuse('The start time must be before the end time');
        // Each attendee is an object of text fields with an address in `email`.
        const info = (args.attendees_info ?? []) as unknown;
        const person = (a: unknown): a is { email: string } => typeof a === 'object' && a !== null && typeof (a as { email?: unknown }).email === 'string' && Object.values(a).every((v) => typeof v === 'string');
        if (!Array.isArray(info) || !info.every(person)) return refuse('Invalid request data provided: attendees_info is a list of attendees, each with an email');
        const attendees = (info as { email: string }[]).map((a) => a.email.toLowerCase());
        // Outlook's ids are long and carry characters ("=", "-", "_") that Timmy's own ids do not.
        const event: FakeEvent = { id: `AAMkAG${randomBytes(48).toString('base64url')}AAA=`, summary: args.subject, start: starts.toISOString(), end: ends.toISOString(), attendees, ...(args.body ? { description: String(args.body) } : {}), ...(args.location ? { location: String(args.location) } : {}), invited: attendees.length > 0 };
        box.events.push(event);
        // Outlook sends the invitations itself whenever a new event has attendees.
        if (attendees.length) box.notices.push({ about: 'invited', event: event.id, to: [...attendees] });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was created (fake)');
        }
        return ok(this.graphEvent(box, event));
      }
      case 'OUTLOOK_UPDATE_CALENDAR_EVENT': {
        if (typeof args.event_id !== 'string') return refuse('Invalid request data provided: event_id is required');
        for (const k of ['start_datetime', 'end_datetime']) if (args[k] !== undefined && !WALL_CLOCK.test(String(args[k]))) return refuse(`Invalid request data provided: ${k} is a wall-clock time with no zone`);
        if (args.time_zone !== undefined && args.time_zone !== 'UTC') return refuse('The stand-in calendar only keeps UTC');
        const listed = (a: unknown): a is { emailAddress: { address: string; name?: string }; type: string } => typeof a === 'object' && a !== null && typeof (a as { type?: unknown }).type === 'string' && typeof (a as { emailAddress?: { address?: unknown } }).emailAddress?.address === 'string';
        if (args.attendees !== undefined && !(Array.isArray(args.attendees) && args.attendees.every(listed))) return refuse('Invalid request data provided: each attendee needs an emailAddress with an address, and a type');
        const body = args.body as { contentType?: unknown; content?: unknown } | undefined;
        if (body !== undefined && !(typeof body === 'object' && body !== null && ['text', 'html'].includes(String(body.contentType).toLowerCase()) && typeof body.content === 'string')) return refuse('Invalid request data provided: body needs a contentType of Text or HTML, and content');
        const e = box.events.find((x) => x.id === args.event_id);
        if (!e) return refuse('The specified object was not found in the store. (ErrorItemNotFound)');
        // A meeting can only be changed by its organizer.
        if ((e.organizer ?? box.address) !== box.address) return refuse('You can’t change this meeting because you are not its organizer. (ErrorAccessDenied)');
        const starts = args.start_datetime !== undefined ? new Date(`${String(args.start_datetime)}Z`) : new Date(e.start);
        const ends = args.end_datetime !== undefined ? new Date(`${String(args.end_datetime)}Z`) : new Date(e.end);
        if (!(starts < ends)) return refuse('The start time must be before the end time');
        const before = guestsOf(e);
        if (typeof args.subject === 'string') e.summary = args.subject;
        if (body) e.description = (String(body.contentType).toLowerCase() === 'html' ? htmlToText(body.content as string) : (body.content as string)) || undefined;
        if (typeof args.location === 'string') e.location = args.location || undefined;
        if (args.attendees !== undefined) e.attendees = (args.attendees as { emailAddress: { address: string } }[]).map((a) => a.emailAddress.address.toLowerCase());
        e.start = starts.toISOString();
        e.end = ends.toISOString();
        // Outlook tells everyone on a meeting when its organizer changes it. Nobody asks it to, and nobody can ask it not to.
        const told = [...new Set([...before, ...guestsOf(e)])];
        if (told.length) box.notices.push({ about: 'changed', event: e.id, to: told });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was changed (fake)');
        }
        return ok(this.graphEvent(box, e));
      }
      case 'OUTLOOK_DELETE_CALENDAR_EVENT':
      case 'OUTLOOK_CANCEL_EVENT': {
        const cancel = slug === 'OUTLOOK_CANCEL_EVENT';
        if (typeof args.event_id !== 'string' || (cancel && typeof args.user_id !== 'string')) return refuse(`Invalid request data provided: ${cancel ? 'user_id and event_id are' : 'event_id is'} required`);
        const i = box.events.findIndex((x) => x.id === args.event_id);
        if (i < 0) return refuse('The specified object was not found in the store. (ErrorItemNotFound)');
        const e = box.events[i]!;
        const organizes = (e.organizer ?? box.address) === box.address;
        // Cancelling is for a meeting, by its organizer: it is what tells the attendees.
        if (cancel && !organizes) return refuse('Your request can’t be completed. You need to be an organizer to cancel a meeting.');
        if (cancel && !guestsOf(e).length) return refuse('Your request can’t be completed. Only a meeting with attendees can be cancelled.');
        box.events.splice(i, 1);
        box.cancelled.push(e.id);
        // Deleting a meeting from its organizer's calendar tells the attendees too.
        if (organizes && guestsOf(e).length) box.notices.push({ about: 'cancelled', event: e.id, to: guestsOf(e) });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was deleted (fake)');
        }
        return ok(cancel ? { message: 'Event canceled successfully.', success: true, user_id: args.user_id, event_id: args.event_id } : {});
      }
      /* ───── Google Drive ───── */
      case 'GOOGLEDRIVE_GET_ABOUT':
        return ok({ user: { emailAddress: box.address, displayName: 'Stand-in person' } });
      case 'GOOGLEDRIVE_FIND_FILE': {
        const q = String(args.q ?? '');
        const since = /modifiedTime > '([^']+)'/.exec(q)?.[1];
        const max = Number(args.pageSize ?? 100);
        const start = Number(args.pageToken ?? 0);
        let list = [...box.files].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
        if (since) list = list.filter((f) => new Date(f.modifiedTime).getTime() > new Date(since).getTime());
        if (/trashed = false/.test(q)) list = list.filter((f) => !f.trashed);
        if (/trashed = true/.test(q)) list = list.filter((f) => f.trashed);
        // Files someone else owns and shared with the person, most recently shared first when asked that way.
        if (/sharedWithMe = true/.test(q)) list = list.filter((f) => f.owner !== box.address);
        if (/^sharedWithMeTime desc$/.test(String(args.orderBy ?? ''))) list.sort((a, b) => (b.sharedAt ?? b.modifiedTime).localeCompare(a.sharedAt ?? a.modifiedTime));
        if (/mimeType != 'application\/vnd\.google-apps\.folder'/.test(q)) list = list.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
        const page = list.slice(start, start + max);
        const wire = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, createdTime: f.modifiedTime, trashed: !!f.trashed, webViewLink: f.link ?? `https://docs.google.com/document/d/${f.id}/edit`, shared: f.owner !== box.address, owners: [{ displayName: f.owner.split('@')[0], emailAddress: f.owner }] });
        // Like Drive itself, the stand-in returns only what `fields` names: without nextPageToken there, a long list just ends.
        const wantsToken = !args.fields || /(^|,)\s*nextPageToken\s*(,|$)/.test(String(args.fields));
        return ok({ files: page.map(wire), ...(wantsToken && start + max < list.length ? { nextPageToken: String(start + max) } : {}) });
      }
      case 'GOOGLEDRIVE_GET_DOCUMENT': {
        const f = box.files.find((x) => x.id === args.document_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.document') return { successful: false, data: {}, error: 'Requested entity was not found' };
        // Google's own structure: paragraphs made of text runs, each ending in a line break.
        return ok({ documentId: f.id, title: f.name, body: { content: (f.text ?? '').split('\n').map((line) => ({ paragraph: { elements: [{ textRun: { content: `${line}\n` } }] } })) } });
      }
      case 'GOOGLEDRIVE_GET_SPREADSHEET_VALUES': {
        const f = box.files.find((x) => x.id === args.spreadsheet_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.spreadsheet' || typeof args.range !== 'string') return { successful: false, data: {}, error: 'Requested entity was not found' };
        return ok({ range: `Sheet1!${args.range}`, majorDimension: 'ROWS', values: (f.rows ?? []).slice(0, 200) });
      }
      case 'GOOGLEDRIVE_GET_PRESENTATION': {
        const f = box.files.find((x) => x.id === args.presentation_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.presentation') return { successful: false, data: {}, error: 'Requested entity was not found' };
        return ok({ title: f.name, slides: (f.text ?? '').split('\n\n').map((slide) => ({ pageElements: [{ shape: { text: { textElements: [{ textRun: { content: slide } }] } } }] })) });
      }
      default:
        // OneDrive, and the Drive tools only the nightly check uses, are answered in composio-files.ts.
        return fakeFileTool(this, who.connectedAccountId, box, slug, args) ?? { successful: false, data: {}, error: `The fake provider has no tool called ${slug}` };
    }
  }

  /** Messages this account has sent, for assertions. */
  sent(connectedAccountId: string): FakeMessage[] {
    return (this.accounts.get(connectedAccountId)?.messages ?? []).filter((m) => m.labels.includes('SENT'));
  }
}
