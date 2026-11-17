/**
 * How an effect record says it was put forward by a step of an automation's run. Kept apart from the rest of the
 * engine, with no imports, so the gateway can ask without loading the engine.
 */

/** The key that makes a step's effect record the same record however often the step is tried. */
export const effectKey = (runId: string, nodeId: string) => `run:${runId}:node:${nodeId}`;

/** Whether an effect was put forward by a step of an automation's run. Its key says so: "run:arun_…:node:…". */
export const isAutomationEffect = (e: { idempotency_key: string }) => /^run:arun_[^:]+:node:/.test(e.idempotency_key);
