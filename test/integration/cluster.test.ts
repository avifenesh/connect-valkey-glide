/**
 * Cluster-specific integration tests for ValkeyStore
 *
 * NOTE: These tests require a Valkey cluster to be running.
 * The implementation fully supports cluster mode with:
 * - cursor.isFinished() for cluster scan operations
 * - MGET cross-slot key handling via valkey-glide
 * - Automatic failover and slot management
 *
 * To run cluster tests:
 * 1. Setup a cluster manually or use npm run cluster:setup
 * 2. Run tests with: npm run test:integration -- test/integration/cluster.test.ts
 */

import {
  createTestStore,
  safeCloseClient,
  generateSessionData,
  cleanupTestData,
  createTestSessionId,
  waitForValkey,
} from '../utils/test-helpers';

describe('ValkeyStore Cluster Integration', () => {
  let store: any;
  let client: any;

  describe('Cluster Operations', () => {
    beforeEach(async () => {
      try {
        const result = await createTestStore({ useCluster: true });
        store = result.store;
        client = result.client;
      } catch (error) {
        // Cluster not available
      }
    });

    afterEach(async () => {
      if (client) {
        await cleanupTestData(client);
        await safeCloseClient(client);
      }
    });

    it('should handle basic CRUD operations in cluster mode', async () => {
      if (!client) {
        console.log('Cluster not available, skipping test');
        return;
      }

      const sessionId = createTestSessionId('cluster-crud');
      const sessionData = generateSessionData();

      // Set
      await new Promise<void>((resolve, reject) => {
        store.set(sessionId, sessionData, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Get
      const retrieved = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(retrieved).toEqual(sessionData);

      // Destroy
      await new Promise<void>((resolve, reject) => {
        store.destroy(sessionId, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Verify destroyed
      const deleted = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(deleted).toBeNull();
    });

    it('should handle SCAN operations with MGET in cluster mode', async () => {
      if (!client) {
        console.log('Cluster not available, skipping test');
        return;
      }

      // Create sessions that will likely be distributed across cluster nodes
      const sessionCount = 100;
      const sessions: { [key: string]: any } = {};

      for (let i = 0; i < sessionCount; i++) {
        const sid = `cluster-scan-${i}`;
        const data = generateSessionData({ userId: `user_${i}` });
        sessions[sid] = data;

        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Test all() which uses SCAN + MGET
      const allSessions = await new Promise<any>((resolve, reject) => {
        store.all((err: any, sessions: any) => {
          if (err) reject(err);
          else resolve(sessions);
        });
      });

      expect(Object.keys(allSessions).length).toBe(sessionCount);

      // Verify data integrity
      for (const [sid, data] of Object.entries(sessions)) {
        expect(allSessions[sid]).toEqual(data);
      }

      // Test length()
      const length = await new Promise<number>((resolve, reject) => {
        store.length((err: any, len: any) => {
          if (err) reject(err);
          else resolve(len);
        });
      });

      expect(length).toBe(sessionCount);

      // Test ids()
      const ids = await new Promise<string[]>((resolve, reject) => {
        store.ids((err: any, sessionIds: any) => {
          if (err) reject(err);
          else resolve(sessionIds);
        });
      });

      expect(ids.length).toBe(sessionCount);
      expect(ids.sort()).toEqual(Object.keys(sessions).sort());

      // Cleanup
      await new Promise<void>((resolve, reject) => {
        store.clear((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Verify cleanup
      const afterClear = await new Promise<number>((resolve, reject) => {
        store.length((err: any, len: any) => {
          if (err) reject(err);
          else resolve(len);
        });
      });

      expect(afterClear).toBe(0);
    }, 30000);

    it('should handle cursor.isFinished() correctly in cluster mode', async () => {
      if (!client) {
        console.log('Cluster not available, skipping test');
        return;
      }

      // Create enough sessions to ensure multiple SCAN iterations
      const sessionCount = 500;

      for (let i = 0; i < sessionCount; i++) {
        const sid = `cursor-test-${i}`;
        const data = generateSessionData();

        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Use a small scanCount to force multiple iterations
      const smallScanStore = await createTestStore({
        useCluster: true,
        scanCount: 10
      });

      try {
        // This will test the cursor.isFinished() logic through multiple iterations
        const allSessions = await new Promise<any>((resolve, reject) => {
          smallScanStore.store.all((err: any, sessions: any) => {
            if (err) reject(err);
            else resolve(sessions);
          });
        });

        expect(Object.keys(allSessions).length).toBe(sessionCount);
      } finally {
        if (smallScanStore.client) {
          await safeCloseClient(smallScanStore.client);
        }
      }
    }, 30000);

    it('should handle promise-based API in cluster mode', async () => {
      if (!client) {
        console.log('Cluster not available, skipping test');
        return;
      }

      const sessionId = createTestSessionId('cluster-promise');
      const sessionData = generateSessionData();

      // Test promise-based operations
      await store.set(sessionId, sessionData);
      const retrieved = await store.get(sessionId);
      expect(retrieved).toEqual(sessionData);

      await store.touch(sessionId, sessionData);

      const length = await store.length();
      expect(length).toBeGreaterThan(0);

      const ids = await store.ids();
      expect(ids).toContain(sessionId);

      await store.destroy(sessionId);
      const deleted = await store.get(sessionId);
      expect(deleted).toBeNull();
    });
  });
});