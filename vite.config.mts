import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/vitest.setup.ts'],
    pool: 'forks',
    testTimeout: 10000,
  },
  lint: {
    ignorePatterns: [
      'dist/**',
      'build/**',
      'server-dist/**',
      'coverage/**',
      'node_modules/**',
      'scripts/**',
      'docs/**',
      'src/public/**',
      'webpack.config.js',
      'stats.json',
    ],
    plugins: ['typescript', 'import', 'vitest', 'node', 'promise'],
    env: {
      browser: true,
      node: true,
      es2022: true,
    },
    globals: {
      performance: 'readonly',
      __DEV__: 'readonly',
      fetch: 'readonly',
    },
    options: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': 'error',
      'no-undef': 'off',
      'no-underscore-dangle': ['error', { allowAfterThis: true }],
      'vitest/expect-expect': 'off',
      'vitest/no-conditional-expect': 'off',
      'vitest/require-mock-type-parameters': 'off',
      'promise/no-callback-in-promise': 'off',
    },
  },
  check: {
    fmt: false,
    lint: true,
  },
});
