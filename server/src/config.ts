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
  stage: (env.TIMMY_ENV ?? (env.NODE_ENV === 'test' ? 'test' : 'development')) as Stage,
  port: Number(env.PORT ?? 8787),
  /** The origin people open in the browser. The API and the app share it, so sign-in cookies are first-party. */
  publicUrl: (env.PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT ?? 8787}`)).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://timmy_owner:timmy@localhost:5432/timmy_dev',
  /** Where the built frontend lives; the API serves it. */
  webDist: env.WEB_DIST ?? '',

  /** Deterministic stand-ins for Composio, OpenRouter and mail delivery. Tests and CI run on these. */
  fakeProviders: flag('TIMMY_FAKE_PROVIDERS'),
  /** Lets tests read the mail outbox and drive the fake providers. Never on in production. */
  testHooks: flag('TIMMY_TEST_HOOKS') && env.TIMMY_ENV !== 'production',

  authSecret: env.BETTER_AUTH_SECRET ?? '',

  openrouter: {
    apiKey: env.OPENROUTER_API_KEY ?? '',
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    defaultModel: env.TIMMY_MODEL_DEFAULT ?? 'anthropic/claude-opus-5.5',
    /** Pinned: the model that decides Auto-mode approvals. Workspaces cannot change it. */
    judgeModel: env.TIMMY_MODEL_JUDGE ?? 'anthropic/claude-opus-5.5',
    /** Tried in order when the chosen model's providers are down. */
    fallbacks: (env.TIMMY_MODEL_FALLBACKS ?? 'anthropic/claude-opus-5').split(',').map((s) => s.trim()).filter(Boolean),
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

  /** How long a send waits before it leaves, so it can be undone. */
  sendHoldSeconds: Number(env.TIMMY_SEND_HOLD_SECONDS ?? 30),
  /** First pass of the backfill, done before the first brief. The rest follows in the background. */
  backfillFastDays: Number(env.TIMMY_BACKFILL_FAST_DAYS ?? 30),
  backfillFullDays: Number(env.TIMMY_BACKFILL_FULL_DAYS ?? 90),
};

export const isProd = () => config.stage === 'production';

/** The model a workspace runs on: its own choice if that is still on the list, else the default. */
export function modelFor(workspaceModel: string | null | undefined): string {
  if (workspaceModel && MODEL_ALLOWLIST.some((m) => m.id === workspaceModel)) return workspaceModel;
  return config.openrouter.defaultModel;
}
