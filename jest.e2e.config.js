/**
 * End-to-end tests: the full chain, gateway -> queue -> real worker -> Postgres,
 * plus the operational behaviours that only appear across that whole path
 * (graceful shutdown, retry and failure policy).
 *
 * Requires the containers from docker-compose.test.yml; `npm run test:e2e`
 * starts them for you.
 *
 * Runs serially (--runInBand) because the suites share one database and one
 * Redis instance and each resets state between tests.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
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
  testTimeout: 60_000,
};
