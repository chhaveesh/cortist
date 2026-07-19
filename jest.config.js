/**
 * Unit tests: fully mocked dependencies, no Docker required.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/unit/.*\\.spec\\.ts$',
  transform: {
    // `isolatedModules` transpiles per file instead of building a full type
    // program. Without it, pulling in the googleapis type tree pushes this
    // suite from ~3s to ~45s, which defeats the point of a fast unit tier.
    // Types are still checked — by `npm run lint` and `tsc --noEmit` in CI.
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/worker.ts'],
  coverageDirectory: 'coverage',
};
