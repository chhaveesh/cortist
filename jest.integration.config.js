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
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30_000,
};
