/**
 * Every background job by name, with what it is given. `defineJob`, `enqueueSoon` and the queue's `enqueue` are
 * checked against this list, so a misspelt name or field fails to compile instead of failing in the queue.
 *
 * A payload is stored by the queue as JSON, so it holds only plain values: no Dates, no class instances.
 * A job that runs on a schedule is given nothing.
 */

/** A job that only runs on its schedule (or when a test asks for it by name). */
type Scheduled = Record<string, never>;

export interface JobPayloads {
  // The Action gateway (jobs/handlers.ts).
  'effect.execute': { workspaceId: string; effectId: string };
  'effect.reconcile': { workspaceId: string; effectId: string };
  'effect.sweep': Scheduled;

  // Timmy's own account mail; `id` is the row in the outbox.
  'email.deliver': { id: number };

  // A connected mailbox. `days` is how far back a backfill pass reads; `seed` is the provider's event that announced the thread.
  'mail.backfill': { workspaceId: string; connectionId: string; days?: number };
  'mail.ingest': { workspaceId: string; connectionId: string; threadKey: string; seed?: Record<string, unknown> };
  'mail.reconcile': { workspaceId: string; connectionId: string };
  'mail.reconcile.all': Scheduled;
  // `gap` and `idle` are seconds (see sync/mailbox-check.ts).
  'mail.changes': { workspaceId: string; gap?: number; idle?: number };
  'mail.read': { workspaceId: string; threadId: string };
  // Sorting a workspace's mail again once the plain-code rules have changed (sync/sorting.ts, SORTING_VERSION).
  'mail.resort': { workspaceId: string };
  // `decided` is the answer a person picked on a decision card; `note` is what they asked for in their own words.
  'draft.make': { workspaceId: string; threadId: string; note?: string; userName?: string; decided?: { question: string; answer: string } };

  // Connections.
  'connection.revoke': { connectedAccountId: string | null; triggers?: string[] };
  'connection.purge': { workspaceId: string; connectionId: string };
  'connection.sweep': Scheduled;

  // The map of people, companies, meetings and files, and the kinds a workspace tracks.
  'ontology.note': { workspaceId: string };
  'ontology.sweep': Scheduled;
  'tracking.reread': { workspaceId: string; typeId: string };

  // Calendars. `nightly` marks the nightly re-read, which is counted apart.
  'calendar.sync': { workspaceId: string; connectionId: string; nightly?: boolean };
  'calendar.sync.all': Scheduled;

  // Drive and OneDrive.
  'files.sync': { workspaceId: string; connectionId: string };
  'files.text': { workspaceId: string; connectionId: string };
  'files.check': { workspaceId: string; connectionId: string };

  // Detecting projects (projects/detect.ts): one scan of a workspace, asked for by a person.
  'projects.detect': { workspaceId: string; scanId: string };
  'files.remove': { workspaceId: string; connectionId: string; fileId: string };
  'files.sync.all': Scheduled;

  // Uploaded files.
  'assets.remove': { workspaceId: string };
  'files.unused.sweep': Scheduled;
  'files.scan.backlog': Scheduled;

  // The morning run and the agent's runs.
  'morning.tick': Scheduled;
  'morning.run': { workspaceId: string };
  'run.resume': { workspaceId: string; runId: string };
  'run.sweep': Scheduled;

  // Automations.
  'automation.run': { workspaceId: string; runId: string };
  'automation.effect': { workspaceId: string; effectId: string };
  'automation.sweep': Scheduled;

  // Pages.
  'page.versions.prune': Scheduled;
  'page.trash.sweep': Scheduled;
  'page.trash.empty': { workspaceId: string };

  // The website chat.
  'chat.retention': Scheduled;
  'chat.sweep': Scheduled;

  // Housekeeping.
  'webhook.cleanup': Scheduled;
}

export type JobName = keyof JobPayloads;
