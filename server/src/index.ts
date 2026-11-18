import './lib/no-telemetry';
import { serve } from '@hono/node-server';
import { initAuth } from './auth/auth';
import { assertSafeConfig, config } from './config';
import { migrate } from './db/migrate';
import { closePools, sysPool } from './db/pool';
import { buildApp } from './http/app';
import { registerJobs } from './jobs/handlers';
import { enqueueSoon, startBoss, type Jobs } from './jobs/jobs';
import { textPassesAtStart } from './sync/file-text';
import { SORTING_VERSION } from './sync/sorting';
import { addSecret, log } from './lib/log';
import { composio, composioReady } from './providers/composio';
import { startHub, stopHub } from './state/hub';

async function main() {
  assertSafeConfig();
  const applied = await migrate((line) => log.info(line));
  if (applied.length) log.info('migrations applied', { count: applied.length });
  await initAuth();
  registerJobs();
  let jobs: Jobs | null = null;
  if (config.stage !== 'test') jobs = await startBoss();
  await startHub();

  // Point Composio's event deliveries at this server. The signing secret it returns is kept server-side.
  if (composioReady() && !config.fakeProviders && config.publicUrl.startsWith('https://')) {
    try {
      const { secret } = await composio().ensureWebhook(`${config.publicUrl}/api/hooks/composio`);
      if (secret) addSecret(secret);
      if (secret && !config.composio.webhookSecret) await sysPool.query('insert into app_secret (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value', ['composio_webhook_secret', secret]);
    } catch (e) {
      log.warn('could not register the Composio webhook', { error: (e as Error).message });
    }
  }

  // Files whose words weren't read (a new reader, a pass cut short by a restart) are read now, not tonight.
  // Mail sorted by older plain-code rules is sorted again, once per workspace (sync/sorting.ts, SORTING_VERSION).
  if (jobs)
    await sysPool
      .query(`select distinct c.workspace_id from connection c where c.status = 'active' and c.toolkit in ('gmail', 'outlook') and not exists (select 1 from audit_log a where a.workspace_id = c.workspace_id and a.action = 'sorting.resorted' and (a.detail->>'version')::int >= $1)`, [SORTING_VERSION])
      .then(({ rows }) => rows.forEach((r) => enqueueSoon('mail.resort', { workspaceId: r.workspace_id as string }, { singletonKey: `resort:${r.workspace_id as string}` })))
      .catch((e) => log.warn('could not queue sorting again', { error: (e as Error).message }));
  if (jobs) await textPassesAtStart((c) => enqueueSoon('files.text', { workspaceId: c.workspace_id, connectionId: c.id }, { singletonKey: `ftext:${c.id}` })).catch((e) => log.warn('could not queue the file text passes', { error: (e as Error).message }));

  const app = buildApp();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' });
  log.info('Timmy API listening', { port: config.port, stage: config.stage, publicUrl: config.publicUrl, fake: config.fakeProviders });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await stopHub();
    await jobs?.stop().catch(() => {});
    await closePools();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  log.error('boot failed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
