import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { magicLink, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { config } from '../config';
import { authPool, sysPool } from '../db/pool';
import { addSecret, log } from '../lib/log';
import { sendMail } from '../providers/email';
import { closeConnections } from '../sync/connect';

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

const SIGNUP_CLOSED = 'Timmy is invite-only for now. Ask the person who runs your workspace to invite this address.';

/**
 * Whether a new account may be created for this address. When sign-up is
 * invite-only, the address has to be on the operator's list or hold a pending
 * invitation to a workspace.
 */
export async function maySignUp(email: string): Promise<boolean> {
  if (config.signup === 'open') return true;
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@'));
  if (config.signupAllow.includes(address) || config.signupAllow.includes(domain)) return true;
  const { rows } = await authPool.query(`select 1 from invitation where lower(email) = $1 and status = 'pending' and "expiresAt" > now() limit 1`, [address]);
  return rows.length > 0;
}

/** The signing secret comes from the environment, or is generated once and kept in the database. */
async function authSecret(): Promise<string> {
  if (config.authSecret) return config.authSecret;
  await sysPool.query('insert into app_secret (name, value) values ($1, $2) on conflict (name) do nothing', ['auth_secret', randomBytes(32).toString('hex')]);
  const { rows } = await sysPool.query('select value from app_secret where name = $1', ['auth_secret']);
  addSecret(rows[0].value as string);
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
      requireEmailVerification: config.requireEmailVerification,
      // Whoever held a session before the reset loses it, including someone who registered the address first.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        void sendMail({ to: user.email, kind: 'reset', subject: 'Reset your Timmy password', body: `Reset your password:\n${url}\n\nIf you didn't ask for this, ignore this email.` });
      },
    },
    // Proving an address is yours: a link is sent when the account is made, and opening it signs the person in.
    // When confirmation is required (see config), an account can't sign in until that link has been opened.
    emailVerification: {
      sendOnSignUp: config.requireEmailVerification,
      sendOnSignIn: config.requireEmailVerification,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        void sendMail({ to: user.email, kind: 'verify', subject: 'Confirm your email for Timmy', body: `Confirm this address to finish setting up Timmy:\n${url}\n\nThe link works for 24 hours. If you didn't create a Timmy account, ignore this email.` });
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    // Railway's edge sets X-Real-IP to the caller's address. X-Forwarded-For can be sent by anyone, so it is not used:
    // with it, one caller could dodge the sign-in limit, or everyone could share one counter and lock each other out.
    advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    databaseHooks: {
      user: {
        create: {
          // Every way an account comes to exist (password sign-up, a sign-in link for a new address) passes here.
          before: async (user) => {
            if (!(await maySignUp(user.email))) throw new APIError('FORBIDDEN', { message: SIGNUP_CLOSED });
          },
        },
      },
    },
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
        // Each workspace has its own spending limit, so the number one account can create is bounded.
        organizationLimit: config.workspacesPerAccount,
        // Once Timmy's own mail is delivered, an invitation can only be accepted by someone who proved the address.
        requireEmailVerificationOnInvitation: config.requireEmailVerification,
        schema: {
          organization: {
            additionalFields: {
              trade: { type: 'string', required: false, input: true },
              // Set by the server when client workspaces arrive; never taken from the caller.
              parentId: { type: 'string', required: false, input: false },
            },
          },
        },
        sendInvitationEmail: async ({ id, email, organization: org, inviter, role }) => {
          const url = `${config.publicUrl}/?invite=${id}`;
          void sendMail({ to: email, kind: 'invite', subject: `${inviter.user.name} invited you to ${org.name} on Timmy`, body: `${inviter.user.name} invited you to join ${org.name} as ${role}.\n\nAccept the invitation:\n${url}` });
        },
        organizationHooks: {
          // A person who leaves takes their connected accounts with them; a deleted workspace stops reading altogether.
          afterRemoveMember: async ({ member, organization: org }) => {
            await closeConnections(org.id, { userId: member.userId }, 'system').catch((e) => log.error('could not close a removed member’s connections', { error: (e as Error).message }));
          },
          beforeDeleteOrganization: async ({ organization: org }) => {
            await closeConnections(org.id, {}, 'system').catch((e) => log.error('could not close a deleted workspace’s connections', { error: (e as Error).message }));
            // Closed now; its data is removed by the purge job once the retention period has passed.
            await sysPool.query('update workspace set kill_switch = true, deleted_at = now() where id = $1', [org.id]);
          },
          // Each workspace gets a settings row; its starting state is seeded the first time it loads.
          afterCreateOrganization: async ({ organization: org, user }) => {
            const o = org as { id: string; name: string; trade?: string | null };
            await sysPool.query(
              `insert into workspace (id, name, trade, owner_name, owner_email)
               values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
              [o.id, o.name, o.trade || 'other', user.name, user.email],
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
