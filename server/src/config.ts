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
  /** Turn on once a mail provider delivers Timmy's own mail: sign-ups must then confirm their address before they can sign in. */
  requireEmailVerification: flag('TIMMY_REQUIRE_EMAIL_VERIFICATION'),

  authSecret: env.BETTER_AUTH_SECRET ?? '',

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
  },

  /**
   * The most a workspace may set its own limits to. The limits guard the workspace against a runaway month;
   * these ceilings guard whoever pays the model bill until billing exists.
   */
  spendCapCeilingUsd: Number(env.TIMMY_SPEND_CAP_CEILING_USD ?? 200),
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
