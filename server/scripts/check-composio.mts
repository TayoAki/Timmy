/**
 * Checks the Composio tools this server calls against Composio itself, at the toolkit versions pinned in config:
 * that each tool exists at that version, and that every argument the code sends is one the tool takes.
 *
 * The stand-in provider used by the tests answers whatever the code asks, so it cannot notice a tool that was
 * renamed or an argument that changed type. This can. Run it before moving a pinned version forward:
 *
 *   COMPOSIO_API_KEY=... npx tsx scripts/check-composio.mts
 *
 * It only reads tool definitions. It needs no connected account and runs no tool.
 */
import { config } from '../src/config';

/** Every tool the server calls, with the arguments it sends. Keep in step with src/sync and src/gateway. */
const TOOLS: Record<string, Record<string, string[]>> = {
  gmail: {
    GMAIL_GET_PROFILE: [],
    GMAIL_FETCH_EMAILS: ['query', 'max_results', 'include_payload', 'page_token', 'verbose', 'include_spam_trash'],
    GMAIL_FETCH_MESSAGE_BY_THREAD_ID: ['thread_id'],
    GMAIL_SEND_EMAIL: ['recipient_email', 'extra_recipients', 'cc', 'subject', 'body', 'is_html', 'include_signature', 'attachment'],
    GMAIL_REPLY_TO_THREAD: ['thread_id', 'message_body', 'recipient_email', 'extra_recipients', 'cc', 'is_html', 'include_signature', 'attachment'],
    GMAIL_LIST_LABELS: [],
    GMAIL_CREATE_LABEL: ['label_name', 'label_list_visibility', 'message_list_visibility'],
    GMAIL_MODIFY_THREAD_LABELS: ['thread_id', 'add_label_ids', 'remove_label_ids'],
  },
  googlecalendar: {
    GOOGLECALENDAR_CREATE_EVENT: ['calendar_id', 'summary', 'start_datetime', 'timezone', 'event_duration_hour', 'event_duration_minutes', 'attendees', 'description', 'send_updates', 'create_meeting_room'],
    GOOGLECALENDAR_EVENTS_LIST: ['calendarId', 'timeMin', 'timeMax', 'singleEvents', 'orderBy', 'maxResults', 'pageToken'],
    GOOGLECALENDAR_EVENTS_GET: ['calendar_id', 'event_id'],
    GOOGLECALENDAR_PATCH_EVENT: ['calendar_id', 'event_id', 'summary', 'start_time', 'end_time', 'description', 'attendees', 'send_updates'],
    GOOGLECALENDAR_DELETE_EVENT: ['calendar_id', 'event_id', 'send_updates'],
  },
  outlook: {
    OUTLOOK_GET_PROFILE: [],
    OUTLOOK_GET_MAIL_FOLDER: ['mail_folder_id', 'select'],
    OUTLOOK_LIST_MESSAGES: ['folder', 'select', 'orderby', 'received_date_time_ge', 'top', 'page_token', 'filter'],
    OUTLOOK_CREATE_DRAFT: ['subject', 'body', 'is_html', 'to_recipients', 'cc_recipients'],
    OUTLOOK_CREATE_DRAFT_REPLY: ['message_id'],
    // Files are added to the draft one at a time (a reply draft can't be made with files on it), and the draft is listed before it is sent.
    OUTLOOK_ADD_MAIL_ATTACHMENT: ['message_id', 'attachment'],
    OUTLOOK_LIST_OUTLOOK_ATTACHMENTS: ['message_id', 'response_detail'],
    OUTLOOK_UPDATE_EMAIL: ['message_id', 'to_recipients', 'cc_recipients', 'body'],
    OUTLOOK_SEND_DRAFT: ['message_id'],
    OUTLOOK_BATCH_UPDATE_MESSAGES: ['updates'],
    OUTLOOK_BATCH_MOVE_MESSAGES: ['message_ids', 'destination_id'],
    OUTLOOK_GET_CALENDAR_VIEW: ['start_datetime', 'end_datetime', 'timezone', 'select', 'orderby', 'top', 'page_token'],
    OUTLOOK_GET_EVENT: ['event_id'],
    OUTLOOK_CALENDAR_CREATE_EVENT: ['subject', 'start_datetime', 'end_datetime', 'time_zone', 'body', 'is_html', 'attendees_info'],
    OUTLOOK_UPDATE_CALENDAR_EVENT: ['event_id', 'subject', 'start_datetime', 'end_datetime', 'time_zone', 'body', 'attendees'],
    OUTLOOK_DELETE_CALENDAR_EVENT: ['event_id'],
    OUTLOOK_CANCEL_EVENT: ['user_id', 'event_id'],
  },
  googledrive: {
    GOOGLEDRIVE_GET_ABOUT: ['fields'],
    GOOGLEDRIVE_FIND_FILE: ['q', 'fields', 'orderBy', 'pageSize', 'pageToken'],
    GOOGLEDRIVE_GET_DOCUMENT: ['document_id'],
    GOOGLEDRIVE_GET_SPREADSHEET_VALUES: ['spreadsheet_id', 'range'],
    GOOGLEDRIVE_GET_PRESENTATION: ['presentation_id', 'fields'],
  },
};

/** The events the server subscribes to, with the settings it sends when subscribing. */
const TRIGGERS: Record<string, Record<string, string[]>> = {
  gmail: { GMAIL_NEW_GMAIL_MESSAGE: ['labelIds'], GMAIL_EMAIL_SENT_TRIGGER: [] },
  googlecalendar: { GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER: ['calendarId'] },
  outlook: { OUTLOOK_MESSAGE_TRIGGER: [], OUTLOOK_SENT_MESSAGE_TRIGGER: [], OUTLOOK_EVENT_CHANGE_TRIGGER: [] },
  googledrive: { GOOGLEDRIVE_FILE_CREATED_TRIGGER: [], GOOGLEDRIVE_FILE_UPDATED_TRIGGER: [], GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER: [] },
};

/** A few argument types the code depends on. A change here once went unnoticed (send_updates was yes/no, then a word). */
const TYPES: Record<string, Record<string, string>> = {
  GOOGLECALENDAR_CREATE_EVENT: { send_updates: 'string', create_meeting_room: 'boolean' },
  // The look at the mailbox for changes: without these two as yes/no, the trash would be left out or bodies fetched.
  GMAIL_FETCH_EMAILS: { verbose: 'boolean', include_spam_trash: 'boolean', max_results: 'integer' },
  OUTLOOK_LIST_MESSAGES: { select: 'array', top: 'integer' },
  GMAIL_SEND_EMAIL: { include_signature: 'boolean' },
  GMAIL_REPLY_TO_THREAD: { include_signature: 'boolean' },
  OUTLOOK_CREATE_DRAFT: { to_recipients: 'array' },
  // This one takes a single file, where the send tools take one or a list.
  OUTLOOK_ADD_MAIL_ATTACHMENT: { attachment: 'object' },
  OUTLOOK_BATCH_UPDATE_MESSAGES: { updates: 'array' },
  // Who is told about a calendar write is a word, and the guest lists are lists; Outlook's event body is text on
  // create and an object (a kind and the content) on update.
  GOOGLECALENDAR_PATCH_EVENT: { send_updates: 'string', attendees: 'array', start_time: 'string', end_time: 'string' },
  GOOGLECALENDAR_DELETE_EVENT: { send_updates: 'string' },
  OUTLOOK_GET_CALENDAR_VIEW: { select: 'array', top: 'integer', orderby: 'string' },
  OUTLOOK_CALENDAR_CREATE_EVENT: { attendees_info: 'array', body: 'string', is_html: 'boolean' },
  OUTLOOK_UPDATE_CALENDAR_EVENT: { attendees: 'array', body: 'object' },
};

interface Listed {
  slug: string;
  version?: string;
  deprecated?: { is_deprecated?: boolean } | null;
  input_parameters?: { properties?: Record<string, { type?: string }> };
  config?: { properties?: Record<string, unknown> };
}

const key = process.env.COMPOSIO_API_KEY;
if (!key) {
  console.error('Set COMPOSIO_API_KEY to run this check.');
  process.exit(2);
}

async function list(path: string): Promise<Listed[]> {
  const res = await fetch(`https://backend.composio.dev/api/v3/${path}`, { headers: { 'x-api-key': key! } });
  if (!res.ok) throw new Error(`Composio answered ${res.status} for ${path.split('?')[0]}`);
  return ((await res.json()) as { items?: Listed[] }).items ?? [];
}

let problems = 0;
const problem = (text: string) => {
  problems++;
  console.log(`  PROBLEM  ${text}`);
};

for (const [toolkit, tools] of Object.entries(TOOLS)) {
  const version = config.composio.toolkitVersions[toolkit];
  console.log(`${toolkit} at ${version ?? '(no version pinned)'}`);
  if (!version) {
    problem(`${toolkit} has no pinned version`);
    continue;
  }
  const bySlug = new Map((await list(`tools?toolkit_slug=${toolkit}&toolkit_versions=${version}&limit=1000`)).map((t) => [t.slug, t]));
  for (const [slug, args] of Object.entries(tools)) {
    const tool = bySlug.get(slug);
    if (!tool) {
      problem(`${slug} does not exist at this version`);
      continue;
    }
    if (tool.version && tool.version !== version) problem(`${slug} came back at version ${tool.version}, not the pinned one`);
    const takes = tool.input_parameters?.properties ?? {};
    for (const a of args) if (!Object.hasOwn(takes, a)) problem(`${slug} does not take “${a}”`);
    for (const [a, type] of Object.entries(TYPES[slug] ?? {})) if (takes[a]?.type !== type) problem(`${slug}.${a} is ${takes[a]?.type ?? 'missing'}, the code sends ${type}`);
    // A deprecated tool still works at its pinned version, but it is the one to move off before the next version bump.
    if (tool.deprecated?.is_deprecated) problem(`${slug} is marked deprecated`);
  }
  const triggers = new Map((await list(`triggers_types?toolkit_slugs=${toolkit}&toolkit_versions=${version}&limit=100`)).map((t) => [t.slug, t]));
  for (const [slug, settings] of Object.entries(TRIGGERS[toolkit] ?? {})) {
    const trigger = triggers.get(slug);
    if (!trigger) {
      problem(`the event ${slug} does not exist at this version`);
      continue;
    }
    for (const s of settings) if (!Object.hasOwn(trigger.config?.properties ?? {}, s)) problem(`the event ${slug} has no setting “${s}”`);
  }
  console.log(`  checked ${Object.keys(tools).length} tools and ${Object.keys(TRIGGERS[toolkit] ?? {}).length} events`);
}

console.log(problems ? `\n${problems} problem(s). Fix the code or keep the older version pinned.` : '\nEvery tool and event the server uses exists at its pinned version and takes the arguments the code sends.');
process.exit(problems ? 1 : 0);
