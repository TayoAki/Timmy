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
    // Reading one email as its sender laid it out (mail/original.ts).
    GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: ['message_id', 'format'],
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
    OUTLOOK_GET_MESSAGE: ['message_id', 'select'],
    OUTLOOK_CREATE_DRAFT: ['subject', 'body', 'is_html', 'to_recipients', 'cc_recipients'],
    OUTLOOK_CREATE_DRAFT_REPLY: ['message_id'],
    // Files are added to the draft one at a time (a reply draft can't be made with files on it), and the draft is listed before it is sent.
    OUTLOOK_ADD_MAIL_ATTACHMENT: ['message_id', 'attachment'],
    OUTLOOK_LIST_OUTLOOK_ATTACHMENTS: ['message_id', 'response_detail'],
    OUTLOOK_UPDATE_EMAIL: ['message_id', 'to_recipients', 'cc_recipients', 'body'],
    OUTLOOK_SEND_DRAFT: ['message_id'],
    OUTLOOK_BATCH_UPDATE_MESSAGES: ['updates'],
    OUTLOOK_BATCH_MOVE_MESSAGES: ['message_ids', 'destination_id'],
    // A mailbox with no Archive folder gets one the first time a thread is archived; a send that stops before its draft is sent removes that draft.
    OUTLOOK_CREATE_MAIL_FOLDER: ['display_name', 'return_existing_if_exists'],
    OUTLOOK_DELETE_MESSAGE: ['message_id'],
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
    // A Google Doc too long to come back whole, as plain text (files.ts).
    GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE: ['fileId', 'mimeType'],
    GOOGLEDRIVE_GET_SPREADSHEET_VALUES: ['spreadsheet_id', 'range'],
    GOOGLEDRIVE_GET_PRESENTATION: ['presentation_id', 'fields'],
    // The nightly look for files thrown away or gone without an announcement; a file's version when it is edited in Timmy.
    GOOGLEDRIVE_GET_FILE_METADATA: ['fileId', 'fields'],
    // Editing in Timmy (files/drive-edit.ts): an Office or PDF file kept in Drive, and saving an edit over the original.
    GOOGLEDRIVE_DOWNLOAD_FILE: ['fileId'],
    GOOGLEDRIVE_UPLOAD_UPDATE_FILE: ['fileId', 'file_to_upload', 'uploadType'],
  },
  // OneDrive is only read: whose drive it is, its list of changes, and a file's bytes to read a Word, Excel or PowerPoint file.
  one_drive: {
    ONE_DRIVE_LIST_DRIVES: ['select'],
    ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: ['top', 'select', 'token'],
    ONE_DRIVE_DOWNLOAD_FILE: ['item_id', 'file_name', 'drive_id'],
  },
};

/** The events the server subscribes to, with the settings it sends when subscribing. */
const TRIGGERS: Record<string, Record<string, string[]>> = {
  gmail: { GMAIL_NEW_GMAIL_MESSAGE: ['labelIds'], GMAIL_EMAIL_SENT_TRIGGER: [] },
  googlecalendar: { GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER: ['calendarId'] },
  outlook: { OUTLOOK_MESSAGE_TRIGGER: [], OUTLOOK_SENT_MESSAGE_TRIGGER: [], OUTLOOK_EVENT_CHANGE_TRIGGER: [] },
  googledrive: { GOOGLEDRIVE_FILE_CREATED_TRIGGER: [], GOOGLEDRIVE_FILE_UPDATED_TRIGGER: [], GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER: [] },
  one_drive: { ONE_DRIVE_FILE_CREATED_TRIGGER: [], ONE_DRIVE_ITEM_UPDATED_TRIGGER: [], ONE_DRIVE_ITEM_DELETED_TRIGGER: [] },
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
  // Without it a second filing would be refused because the folder the first one made is there.
  OUTLOOK_CREATE_MAIL_FOLDER: { return_existing_if_exists: 'boolean' },
  // Who is told about a calendar write is a word, and the guest lists are lists; Outlook's event body is text on
  // create and an object (a kind and the content) on update.
  GOOGLECALENDAR_PATCH_EVENT: { send_updates: 'string', attendees: 'array', start_time: 'string', end_time: 'string' },
  GOOGLECALENDAR_DELETE_EVENT: { send_updates: 'string' },
  OUTLOOK_GET_CALENDAR_VIEW: { select: 'array', top: 'integer', orderby: 'string' },
  OUTLOOK_CALENDAR_CREATE_EVENT: { attendees_info: 'array', body: 'string', is_html: 'boolean' },
  OUTLOOK_UPDATE_CALENDAR_EVENT: { attendees: 'array', body: 'object' },
  // OneDrive's list of changes takes its link back as text and the fields as one comma-separated text; the download names its file.
  ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: { top: 'integer', select: 'string', token: 'string' },
  ONE_DRIVE_LIST_DRIVES: { select: 'string' },
  ONE_DRIVE_DOWNLOAD_FILE: { item_id: 'string', file_name: 'string', drive_id: 'string' },
  GOOGLEDRIVE_GET_FILE_METADATA: { fileId: 'string', fields: 'string' },
  // The edited file goes as one file reference, not a list.
  GOOGLEDRIVE_UPLOAD_UPDATE_FILE: { fileId: 'string', file_to_upload: 'object', uploadType: 'string' },
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
