/**
 * Integration tests for complete session lifecycle with real Valkey
 */

import {
  createTestStore,
  safeCloseClient,
  generateSessionData,
  generateTestSessions,
  cleanupTestData,
  measureTime,
  createTestSessionId,
  waitForValkey,
} from '../utils/test-helpers';
import { SessionData } from '../../src/types';

describe('Session Lifecycle Integration Tests', () => {
  let store: any;
  let client: any;

  beforeAll(async () => {
    await waitForValkey(30, 1000);
  }, 60000);

  beforeEach(async () => {
    const result = await createTestStore();
    store = result.store;
    client = result.client;
  });

  afterEach(async () => {
    if (client) {
      await cleanupTestData(client);
      await safeCloseClient(client);
    }
  });

  describe('Basic Session Operations', () => {
    it('should handle complete CRUD lifecycle', async () => {
      const sessionId = createTestSessionId('crud');
      const sessionData = generateSessionData({
        userId: 'test-user-123',
        hasCart: true,
        hasCookie: true,
      });

      // CREATE - Set session
      await new Promise<void>((resolve, reject) => {
        store.set(sessionId, sessionData, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Small delay to ensure data is persisted
      await new Promise(resolve => setTimeout(resolve, 50));

      // READ - Get session
      const retrievedSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(retrievedSession).toEqual(sessionData);

      // UPDATE - Update session
      const updatedData = { ...sessionData, lastActivity: new Date().toISOString() };
      await new Promise<void>((resolve, reject) => {
        store.set(sessionId, updatedData, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Small delay to ensure update is persisted
      await new Promise(resolve => setTimeout(resolve, 50));

      const updatedSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(updatedSession).toEqual(updatedData);

      // DELETE - Destroy session
      await new Promise<void>((resolve, reject) => {
        store.destroy(sessionId, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const deletedSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(deletedSession).toBeNull();
    });

    it('should handle sessions without callbacks', async () => {
      const sessionId = createTestSessionId('no-callback');
      const sessionData = generateSessionData();

      // Operations without callbacks return promises
      await store.set(sessionId, sessionData);

      // Verify the session was stored using promise
      const retrievedSession = await store.get(sessionId);
      expect(retrievedSession).toEqual(sessionData);

      // Destroy without callback returns a promise
      await store.destroy(sessionId);

      // Verify session was destroyed
      const deletedSession = await store.get(sessionId);
      expect(deletedSession).toBeNull();
    });
  });

  describe('TTL and Expiration', () => {
    it('should respect custom TTL settings', async () => {
      const result = await createTestStore({ ttl: 2 }); // 2 second TTL
      const customStore = result.store;
      const customClient = result.client;

      try {
        const sessionId = createTestSessionId('ttl');
        const sessionData = generateSessionData({ cookieMaxAge: 2000 }); // 2 second cookie maxAge

        await new Promise<void>((resolve, reject) => {
          customStore.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Check TTL is set correctly
        const key = `test-sess:${sessionId}`;
        const ttl = await customClient.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(2);

        // Session should exist initially
        const session1 = await new Promise((resolve, reject) => {
          customStore.get(sessionId, (err: any, session: any) => {
            if (err) reject(err);
            else resolve(session);
          });
        });
        expect(session1).toEqual(sessionData);

        // Wait for expiration
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Session should be expired
        const session2 = await new Promise((resolve, reject) => {
          customStore.get(sessionId, (err: any, session: any) => {
            if (err) reject(err);
            else resolve(session);
          });
        });
        expect(session2).toBeNull();
      } finally {
        await cleanupTestData(customClient);
        await safeCloseClient(customClient);
      }
    }, 10000);

    it('should respect session cookie maxAge over store TTL', async () => {
      const result = await createTestStore({ ttl: 3600 }); // 1 hour store TTL
      const cookieStore = result.store;
      const cookieClient = result.client;

      try {
        const sessionId = createTestSessionId('cookie-ttl');
        const sessionData = generateSessionData({
          hasCookie: true,
          cookieMaxAge: 2000, // 2 seconds cookie TTL
        });

        await new Promise<void>((resolve, reject) => {
          cookieStore.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Check TTL is set to cookie maxAge, not store TTL
        const key = `test-sess:${sessionId}`;
        const ttl = await cookieClient.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(2);
      } finally {
        await cleanupTestData(cookieClient);
        await safeCloseClient(cookieClient);
      }
    });

    it('should handle disableTTL option', async () => {
      const result = await createTestStore({ disableTTL: true });
      const noTtlStore = result.store;
      const noTtlClient = result.client;

      try {
        const sessionId = createTestSessionId('no-ttl');
        const sessionData = generateSessionData();

        await new Promise<void>((resolve, reject) => {
          noTtlStore.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // TTL should be -1 (never expire)
        const key = `test-sess:${sessionId}`;
        const ttl = await noTtlClient.ttl(key);
        expect(ttl).toBe(-1);
      } finally {
        await cleanupTestData(noTtlClient);
        await safeCloseClient(noTtlClient);
      }
    });
  });

  describe('Touch Functionality', () => {
    it('should update TTL on touch', async () => {
      const sessionId = createTestSessionId('touch');
      const sessionData = generateSessionData();

      // Set session with short TTL
      const result = await createTestStore({ ttl: 5 });
      const touchStore = result.store;
      const touchClient = result.client;

      try {
        await new Promise<void>((resolve, reject) => {
          touchStore.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Touch the session
        await new Promise<void>((resolve, reject) => {
          touchStore.touch(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // TTL should be refreshed
        const key = `test-sess:${sessionId}`;
        const ttl = await touchClient.ttl(key);
        expect(ttl).toBeGreaterThan(3); // Should be close to 5 again
      } finally {
        await cleanupTestData(touchClient);
        await safeCloseClient(touchClient);
      }
    }, 10000);

    it('should skip touch when disableTouch is true', async () => {
      const result = await createTestStore({ disableTouch: true, ttl: 5 });
      const noTouchStore = result.store;
      const noTouchClient = result.client;

      try {
        const sessionId = createTestSessionId('no-touch');
        const sessionData = generateSessionData();

        await new Promise<void>((resolve, reject) => {
          noTouchStore.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const key = `test-sess:${sessionId}`;
        const ttlBefore = await noTouchClient.ttl(key);

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Touch should not update TTL
        await new Promise<void>((resolve, reject) => {
          noTouchStore.touch(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const ttlAfter = await noTouchClient.ttl(key);
        expect(ttlAfter).toBeLessThan(ttlBefore); // TTL should have decreased naturally
      } finally {
        await cleanupTestData(noTouchClient);
        await safeCloseClient(noTouchClient);
      }
    }, 10000);
  });

  describe('Bulk Operations', () => {
    it('should handle all() method with real data', async () => {
      const sessions = generateTestSessions(5);

      // Store all sessions
      for (const { sid, data } of sessions) {
        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Retrieve all sessions
      const allSessions = await new Promise<{ [sid: string]: SessionData } | null>((resolve, reject) => {
        store.all((err: any, sessions?: { [sid: string]: SessionData } | null) => {
          if (err) reject(err);
          else resolve(sessions || null);
        });
      });

      expect(allSessions).not.toBeNull();
      expect(Object.keys(allSessions!)).toHaveLength(5);

      // Verify each session
      sessions.forEach(({ sid, data }) => {
        expect(allSessions![sid]).toEqual(data);
      });
    });

    it('should handle clear() method', async () => {
      const sessions = generateTestSessions(3);

      // Store sessions
      for (const { sid, data } of sessions) {
        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Verify sessions exist
      const lengthBefore = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });
      expect(lengthBefore).toBe(3);

      // Clear all sessions
      await new Promise<void>((resolve, reject) => {
        store.clear((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Verify sessions are cleared
      const lengthAfter = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });
      expect(lengthAfter).toBe(0);
    });

    it('should handle ids() method', async () => {
      const sessions = generateTestSessions(4);
      const expectedIds = sessions.map(s => s.sid).sort();

      // Store sessions
      for (const { sid, data } of sessions) {
        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Get session IDs
      const ids = await new Promise<string[]>((resolve, reject) => {
        store.ids((err: any, ids?: string[]) => {
          if (err) reject(err);
          else resolve(ids || []);
        });
      });

      expect(ids.sort()).toEqual(expectedIds);
    });

    it('should handle length() method', async () => {
      const sessions = generateTestSessions(7);

      // Store sessions
      for (const { sid, data } of sessions) {
        await new Promise<void>((resolve, reject) => {
          store.set(sid, data, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Get session count
      const length = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      expect(length).toBe(7);
    });
  });

  describe('Performance', () => {
    it('should handle rapid session operations', async () => {
      const sessionCount = 50;
      const sessions = generateTestSessions(sessionCount);

      // Measure set operations
      const { duration: setDuration } = await measureTime(async () => {
        const promises = sessions.map(({ sid, data }) =>
          new Promise<void>((resolve, reject) => {
            store.set(sid, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          })
        );
        await Promise.all(promises);
      });

      console.log(`Set ${sessionCount} sessions in ${setDuration.toFixed(2)}ms`);
      expect(setDuration).toBeLessThan(5000); // Should complete in under 5 seconds

      // Measure get operations
      const { duration: getDuration } = await measureTime(async () => {
        const promises = sessions.map(({ sid }) =>
          new Promise((resolve, reject) => {
            store.get(sid, (err: any, session: any) => {
              if (err) reject(err);
              else resolve(session);
            });
          })
        );
        await Promise.all(promises);
      });

      console.log(`Retrieved ${sessionCount} sessions in ${getDuration.toFixed(2)}ms`);
      expect(getDuration).toBeLessThan(3000); // Reads should be faster
    }, 15000);
  });
});