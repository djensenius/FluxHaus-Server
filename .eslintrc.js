module.exports = {
  globals: {
    performance: 'readonly',
    __DEV__: 'readonly',
    fetch: false,
  },
  root: true,
  env: { 'jest/globals': true, browser: true },
  extends: ['plugin:@typescript-eslint/recommended', 'airbnb'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier', 'jest'],
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
    react: {
      version: '17.0.2',
    },
    'import/resolver': {
      webpack: {},
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
      },
    },
  },
  rules: {
    // This rule is silly and going to be phased out
    'promise/prefer-await-to-then': 'off',
    'import/extensions': [
      'error',
      'ignorePackages',
      {
        js: 'never',
        jsx: 'never',
        ts: 'never',
        tsx: 'never',
      },
    ],
    'no-multiple-empty-lines': [2, { max: 2, maxEOF: 1 }],
    'no-underscore-dangle': ['error', { allowAfterThis: true }],
    'jest/no-disabled-tests': 'warn',
    'jest/no-focused-tests': 'error',
    'jest/no-identical-title': 'error',
    'jest/prefer-to-have-length': 'warn',
    'jest/valid-expect': 'error',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'max-len': ['error', { code: 120 }],
    'react/jsx-filename-extension': [1, { extensions: ['.jsx', '.tsx'] }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    indent: ['error', 2],
    'sort-imports': ['error', {
      ignoreCase: false,
      ignoreDeclarationSort: true,
      ignoreMemberSort: false,
    }],
    'no-unused-vars': 'off',
    'no-use-before-define': 'off',
    'no-undef': 'off',
    '@typescript-eslint/no-use-before-define': ['error'],
  },
};
