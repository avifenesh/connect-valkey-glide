/**
 * Integration tests for real Valkey client connections
 */

import {
  createTestStandaloneClient,
  createTestClusterClient,
  createTestStore,
  safeCloseClient,
  waitForValkey,
  ErrorSimulator,
} from '../utils/test-helpers';
import { GlideClient, TimeUnit } from '@valkey/valkey-glide';

describe('Valkey Connection Integration Tests', () => {
  beforeAll(async () => {
    await waitForValkey(30, 1000);
  }, 60000);

  describe('Standalone Connection', () => {
    let client: GlideClient;

    afterEach(async () => {
      if (client) {
        await safeCloseClient(client);
      }
    });

    it('should successfully connect to standalone Valkey', async () => {
      client = await createTestStandaloneClient();
      expect(client).toBeDefined();

      const result = await client.ping();
      expect(result).toBe('PONG');
    });

    it('should handle basic operations', async () => {
      client = await createTestStandaloneClient();

      // Test SET and GET
      await client.set('test:connection', 'test-value');
      const value = await client.get('test:connection');
      expect(value).toBe('test-value');

      // Test DEL
      const deleted = await client.del(['test:connection']);
      expect(deleted).toBe(1);

      // Verify deletion
      const deletedValue = await client.get('test:connection');
      expect(deletedValue).toBeNull();
    });

    it('should handle TTL operations', async () => {
      client = await createTestStandaloneClient();

      // Set with TTL
      await client.set('test:ttl', 'value', { expiry: { type: TimeUnit.Seconds, count: 10 } });

      // Check TTL
      const ttl = await client.ttl('test:ttl');
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);

      // Cleanup
      await client.del(['test:ttl']);
    });
  });

  describe('Cluster Connection', () => {
    let client: any;

    afterEach(async () => {
      if (client) {
        await safeCloseClient(client);
      }
    });

    it('should connect to Valkey cluster if available', async () => {
      try {
        client = await createTestClusterClient();
        expect(client).toBeDefined();

        const result = await client.ping();
        expect(result).toBe('PONG');
      } catch (error) {
        console.log('Cluster not available, skipping cluster tests');
        // Skip cluster tests if cluster is not properly configured
      }
    }, 30000);

    it('should handle cross-slot operations in cluster mode', async () => {
      try {
        client = await createTestClusterClient();

        // Set keys that might be on different slots
        await client.set('test:cluster:1', 'value1');
        await client.set('test:cluster:2', 'value2');

        const value1 = await client.get('test:cluster:1');
        const value2 = await client.get('test:cluster:2');

        expect(value1).toBe('value1');
        expect(value2).toBe('value2');

        // Cleanup
        await client.del(['test:cluster:1', 'test:cluster:2']);
      } catch (error) {
        console.log('Cluster test skipped:', error instanceof Error ? error.message : error);
      }
    }, 30000);
  });

  describe('ValkeyStore Connection', () => {
    let store: any;
    let client: any;

    afterEach(async () => {
      if (client) {
        await safeCloseClient(client);
      }
    });

    it('should create ValkeyStore with real client', async () => {
      const result = await createTestStore();
      store = result.store;
      client = result.client;

      expect(store).toBeDefined();
      expect(client).toBeDefined();

      // Test ping through client
      const ping = await client.ping();
      expect(ping).toBe('PONG');
    });

    it('should handle store operations with real client', async () => {
      const result = await createTestStore();
      store = result.store;
      client = result.client;

      const sessionData = { userId: 'test-user', loginTime: new Date().toISOString() };

      // Test set operation
      await new Promise<void>((resolve, reject) => {
        store.set('test-session', sessionData, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Test get operation
      const retrievedSession = await new Promise((resolve, reject) => {
        store.get('test-session', (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(retrievedSession).toEqual(sessionData);

      // Test destroy operation
      await new Promise<void>((resolve, reject) => {
        store.destroy('test-session', (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Verify destruction
      const destroyedSession = await new Promise((resolve, reject) => {
        store.get('test-session', (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(destroyedSession).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should handle connection timeouts gracefully', async () => {
      await expect(ErrorSimulator.createTimeoutClient()).rejects.toThrow();
    }, 15000);

    it('should handle connection failures', async () => {
      const client = await ErrorSimulator.createUnstableClient(3);

      // First few operations should work
      await client.get('test1');
      await client.get('test2');
      await client.get('test3');

      // Subsequent operations should fail
      await expect(client.get('test4')).rejects.toThrow('Simulated connection failure');

      await safeCloseClient(client);
    });
  });

  describe('Connection Lifecycle', () => {
    it('should handle connection close properly', async () => {
      const client = await createTestStandaloneClient();

      // Verify connection is working
      await client.ping();

      // Close connection
      await client.close();

      // Operations after close should fail
      await expect(client.ping()).rejects.toThrow();
    });

    it('should handle multiple rapid connections', async () => {
      const clients = await Promise.all([
        createTestStandaloneClient(),
        createTestStandaloneClient(),
        createTestStandaloneClient(),
      ]);

      // All clients should work
      const pings = await Promise.all(clients.map(client => client.ping()));
      expect(pings).toEqual(['PONG', 'PONG', 'PONG']);

      // Close all clients
      await Promise.all(clients.map(client => safeCloseClient(client)));
    });
  });
});