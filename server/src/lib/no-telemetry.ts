/**
 * CopilotKit's runtime sends usage telemetry by default. Timmy switches it off: the only data CopilotKit gets is what
 * Intelligence keeps, when it is turned on (http/copilotkit.ts). Imported first by the server's entry point, before the
 * runtime is loaded; the Dockerfile sets the same variables.
 */
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= 'true';
process.env.DO_NOT_TRACK ??= '1';

export {};
