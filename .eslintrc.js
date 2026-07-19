/**
 * ESLint for TypeScript, with Prettier as the sole authority on formatting.
 *
 * `plugin:prettier/recommended` must stay last: it turns off every stylistic
 * rule that would otherwise fight Prettier and surfaces formatting drift as a
 * lint error, so `npm run lint` and `npm run format` can never disagree.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: [
    '.eslintrc.js',
    'jest.config.js',
    'jest.integration.config.js',
    'jest.e2e.config.js',
    'dist/**',
    'node_modules/**',
    'coverage/**',
  ],
  rules: {
    // Decorator metadata means interfaces are frequently implemented but not
    // "used" in a way the base rule recognises.
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // An escape hatch that hides real type errors — the codebase is strict, so
    // any use should be deliberate and argued for.
    '@typescript-eslint/no-explicit-any': 'error',

    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // Floating promises in a queue consumer mean silently dropped work.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',

    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
  },
  overrides: [
    {
      // Tests reach into internals and build deliberately malformed payloads.
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
