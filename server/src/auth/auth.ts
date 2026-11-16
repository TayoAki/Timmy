import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { magicLink, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { config } from '../config';
import { authPool, sysPool } from '../db/pool';
import { sendMail } from '../providers/email';

/**
 * What each role may do beyond Better Auth's own organization permissions.
 * The Action gateway and the command engine read `ROLE_RULES` in roles.ts;
 * these statements keep Better Auth's role list in step with it.
 */
const statement = {
  ...defaultStatements,
  inbox: ['read', 'work'],
  send: ['approve'],
  crm: ['approve'],
  policy: ['update'],
  reports: ['read'],
} as const;

const ac = createAccessControl(statement);
const roles = {
  owner: ac.newRole({ ...ownerAc.statements, inbox: ['read', 'work'], send: ['approve'], crm: ['approve'], policy: ['update'], reports: ['read'] }),
  admin: ac.newRole({ ...adminAc.statements, inbox: ['read', 'work'], send: ['approve'], crm: ['approve'], policy: ['update'], reports: ['read'] }),
  member: ac.newRole({ ...memberAc.statements, inbox: ['read', 'work'], send: ['approve'], reports: ['read'] }),
  /** A delegate (an EA): works the exec's inbox; what they may send alone is the exec's policy. */
  assistant: ac.newRole({ inbox: ['read', 'work'], reports: ['read'] }),
  revops: ac.newRole({ inbox: ['read'], crm: ['approve'], reports: ['read'] }),
  /** An agency's client: reports only. */
  client: ac.newRole({ reports: ['read'] }),
};

/** The signing secret comes from the environment, or is generated once and kept in the database. */
async function authSecret(): Promise<string> {
  if (config.authSecret) return config.authSecret;
  await sysPool.query('insert into app_secret (name, value) values ($1, $2) on conflict (name) do nothing', ['auth_secret', randomBytes(32).toString('hex')]);
  const { rows } = await sysPool.query('select value from app_secret where name = $1', ['auth_secret']);
  return rows[0].value as string;
}

function build(secret: string) {
  return betterAuth({
    appName: 'Timmy',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret,
    database: authPool,
    trustedOrigins: [config.publicUrl],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
      sendResetPassword: async ({ user, url }) => {
        void sendMail({ to: user.email, kind: 'reset', subject: 'Reset your Timmy password', body: `Reset your password:\n${url}\n\nIf you didn't ask for this, ignore this email.` });
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    plugins: [
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }) => {
          void sendMail({ to: email, kind: 'magic-link', subject: 'Your Timmy sign-in link', body: `Sign in to Timmy:\n${url}\n\nThe link works once and expires in 10 minutes.` });
        },
      }),
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: true,
        schema: {
          organization: {
            additionalFields: {
              trade: { type: 'string', required: false, input: true },
              parentId: { type: 'string', required: false, input: true },
            },
          },
        },
        sendInvitationEmail: async ({ id, email, organization: org, inviter, role }) => {
          const url = `${config.publicUrl}/?invite=${id}`;
          void sendMail({ to: email, kind: 'invite', subject: `${inviter.user.name} invited you to ${org.name} on Timmy`, body: `${inviter.user.name} invited you to join ${org.name} as ${role}.\n\nAccept the invitation:\n${url}` });
        },
        organizationHooks: {
          // Each workspace gets a settings row; its starting state is seeded the first time it loads.
          afterCreateOrganization: async ({ organization: org, user }) => {
            const o = org as { id: string; name: string; trade?: string | null; parentId?: string | null };
            await sysPool.query(
              `insert into workspace (id, name, trade, parent_id, owner_name, owner_email)
               values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
              [o.id, o.name, o.trade || 'other', o.parentId || null, user.name, user.email],
            );
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof build>;
let instance: Auth | null = null;

/** Builds the auth instance and brings its tables up to date. Call once at boot, after `migrate()`. */
export async function initAuth(): Promise<Auth> {
  if (instance) return instance;
  const built = build(await authSecret());
  const { runMigrations } = await getMigrations(built.options);
  await runMigrations();
  instance = built;
  return built;
}

export function auth(): Auth {
  if (!instance) throw new Error('auth is not ready: call initAuth() first');
  return instance;
}

export function resetAuthForTests() {
  instance = null;
}
