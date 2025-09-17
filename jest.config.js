module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/test/**/*.test.ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
  ],
  verbose: true,
  // Different timeout for integration tests
  testTimeout: process.env.CI ? 30000 : 10000,
  // Run tests sequentially in CI to avoid race conditions
  maxWorkers: process.env.CI ? 1 : 4,
  // Setup files for integration tests
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // Module path mapping for test utilities
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@test/(.*)$': '<rootDir>/test/$1',
  },
};