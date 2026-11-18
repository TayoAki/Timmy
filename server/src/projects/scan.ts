/**
 * Starting and running a project scan, and reading its result. A scan runs as a job, because reading a workspace and
 * naming what it found takes a while; the screen asks for its state until it is ready.
 */
import { withWorkspace } from '../db/pool';
import { enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';
import { newId } from '../lib/ids';
import { detectProjects, type Looked, type Proposal } from './detect';

export interface Scan {
  id: string;
  status: 'running' | 'ready' | 'failed' | 'applied';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  proposals: Proposal[];
  looked: Partial<Looked>;
}

/** A scan that started this long ago and never finished is taken to have failed, and another can start. */
const STALE_MS = 15 * 60_000;

export async function startScan(workspaceId: string, userId: string): Promise<Scan> {
  const scan = await withWorkspace({ workspaceId, userId }, async (tx) => {
    // One scan at a time per workspace.
    const running = (await tx.query(`select id from project_scan where workspace_id = $1 and status = 'running' and started_at > now() - $2::interval`, [workspaceId, `${STALE_MS / 1000} seconds`])).rows[0];
    if (running) return null;
    const id = newId('scan');
    await tx.query(`insert into project_scan (id, workspace_id, status, started_by) values ($1, $2, 'running', $3)`, [id, workspaceId, userId]);
    return id;
  });
  if (scan) enqueueSoon('projects.detect', { workspaceId, scanId: scan }, { singletonKey: `scan:${scan}` });
  return (await latestScan(workspaceId))!;
}

export async function runScan(workspaceId: string, scanId: string): Promise<void> {
  try {
    const { proposals, looked } = await detectProjects(workspaceId);
    await withWorkspace({ workspaceId }, (tx) => tx.query(`update project_scan set status = 'ready', finished_at = now(), proposals = $2::jsonb, looked = $3::jsonb where id = $1 and status = 'running'`, [scanId, JSON.stringify(proposals), JSON.stringify(looked)]));
    log.info('project scan', { workspaceId, proposals: proposals.length, ...looked });
  } catch (e) {
    log.warn('project scan failed', { workspaceId, error: (e as Error).message });
    await withWorkspace({ workspaceId }, (tx) => tx.query(`update project_scan set status = 'failed', finished_at = now(), error = $2 where id = $1`, [scanId, 'The scan stopped before it finished. Try again.']));
  }
}

export async function latestScan(workspaceId: string): Promise<Scan | null> {
  const r = await withWorkspace({ workspaceId }, async (tx) => (await tx.query(`select * from project_scan where workspace_id = $1 order by started_at desc limit 1`, [workspaceId])).rows[0]);
  if (!r) return null;
  const stale = r.status === 'running' && Date.now() - new Date(r.started_at).getTime() > STALE_MS;
  return {
    id: r.id,
    status: stale ? 'failed' : r.status,
    startedAt: new Date(r.started_at).toISOString(),
    ...(r.finished_at ? { finishedAt: new Date(r.finished_at).toISOString() } : {}),
    ...(stale ? { error: 'The scan stopped before it finished. Try again.' } : r.error ? { error: r.error } : {}),
    proposals: r.proposals ?? [],
    looked: r.looked ?? {},
  };
}
