/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  watchPathIgnorePatterns: ['<rootDir>/dist'],
  transform: {
    // Full type checking is a separate release gate (`npm run typecheck`).
    // Avoid building the complete Prisma type graph in every test process.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
