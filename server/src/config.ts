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
    } as Record<string, string>,
    /**
     * The permissions asked for at sign-in, per toolkit, when they should be fewer than Composio's managed app asks
     * for by default. Outlook's default set includes calendars, contacts, Teams chat and mailbox settings; Timmy
     * reads and sends mail, so it asks for mail and the profile only. A toolkit not listed here (or set to an empty
     * value) uses Composio's defaults. Google is left at the defaults: Google only lets an app ask for permissions it
     * has been approved for, and which narrower ones Composio's Google app holds is not published.
     */
    scopes: {
      outlook: (env.COMPOSIO_SCOPES_OUTLOOK ?? 'Mail.Read,Mail.ReadWrite,Mail.Send,offline_access,User.Read').split(',').map((x) => x.trim()).filter(Boolean),
      gmail: (env.COMPOSIO_SCOPES_GMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      googlecalendar: (env.COMPOSIO_SCOPES_GOOGLECALENDAR ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      googledrive: (env.COMPOSIO_SCOPES_GOOGLEDRIVE ?? '').split(',').map((x) => x.trim()).filter(Boolean),
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
      ...(JSON.parse(env.COMPOSIO_TOOLKIT_VERSIONS || '{}') as Record<string, string>),
    } as Record<string, string>,
  },

  /** How far back the first pass over a newly connected Drive goes, by when a file last changed. */
  driveBackfillDays: Number(env.TIMMY_DRIVE_BACKFILL_DAYS ?? 90),

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
  /** The most calendar events one command may create in the connected calendar, for the same reason. */
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
   * How long a page stays in the trash before it is deleted for good. The trash dialog tells people this number.
   * Never less than a day, so a mistyped setting can't empty everyone's trash at once.
   */
  trashRetentionDays: Math.max(1, Number(env.TIMMY_TRASH_RETENTION_DAYS ?? 30)),
  /** Version history of pages: ordinary editing keeps at most one earlier copy of a page in this many minutes. */
  pageVersionMinutes: Number(env.TIMMY_PAGE_VERSION_MINUTES ?? 5),
  /** Version history of pages: how many copies of one page are kept, and for how many days. */
  pageVersionsKept: Number(env.TIMMY_PAGE_VERSIONS_KEPT ?? 100),
  pageVersionDays: Number(env.TIMMY_PAGE_VERSION_DAYS ?? 90),
};

export const isProd = () => config.stage === 'production';
export const isLocal = () => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.publicUrl);

/** Refuses to start in a state that would be unsafe on a real deployment. Called at boot. */
export function assertSafeConfig() {
  if (isProd() && (config.fakeProviders || flag('TIMMY_TEST_HOOKS'))) throw new Error('Fake providers and test hooks cannot be switched on in production.');
  if (config.testHooks && !isLocal() && config.testToken.length < 24) throw new Error('Test hooks on a deployed server need TIMMY_TEST_TOKEN (24 characters or more).');
  if (isProd() && !new URL(config.databaseUrl).password) throw new Error('The production database URL must carry a password.');
}

/** The model a workspace runs on: its own choice if that is still on the list, else the default. */
export function modelFor(workspaceModel: string | null | undefined): string {
  if (workspaceModel && MODEL_ALLOWLIST.some((m) => m.id === workspaceModel)) return workspaceModel;
  return config.openrouter.defaultModel;
}
