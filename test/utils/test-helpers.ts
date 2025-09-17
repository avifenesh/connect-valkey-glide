import { GlideClient, GlideClientConfiguration, GlideClusterClient, GlideClusterClientConfiguration, ClusterScanCursor } from '@valkey/valkey-glide';
import { ValkeyStore } from '../../src/index';
import { SessionData } from '../../src/types';
import { Cookie } from 'express-session';

// Extend SessionData for testing purposes
interface TestSessionData extends SessionData {
  [key: string]: any;
  userId?: string;
  cart?: {
    items: { id?: string; name: string; price: number; quantity: number }[];
    total: number;
  };
}

// Test configuration constants
export const TEST_CONFIG = {
  STANDALONE: {
    addresses: [{ host: 'localhost', port: 6379 }],
    requestTimeout: 5000,
    inflightRequestsLimit: 10000, // Increased for performance tests
  } as GlideClientConfiguration,
  CLUSTER: {
    addresses: [
      { host: 'localhost', port: 8001 },
      { host: 'localhost', port: 8002 },
      { host: 'localhost', port: 8003 },
    ],
    requestTimeout: 5000,
    inflightRequestsLimit: 10000, // Increased for performance tests
  } as GlideClusterClientConfiguration,
  TEST_PREFIX: 'test-sess:',
  DEFAULT_TTL: 3600,
} as const;

/**
 * Creates a real GlideClient connection for testing
 */
export async function createTestStandaloneClient(): Promise<GlideClient> {
  const client = await GlideClient.createClient(TEST_CONFIG.STANDALONE);
  return client;
}

/**
 * Creates a real GlideClusterClient connection for testing
 */
export async function createTestClusterClient(): Promise<GlideClusterClient> {
  const client = await GlideClusterClient.createClient(TEST_CONFIG.CLUSTER);
  return client;
}

/**
 * Creates a ValkeyStore instance with a real client for testing
 */
export async function createTestStore(options: {
  useCluster?: boolean;
  prefix?: string;
  ttl?: number;
  disableTTL?: boolean;
  disableTouch?: boolean;
  scanCount?: number;
  logErrors?: boolean;
  serializer?: {
    stringify: (obj: any) => string;
    parse: (str: string) => any;
  };
} = {}): Promise<{ store: ValkeyStore; client: GlideClient | GlideClusterClient }> {
  const client = options.useCluster
    ? await createTestClusterClient()
    : await createTestStandaloneClient();

  const store = new ValkeyStore({
    client: client as GlideClient, // Type assertion for compatibility
    prefix: options.prefix || TEST_CONFIG.TEST_PREFIX,
    ttl: options.ttl || TEST_CONFIG.DEFAULT_TTL,
    disableTTL: options.disableTTL,
    disableTouch: options.disableTouch,
    scanCount: options.scanCount,
    logErrors: options.logErrors !== false,
    serializer: options.serializer,
  });

  return { store, client };
}

/**
 * Wait for Valkey to be ready by attempting connections with retries
 */
export async function waitForValkey(
  maxRetries: number = 30,
  retryDelay: number = 1000,
  useCluster: boolean = false
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = useCluster
        ? await createTestClusterClient()
        : await createTestStandaloneClient();

      await client.ping();
      await client.close();
      return;
    } catch (error) {
      if (i === maxRetries - 1) {
        throw new Error(`Valkey not ready after ${maxRetries} attempts: ${error}`);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

/**
 * Clean up test data from Valkey
 */
export async function cleanupTestData(
  client: GlideClient | GlideClusterClient,
  prefix: string = TEST_CONFIG.TEST_PREFIX
): Promise<void> {
  const pattern = `${prefix}*`;
  const isCluster = client instanceof GlideClusterClient;
  let cursor: any = isCluster ? new ClusterScanCursor() : '0';
  const keysToDelete: string[] = [];

  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: pattern, count: 1000 });
    keysToDelete.push(...keys.map(k => typeof k === 'string' ? k : k.toString()));
    cursor = nextCursor;
  } while (isCluster ? !cursor.isFinished() : (cursor !== '0' && cursor.toString() !== '0'));

  if (keysToDelete.length > 0) {
    await client.del(keysToDelete);
  }
}

/**
 * Generate realistic session data for testing
 */
export function generateSessionData(options: {
  userId?: string;
  hasCart?: boolean;
  hasCookie?: boolean;
  cookieMaxAge?: number;
  additionalData?: Record<string, any>;
} = {}): TestSessionData {
  const sessionData: TestSessionData = {
    userId: options.userId || `user_${Math.random().toString(36).substring(2, 11)}`,
    loginTime: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ipAddress: `192.168.1.${Math.floor(Math.random() * 255)}`,
    userAgent: 'Mozilla/5.0 (compatible; TestRunner/1.0)',
    cookie: options.cookieMaxAge !== undefined ? {
      maxAge: options.cookieMaxAge,
      originalMaxAge: options.cookieMaxAge,
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    } as Cookie : {
      maxAge: 3600000, // Default 1 hour if not specified
      originalMaxAge: 3600000,
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    } as Cookie,
    ...(options.additionalData || {}),
  };

  if (options.hasCart) {
    sessionData.cart = {
      items: [
        { id: 'item1', name: 'Test Product', price: 29.99, quantity: 2 },
        { id: 'item2', name: 'Another Product', price: 19.99, quantity: 1 },
      ],
      total: 79.97,
    };
  }


  return sessionData;
}

/**
 * Generate multiple test sessions
 */
export function generateTestSessions(count: number): Array<{ sid: string; data: TestSessionData }> {
  return Array.from({ length: count }, (_, i) => ({
    sid: `session_${i.toString().padStart(4, '0')}`,
    data: generateSessionData({
      userId: `user_${i}`,
      hasCart: i % 3 === 0,
      hasCookie: i % 2 === 0,
      cookieMaxAge: (i % 5 + 1) * 600000, // 10-50 minutes
    }),
  }));
}

/**
 * Measure execution time of an async function
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  const duration = Number(end - start) / 1_000_000; // Convert to milliseconds
  return { result, duration };
}

/**
 * Wait for a condition to be met with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 10000,
  interval: number = 100
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Create a test session ID that's guaranteed to be unique
 */
export function createTestSessionId(prefix: string = 'test'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Safely close client connections
 */
export async function safeCloseClient(client: GlideClient | GlideClusterClient): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    // Ignore close errors
  }
}

/**
 * Test utilities for error simulation
 */
export class ErrorSimulator {
  /**
   * Simulate network timeout by creating a connection to non-existent address
   */
  static async createTimeoutClient(): Promise<GlideClient> {
    return GlideClient.createClient({
      addresses: [{ host: '10.255.255.1', port: 6379 }], // Non-routable IP
      requestTimeout: 100,
    });
  }

  /**
   * Create a client that will fail after a certain number of operations
   */
  static async createUnstableClient(failAfter: number = 5): Promise<GlideClient> {
    const client = await createTestStandaloneClient();
    let operationCount = 0;

    // Wrap client methods to simulate failures
    const originalGet = client.get.bind(client);
    client.get = async (...args) => {
      if (++operationCount > failAfter) {
        throw new Error('Simulated connection failure');
      }
      return originalGet(...args);
    };

    return client;
  }
}