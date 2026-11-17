/**
 * Everything the server reads from its environment, in one place.
 * Real keys are read here and handed only to the provider clients; nothing else imports them.
 */
const env = process.env;

const flag = (name: string) => env[name] === '1' || env[name] === 'true';

export type Stage = 'development' | 'test' | 'staging' | 'production';

export interface ModelOption {
  /** The OpenRouter model id, as the models API lists it. */
  id: string;
  label: string;
  note: string;
}

/**
 * Models a workspace may choose in Settings. A model joins this list only after
 * it passes the eval (tool calling, drafting, refusals) and the owner says yes.
 */
export const MODEL_ALLOWLIST: ModelOption[] = [
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', note: 'The default. Strongest at drafting and tool use.' },
];

export const config = {
  // With no TIMMY_ENV, a production build is production: the safe reading.
  stage: (env.TIMMY_ENV ?? (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development')) as Stage,
  port: Number(env.PORT ?? 8787),
  /** The origin people open in the browser. The API and the app share it, so sign-in cookies are first-party. */
  publicUrl: (env.PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT ?? 8787}`)).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://timmy_owner:timmy@localhost:5432/timmy_dev',
  /** Where the built frontend lives; the API serves it. */
  webDist: env.WEB_DIST ?? '',

  /** Deterministic stand-ins for Composio, OpenRouter and mail delivery. Tests and CI run on these. */
  fakeProviders: flag('TIMMY_FAKE_PROVIDERS'),
  /** Lets tests read the mail outbox and drive the fake providers. Never on in production. */
  testHooks: flag('TIMMY_TEST_HOOKS') && env.TIMMY_ENV !== 'production' && !(env.TIMMY_ENV === undefined && env.NODE_ENV === 'production'),
  /** On any deployed server the test hooks also need this token in the `x-test-token` header. */
  testToken: env.TIMMY_TEST_TOKEN ?? '',
  /**
   * Timmy's own account mail (sign-in links, confirmations, invitations, resets), delivered by Resend.
   * `from` must be an address on a domain verified in Resend, e.g. "Timmy <timmy@mail.example.com>".
   * With the stand-in providers on, nothing is delivered: messages stay in the outbox table, where tests read them.
   */
  mail: {
    resendApiKey: env.RESEND_API_KEY ?? '',
    from: env.TIMMY_MAIL_FROM ?? '',
    resendBaseUrl: (env.RESEND_BASE_URL ?? 'https://api.resend.com').replace(/\/$/, ''),
    deliver: env.TIMMY_MAIL_DELIVER !== undefined ? flag('TIMMY_MAIL_DELIVER') : !flag('TIMMY_FAKE_PROVIDERS'),
  },
  /**
   * Whether a new account must confirm its address (by opening a link sent to it) before it can sign in.
   * On by default as soon as Timmy can deliver mail, because until then nobody can prove an address is theirs.
   */
  requireEmailVerification: env.TIMMY_REQUIRE_EMAIL_VERIFICATION !== undefined ? flag('TIMMY_REQUIRE_EMAIL_VERIFICATION') : !flag('TIMMY_FAKE_PROVIDERS') && !!env.RESEND_API_KEY && !!env.TIMMY_MAIL_FROM,

  authSecret: env.BETTER_AUTH_SECRET ?? '',

  /**
   * Who may create an account. "invite": only addresses on the list below, or with a pending invitation to a
   * workspace. "open": anyone. Production is invite-only unless told otherwise, because every account can spend
   * on the model key and, until a mail provider exists, nobody can prove they own the address they register.
   */
  signup: (env.TIMMY_SIGNUP ?? ((env.TIMMY_ENV ?? (env.NODE_ENV === 'production' ? 'production' : '')) === 'production' ? 'invite' : 'open')) as 'open' | 'invite',
  /** Addresses (ada@example.com) and whole domains (@example.com) that may sign up when sign-up is invite-only. */
  signupAllow: (env.TIMMY_SIGNUP_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** How many workspaces one account may create. */
  workspacesPerAccount: Number(env.TIMMY_WORKSPACES_PER_ACCOUNT ?? 3),

  openrouter: {
    apiKey: env.OPENROUTER_API_KEY ?? '',
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    defaultModel: env.TIMMY_MODEL_DEFAULT ?? 'anthropic/claude-opus-5.5',
    /** Pinned: the model that decides Auto-mode approvals. Workspaces cannot change it. */
    judgeModel: env.TIMMY_MODEL_JUDGE ?? 'anthropic/claude-opus-5.5',
    /**
     * Tried in order when the chosen model's providers are down. Empty until the owner picks one:
     * a fallback reads the same mail as the default, so it needs the same eval and the same OK.
     */
    fallbacks: (env.TIMMY_MODEL_FALLBACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  composio: {
    apiKey: env.COMPOSIO_API_KEY ?? '',
    webhookSecret: env.COMPOSIO_WEBHOOK_SECRET ?? '',
    /**
     * Auth config ids per app. Empty means "use Composio's managed OAuth app" (one is
     * created on first use). Set an id here to move an app to our own OAuth app with no code change.
     */
    authConfigs: {
      gmail: env.COMPOSIO_AUTH_CONFIG_GMAIL ?? '',
      googlecalendar: env.COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR ?? '',
      googledrive: env.COMPOSIO_AUTH_CONFIG_GOOGLEDRIVE ?? '',
      outlook: env.COMPOSIO_AUTH_CONFIG_OUTLOOK ?? '',
      one_drive: env.COMPOSIO_AUTH_CONFIG_ONE_DRIVE ?? '',
    } as Record<string, string>,
    /**
     * The permissions asked for at sign-in, per toolkit, when they should be fewer than Composio's managed app asks
     * for by default. Outlook's default set includes contacts, Teams chat and mailbox settings; Timmy reads and sends
     * mail and reads and writes the calendar, so it asks for mail, the calendar and the profile only. A toolkit not
     * listed here (or set to an empty value) uses Composio's defaults. Google is left at the defaults: Google only
     * lets an app ask for permissions it has been approved for, and which narrower ones Composio's Google app holds
     * is not published.
     */
    scopes: {
      outlook: (env.COMPOSIO_SCOPES_OUTLOOK ?? 'Mail.Read,Mail.ReadWrite,Mail.Send,Calendars.ReadWrite,offline_access,User.Read').split(',').map((x) => x.trim()).filter(Boolean),
      gmail: (env.COMPOSIO_SCOPES_GMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      googlecalendar: (env.COMPOSIO_SCOPES_GOOGLECALENDAR ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      googledrive: (env.COMPOSIO_SCOPES_GOOGLEDRIVE ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      // OneDrive is only read: the person's own files (Files.Read, not .All or ReadWrite), the profile to show whose
      // drive it is, and offline access so the connection lasts. The workbook tools would need write permission, so
      // spreadsheets are downloaded and read here instead (src/sync/office-text.ts).
      one_drive: (env.COMPOSIO_SCOPES_ONE_DRIVE ?? 'Files.Read,offline_access,User.Read').split(',').map((x) => x.trim()).filter(Boolean),
    } as Record<string, string[]>,
    /**
     * The version of each Composio toolkit this code was written against. Composio changes tool names and
     * arguments between versions (Outlook's send tool took `to_email`, then `to`), so the server never runs
     * "whatever is newest": a version moves forward here, after its tools have been checked. COMPOSIO_TOOLKIT_VERSIONS
     * (a JSON object) overrides single entries without a deploy.
     */
    toolkitVersions: {
      gmail: '20261105_00',
      googlecalendar: '20261111_00',
      outlook: '20261116_00',
      googledrive: '20261104_00',
      one_drive: '20261116_00',
      ...(JSON.parse(env.COMPOSIO_TOOLKIT_VERSIONS || '{}') as Record<string, string>),
    } as Record<string, string>,
    /**
     * Where a file a tool hands back (OneDrive's download) may be fetched from: Composio's own store and the cloud
     * stores behind it. Anything else is refused before a request is made, and so is a host whose address is a
     * private one. Comma-separated host names; a leading dot means "any host ending in this".
     */
    fileHosts: (env.COMPOSIO_FILE_HOSTS ?? 'storage.composio.dev,.amazonaws.com,.blob.core.windows.net').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  },

  /**
   * The bucket uploaded files are kept in: S3-compatible (Railway Buckets). The secret key is handed only to the
   * code that signs requests to the bucket; the browser never gets it, and uploads go through this server.
   */
  bucket: {
    // An address given without "https://" is read as https.
    endpoint: (env.BUCKET_ENDPOINT ?? '').trim().replace(/\/$/, '').replace(/^(?!https?:\/\/)(?=.)/, 'https://'),
    name: env.BUCKET_NAME ?? '',
    region: env.BUCKET_REGION || 'auto',
    accessKeyId: env.BUCKET_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.BUCKET_SECRET_ACCESS_KEY ?? '',
    /** Railway's buckets put the bucket's name in the host name. BUCKET_URL_STYLE=path is for stores that want it in the path. */
    urlStyle: (env.BUCKET_URL_STYLE === 'path' ? 'path' : 'virtual') as 'virtual' | 'path',
  },
  files: {
    /**
     * Left unset, a server that has the bucket's variables uses the bucket, and one without them uses the
     * stand-in if it runs the stand-in providers or is a developer's machine. Set to "standin" to keep a server
     * that has a bucket off it (files then live in this process and are lost when it stops), or to "bucket" to
     * refuse to run uploads on anything else.
     */
    store: (env.TIMMY_FILE_STORE === 'bucket' || env.TIMMY_FILE_STORE === 'standin' ? env.TIMMY_FILE_STORE : undefined) as 'bucket' | 'standin' | undefined,
    /** A folder for the stand-in to keep files in, so they survive a restart on a developer's machine. Memory when empty. */
    dir: env.TIMMY_FILES_DIR ?? '',
    /** The most one workspace may keep in uploaded files, so one account can't fill the bucket. */
    quotaBytes: Number(env.TIMMY_FILES_QUOTA_MB ?? 2048) * 1024 * 1024,
    /** How many uploads one workspace may have announced and not yet sent. */
    maxPendingUploads: Number(env.TIMMY_MAX_PENDING_UPLOADS ?? 100),
    /**
     * The largest file an email from Outlook may carry. Outlook's tool for adding a file to a draft takes
     * "small" files, which for Microsoft means under 3 MB; larger ones need a different upload that isn't built.
     * Refused when the email is prepared, so the person hears it at once and not after the undo window.
     */
    outlookMaxFileBytes: Number(env.TIMMY_OUTLOOK_MAX_FILE_MB ?? 3) * 1024 * 1024,
  },

  /** How far back the first pass over a newly connected Drive goes, by when a file last changed. */
  driveBackfillDays: Number(env.TIMMY_DRIVE_BACKFILL_DAYS ?? 90),
  /**
   * Files shared with the person, listed when a Drive is first read even if nobody has changed them for longer
   * than the window above: the most recently shared, up to this many.
   */
  driveSharedMax: Number(env.TIMMY_DRIVE_SHARED_MAX ?? 200),
  /**
   * The first read of a OneDrive walks the whole drive (Microsoft lists it in no useful order) and keeps what changed
   * inside the window. It stops after this many pages of 200 and from then on follows changes only.
   */
  oneDriveFirstPages: Number(env.TIMMY_ONEDRIVE_FIRST_PAGES ?? 50),
  /**
   * What synced files say is read and kept so Ask can search it: only files changed inside the window above, at most
   * `perPass` files each pass, and none larger than `maxBytes` (a larger one is listed by name only).
   */
  fileText: {
    perPass: Number(env.TIMMY_FILE_TEXT_PER_PASS ?? 40),
    maxBytes: Number(env.TIMMY_FILE_TEXT_MAX_MB ?? 10) * 1024 * 1024,
  },
  /** Each night, this many stored Drive files are asked about one by one, so one deleted for good or unshared drops off. */
  filesCheckBatch: Number(env.TIMMY_FILES_CHECK_BATCH ?? 25),

  /**
   * The most a workspace may set its own limits to. The limits guard the workspace against a runaway month;
   * these ceilings guard whoever pays the model bill until billing exists.
   */
  spendCapCeilingUsd: Number(env.TIMMY_SPEND_CAP_CEILING_USD ?? 200),
  /** The most the whole service may spend on the model in a month, across every workspace. Past it, every model call is refused. */
  serviceSpendCeilingUsd: Number(env.TIMMY_SERVICE_SPEND_CEILING_USD ?? 500),
  /** The share of a workspace's monthly limit that work nobody asked for (reading incoming mail) may use, so a flood of mail can't silence Ask. */
  unattendedShare: Number(env.TIMMY_UNATTENDED_SHARE ?? 0.5),
  /** The most threads one command may file. Each is a write to the mailbox, so one command can't ask for an unbounded number. */
  maxFilingsPerCommand: Number(env.TIMMY_MAX_FILINGS_PER_COMMAND ?? 100),
  /** The most calendar events one command may create in the connected calendar, or change or delete there, for the same reason. */
  maxEventsPerCommand: Number(env.TIMMY_MAX_EVENTS_PER_COMMAND ?? 20),
  /** How long synced mail is kept after its mailbox is disconnected or its workspace deleted. */
  mailRetentionDays: Number(env.TIMMY_MAIL_RETENTION_DAYS ?? 30),
  concurrentRunsCeiling: Number(env.TIMMY_CONCURRENT_RUNS_CEILING ?? 4),

  /** How long the connect callback waits for the provider to report a new account as active. */
  connectWaitMs: Number(env.TIMMY_CONNECT_WAIT_MS ?? (env.TIMMY_ENV === 'test' || env.NODE_ENV === 'test' ? 0 : 10_000)),
  /** How long a send waits before it leaves, so it can be undone. */
  sendHoldSeconds: Number(env.TIMMY_SEND_HOLD_SECONDS ?? 30),
  /** First pass of the backfill, done before the first brief. The rest follows in the background. */
  backfillFastDays: Number(env.TIMMY_BACKFILL_FAST_DAYS ?? 30),
  backfillFullDays: Number(env.TIMMY_BACKFILL_FULL_DAYS ?? 90),
  /** After the first backfill pass, the model reads the newest threads people wrote: this many at most, this far back. */
  firstReadThreads: Number(env.TIMMY_FIRST_READ_THREADS ?? 40),
  firstReadDays: Number(env.TIMMY_FIRST_READ_DAYS ?? 7),
  /** The morning run: how many threads it reads and how many replies it drafts at most, and how old a thread may be to get a draft. */
  morningReadLimit: Number(env.TIMMY_MORNING_READ_LIMIT ?? 30),
  morningDraftLimit: Number(env.TIMMY_MORNING_DRAFT_LIMIT ?? 10),
  morningDraftDays: Number(env.TIMMY_MORNING_DRAFT_DAYS ?? 14),
  morningNudgeLimit: Number(env.TIMMY_MORNING_NUDGE_LIMIT ?? 5),
  /** Working days someone has to deliver what they were asked for, when the email named no date. */
  waitingDefaultDays: Number(env.TIMMY_WAITING_DEFAULT_DAYS ?? 3),

  /**
   * The website chat. Strangers type into it, so every number here is a ceiling on what one visitor, one
   * address or one widget can make the server do or store.
   */
  chat: {
    /** Signs conversation tokens. When empty, one is generated once and kept in the database. */
    secret: env.TIMMY_CHAT_SECRET ?? '',
    /** The longest message a visitor or a teammate can send, in characters. */
    maxMessageChars: 2000,
    /** The largest request body the public chat routes read, in bytes. */
    maxBodyBytes: Number(env.TIMMY_CHAT_MAX_BODY_BYTES ?? 12 * 1024),
    /** How many messages one visitor can send in one conversation. */
    messagesPerConversation: Number(env.TIMMY_CHAT_MESSAGES_PER_CONVERSATION ?? 100),
    /** New conversations a widget accepts in a day, and messages it accepts in a day. */
    conversationsPerDay: Number(env.TIMMY_CHAT_CONVERSATIONS_PER_DAY ?? 300),
    messagesPerDay: Number(env.TIMMY_CHAT_MESSAGES_PER_DAY ?? 5000),
    /** Messages a minute from one visitor and from one address; new conversations an hour from one address. */
    visitorMessagesPerMinute: Number(env.TIMMY_CHAT_VISITOR_PER_MINUTE ?? 12),
    addressMessagesPerMinute: Number(env.TIMMY_CHAT_ADDRESS_PER_MINUTE ?? 60),
    /** Messages one address may send to one business's chat in a day: one address alone can't use up the day's allowance. */
    addressMessagesPerDay: Number(env.TIMMY_CHAT_ADDRESS_PER_DAY ?? 300),
    addressConversationsPerHour: Number(env.TIMMY_CHAT_ADDRESS_CONVERSATIONS_PER_HOUR ?? 30),
    /** Reads of the public settings and stream connects a minute from one address. */
    addressReadsPerMinute: Number(env.TIMMY_CHAT_ADDRESS_READS_PER_MINUTE ?? 120),
    /** Streams open at once on one server, from one address, and for one conversation. */
    streamsOpen: Number(env.TIMMY_CHAT_STREAMS_OPEN ?? 2000),
    streamsPerAddress: Number(env.TIMMY_CHAT_STREAMS_PER_ADDRESS ?? 20),
    streamsPerConversation: 3,
    /** Streams one business's visitors may hold open at once on one server, so one customer can't take the whole pool. */
    streamsPerWorkspace: Number(env.TIMMY_CHAT_STREAMS_PER_WORKSPACE ?? 200),
    /**
     * The chat's own address, such as https://chat.example.com: a second domain on this same service. When set,
     * the loader, the frame and the public chat routes answer only there, and that address answers nothing else.
     * When empty, they are served from the app's own address.
     */
    publicUrl: (env.CHAT_PUBLIC_URL ?? '').trim().replace(/\/$/, ''),
    /**
     * The bot check: how hard the small piece of work is that a visitor's browser does before its first message
     * starts a conversation, in bits (each one more doubles it; 18 is about a quarter of a million tries).
     */
    challengeBits: Number(env.TIMMY_CHAT_CHALLENGE_BITS ?? 18),
    /** How long a challenge handed to a chat window can be used, in minutes. */
    challengeMinutes: 60,
    /** A visitor's stream is closed after this long; the chat window opens a new one. */
    streamSeconds: Number(env.TIMMY_CHAT_STREAM_SECONDS ?? 600),
    /** How long a conversation's token works after the visitor's last message, in days. */
    tokenDays: 30,
    /** What the Chats screen holds: this many conversations, and for each the newest messages up to these limits. */
    shownConversations: Number(env.TIMMY_CHAT_SHOWN_CONVERSATIONS ?? 100),
    shownMessages: 30,
    shownChars: 8000,
    /** A reply that could not be shown to the visitor within this many seconds is not shown late. */
    replyFreshSeconds: 600,
  },
  /** The limits that keep an automation from running away. */
  automations: {
    /** The most runs one automation may start in an hour. Past it, the automation is switched off and says why. */
    runsPerHour: Number(env.TIMMY_AUTOMATION_RUNS_PER_HOUR ?? 100),
    /** How long a failed step waits before each new try, in seconds. One entry per retry: three retries, then the run fails. */
    retrySeconds: (env.TIMMY_AUTOMATION_RETRY_SECONDS ?? '30,120,600').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0),
    /** This many failed runs in a row switch the automation off, with a note saying why. */
    failuresToSwitchOff: Number(env.TIMMY_AUTOMATION_FAILURES_TO_SWITCH_OFF ?? 5),
    /** A scheduled run that could not start on time (the server was down) still happens if it is no later than this. */
    lateMinutes: Number(env.TIMMY_AUTOMATION_LATE_MINUTES ?? 6 * 60),
    /** How long a worker may hold a run before another may take it over, in seconds. A step never takes this long unless its worker died. */
    leaseSeconds: Number(env.TIMMY_AUTOMATION_LEASE_SECONDS ?? 600),
  },
  /**
   * How long a page stays in the trash before it is deleted for good. The trash dialog tells people this number.
   * Never less than a day, so a mistyped setting can't empty everyone's trash at once.
   */
  trashRetentionDays: Math.max(1, Number(env.TIMMY_TRASH_RETENTION_DAYS ?? 30)),
  /** Version history of pages: ordinary editing keeps at most one earlier copy of a page in this many minutes. */
  pageVersionMinutes: Number(env.TIMMY_PAGE_VERSION_MINUTES ?? 5),
  /** Version history of pages: how many copies of one page are kept, and for how many days. */
  pageVersionsKept: Number(env.TIMMY_PAGE_VERSIONS_KEPT ?? 100),
  pageVersionDays: Number(env.TIMMY_PAGE_VERSION_DAYS ?? 90),
  /**
   * Picking up what the person changed in the mailbox itself (sync/mailbox-check.ts). One look lists the messages
   * received in the last `days`, with their labels and no bodies, in at most `maxPages` provider calls; mail older
   * than that is left as it is. Opening the app gets a look; after that one is made every `everySeconds` while a tab
   * stays open and someone did something in Timmy within `idleSeconds`. A thread Timmy itself filed is left alone
   * until `settleSeconds` after the filing completed, so the mailbox has time to show it.
   */
  mailboxCheck: {
    days: Number(env.TIMMY_MAILBOX_CHECK_DAYS ?? 3),
    maxPages: Number(env.TIMMY_MAILBOX_CHECK_PAGES ?? 2),
    /**
     * Messages per call. Gmail's tool takes up to 500 and Outlook's up to 1,000. The Gmail tool fetches each
     * message's labels one by one behind the call and leaves out any it could not get, so its page starts at 250
     * until a real mailbox shows a full page holds. A mailbox with more mail in `days` than one page costs two
     * calls a look.
     */
    pageSize: { gmail: Number(env.TIMMY_MAILBOX_CHECK_PAGE_GMAIL ?? 250), outlook: Number(env.TIMMY_MAILBOX_CHECK_PAGE_OUTLOOK ?? 500) } as Record<string, number>,
    everySeconds: Number(env.TIMMY_MAILBOX_CHECK_EVERY_SECONDS ?? 600),
    idleSeconds: Number(env.TIMMY_MAILBOX_CHECK_IDLE_SECONDS ?? 1800),
    settleSeconds: Number(env.TIMMY_MAILBOX_SETTLE_SECONDS ?? 300),
  },
};

export const isProd = () => config.stage === 'production';
export const isLocal = () => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.publicUrl);

/** Refuses to start in a state that would be unsafe on a real deployment. Called at boot. */
export function assertSafeConfig() {
  if (isProd() && (config.fakeProviders || flag('TIMMY_TEST_HOOKS'))) throw new Error('Fake providers and test hooks cannot be switched on in production.');
  if (config.testHooks && !isLocal() && config.testToken.length < 24) throw new Error('Test hooks on a deployed server need TIMMY_TEST_TOKEN (24 characters or more).');
  if (isProd() && !new URL(config.databaseUrl).password) throw new Error('The production database URL must carry a password.');
  if (isProd() && config.files.store === 'standin') throw new Error('The stand-in file store cannot be used in production: files would be lost at the next restart.');
  // The chat's own address is a whole origin on another host than the app's, and on https wherever it is public.
  const chat = config.chat.publicUrl;
  if (chat && (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(chat) || new URL(chat).host === new URL(config.publicUrl).host)) throw new Error('CHAT_PUBLIC_URL must be an address such as https://chat.example.com, on another host than the app.');
  if (chat && isProd() && !chat.startsWith('https://')) throw new Error('CHAT_PUBLIC_URL must start with https:// in production.');
}

/** The model a workspace runs on: its own choice if that is still on the list, else the default. */
export function modelFor(workspaceModel: string | null | undefined): string {
  if (workspaceModel && MODEL_ALLOWLIST.some((m) => m.id === workspaceModel)) return workspaceModel;
  return config.openrouter.defaultModel;
}
