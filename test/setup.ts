import { cleanupTestData, createTestStandaloneClient, safeCloseClient, TEST_CONFIG } from './utils/test-helpers';

// Global test setup and teardown
let globalClient: any;

beforeAll(async () => {
  // Only run this for integration tests
  if (process.env.JEST_WORKER_ID && (expect.getState().testPath?.includes('integration') || expect.getState().testPath?.includes('e2e'))) {
    try {
      globalClient = await createTestStandaloneClient();
      // Clean up any existing test data
      await cleanupTestData(globalClient);
    } catch (error) {
      console.warn('Could not connect to Valkey for test setup. Make sure Valkey is running for integration tests.');
    }
  }
}, 30000);

afterAll(async () => {
  if (globalClient) {
    try {
      // Final cleanup
      await cleanupTestData(globalClient);
      await safeCloseClient(globalClient);
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}, 30000);

// Increase timeout for integration tests
if (process.env.NODE_ENV === 'integration') {
  jest.setTimeout(30000);
}