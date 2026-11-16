import { defineConfig } from 'vitest/config';

// One process, one file at a time: the suites share a database and the fake providers.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: './test/setup.ts',
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      TIMMY_ENV: 'test',
      NODE_ENV: 'test',
      TIMMY_FAKE_PROVIDERS: '1',
      TIMMY_TEST_HOOKS: '1',
      TIMMY_SEND_HOLD_SECONDS: '30',
      PUBLIC_URL: 'http://localhost:8787',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://timmy_owner:timmy@localhost:5432/timmy_test',
      // Stand-ins shaped like real keys, so tests can prove they never reach a prompt or a log.
      // Built at run time so no key-shaped string sits in the repository.
      OPENROUTER_API_KEY: ['sk', 'or', 'v1', '0'.repeat(64)].join('-'),
      COMPOSIO_API_KEY: ['ak', 'TESTKEY' + '0'.repeat(13)].join('_'),
      COMPOSIO_WEBHOOK_SECRET: '',
      BETTER_AUTH_SECRET: 'test-auth-secret-0123456789abcdef0123456789abcdef',
    },
  },
});
