module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    // jose is ESM-only — transpile it for Jest compatibility
    'node_modules/jose/.+\\.js$': 'ts-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!jose/)',
  ],
};
