/**
 * Integration tests: real Redis + Postgres from docker-compose.test.yml, but
 * each piece asserted on its own (webhook -> queue, webhook -> database).
 * The full gateway-to-worker chain lives in jest.e2e.config.js.
 *
 * `npm run test:integration` starts the containers for you.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/integration/.*\\.integration-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  /**
   * Serial execution is enforced HERE, not left to a --runInBand flag on the
   * command line.
   *
   * All three harnesses reset state with a global `user.deleteMany()`, so two
   * workers sharing one database wipe each other's fixtures mid-test. Measured:
   * running this tier in parallel fails 65 of 106 tests. Relying on the caller
   * to remember a flag means a CI that invokes jest directly gets a wall of
   * confusing failures that look like real bugs.
   */
  maxWorkers: 1,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30_000,
};
