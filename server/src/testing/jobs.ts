/**
 * The in-process job runner: jobs are kept in a list and run only when asked, so a test decides when time
 * passes. It is the queue until the real one (pg-boss) is started, which tests and local scripts never do.
 *
 * It takes any job name, so a test can queue a job by a name it holds in a variable; the rest of the server
 * reaches it through the typed `Jobs` interface (jobs/jobs.ts).
 */
import type { JobOptions, Jobs } from '../jobs/jobs';

type Run = (data: Record<string, unknown>) => Promise<void>;

/** Runs jobs in-process when asked. For tests and for local runs without a queue. */
export class InlineJobs implements Jobs {
  queue: { name: string; data: Record<string, unknown>; opts: JobOptions }[] = [];

  /** `handlerFor` finds the handler defined for a job's name, or nothing when none is. */
  constructor(private handlerFor: (name: string) => Run | undefined) {}

  async enqueue(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    if (opts.singletonKey && this.queue.some((j) => j.name === name && j.opts.singletonKey === opts.singletonKey)) return;
    this.queue.push({ name, data, opts });
  }
  /** Runs everything queued (and whatever those jobs queue), whatever their start time. */
  async drain(only?: string): Promise<number> {
    let ran = 0;
    // The limit only stops a job that keeps queueing itself for ever. It has to sit well above the longest honest
    // queue: the nightly mail check alone queues one job for every connected mailbox there is.
    for (let guard = 0; guard < 2000; guard++) {
      const i = this.queue.findIndex((j) => !only || j.name === only);
      if (i < 0) break;
      const [job] = this.queue.splice(i, 1);
      const h = this.handlerFor(job!.name);
      if (h) await h(job!.data);
      ran++;
    }
    return ran;
  }
  async stop() {
    this.queue = [];
  }
}
