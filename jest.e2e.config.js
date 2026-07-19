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
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 60_000,
};
