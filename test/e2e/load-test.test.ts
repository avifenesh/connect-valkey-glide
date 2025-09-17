/**
 * Load testing for ValkeyStore with real Express applications
 */

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import {
  createTestStandaloneClient,
  safeCloseClient,
  cleanupTestData,
  waitForValkey,
  measureTime,
} from '../utils/test-helpers';
import { ValkeyStore } from '../../src/index';

describe('Load Testing E2E', () => {
  let client: any;
  let app: express.Application;
  let store: ValkeyStore;

  beforeAll(async () => {
    await waitForValkey(30, 1000);
    client = await createTestStandaloneClient();
  }, 60000);

  afterAll(async () => {
    if (client) {
      await cleanupTestData(client);
      await safeCloseClient(client);
    }
  });

  beforeEach(async () => {
    // Clean up any existing test data with load-test-sess prefix
    await cleanupTestData(client, 'load-test-sess:');

    store = new ValkeyStore({
      client: client,
      prefix: 'load-test-sess:',
      ttl: 3600,
      scanCount: 1000, // Optimized for load testing
      logErrors: false, // Reduce noise during load tests
    });

    app = express();
    app.use(express.json());

    app.use(session({
      store: store,
      secret: 'load-test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 3600000, // 1 hour
      },
    }));

    // Lightweight test routes
    app.get('/create-session', (req: any, res) => {
      req.session.userId = `user_${Math.random().toString(36).substr(2, 9)}`;
      req.session.created = Date.now();
      res.json({
        sessionId: req.sessionID,
        userId: req.session.userId,
        created: req.session.created,
      });
    });

    app.get('/read-session', (req: any, res) => {
      res.json({
        sessionId: req.sessionID,
        userId: req.session?.userId || null,
        created: req.session?.created || null,
        accessTime: Date.now(),
      });
    });

    app.post('/update-session', (req: any, res) => {
      if (req.session) {
        req.session.data = req.body;
        req.session.updated = Date.now();
      }
      res.json({
        sessionId: req.sessionID,
        updated: req.session?.updated,
        dataSize: JSON.stringify(req.body).length,
      });
    });

    app.delete('/destroy-session', (req: any, res) => {
      req.session.destroy((err: any) => {
        res.json({
          success: !err,
          error: err?.message || null,
        });
      });
    });
  });

  afterEach(async () => {
    // Clean up sessions after each test to ensure isolation
    await cleanupTestData(client, 'load-test-sess:');
  });

  describe('High Volume Session Creation', () => {
    it('should handle 1000 concurrent session creations', async () => {
      const concurrentUsers = 1000;
      console.log(`Testing ${concurrentUsers} concurrent session creations...`);

      const { result, duration } = await measureTime(async () => {
        const promises = Array.from({ length: concurrentUsers }, () =>
          request(app).get('/create-session')
        );

        const responses = await Promise.all(promises);
        return responses;
      });

      const successfulRequests = result.filter(r => r.status === 200);
      const failedRequests = result.filter(r => r.status !== 200);

      console.log(`Successful requests: ${successfulRequests.length}`);
      console.log(`Failed requests: ${failedRequests.length}`);
      console.log(`Total time: ${duration.toFixed(2)}ms`);
      console.log(`Requests/second: ${(concurrentUsers / (duration / 1000)).toFixed(2)}`);

      expect(successfulRequests.length).toBeGreaterThan(concurrentUsers * 0.95); // 95% success rate
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds

      // Verify all sessions were created in store
      const sessionCount = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      expect(sessionCount).toBe(successfulRequests.length);
    }, 60000);

    it('should handle rapid sequential session operations', async () => {
      const operationCount = 2000;
      const agents = Array.from({ length: 100 }, () => request.agent(app));

      console.log(`Testing ${operationCount} sequential operations across ${agents.length} agents...`);

      const { duration } = await measureTime(async () => {
        for (let i = 0; i < operationCount; i++) {
          const agent = agents[i % agents.length];
          const operation = i % 4;

          switch (operation) {
            case 0: // Create session
              await agent.get('/create-session');
              break;
            case 1: // Read session
              await agent.get('/read-session');
              break;
            case 2: // Update session
              await agent.post('/update-session').send({
                iteration: i,
                timestamp: Date.now(),
                data: `operation-${i}`,
              });
              break;
            case 3: // Destroy some sessions
              if (i % 20 === 0) { // Only destroy every 20th session
                await agent.delete('/destroy-session');
              }
              break;
          }
        }
      });

      const operationsPerSecond = operationCount / (duration / 1000);
      console.log(`Sequential operations: ${operationsPerSecond.toFixed(2)} ops/sec`);
      console.log(`Total time: ${duration.toFixed(2)}ms`);

      expect(operationsPerSecond).toBeGreaterThan(50); // At least 50 ops/sec
    }, 120000);
  });

  describe('Memory and Performance Under Load', () => {
    it('should handle large session data under load', async () => {
      const userCount = 500;
      const largeDataSize = 50; // KB per session

      // Create large session data
      const largeData = {
        userId: 'load-test-user',
        preferences: Array(largeDataSize * 10).fill('data').map((_, i) => ({
          id: i,
          name: `preference-${i}`,
          value: 'x'.repeat(100), // 100 chars
          metadata: Array(10).fill(`meta-${i}`),
        })),
        history: Array(1000).fill(0).map((_, i) => ({
          action: `action-${i}`,
          timestamp: Date.now() - i * 1000,
          details: `details-${i}`.repeat(10),
        })),
      };

      console.log(`Testing ${userCount} users with ~${largeDataSize}KB sessions each...`);

      const { duration } = await measureTime(async () => {
        const promises = Array.from({ length: userCount }, async () => {
          const agent = request.agent(app);

          // Create session
          await agent.get('/create-session');

          // Store large data
          await agent.post('/update-session').send(largeData);

          // Read it back
          const response = await agent.get('/read-session');
          expect(response.status).toBe(200);

          return response.body;
        });

        const results = await Promise.all(promises);
        return results;
      });

      const sessionCount = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      console.log(`Large session test completed in ${duration.toFixed(2)}ms`);
      console.log(`Sessions per second: ${(userCount / (duration / 1000)).toFixed(2)}`);
      console.log(`Sessions created: ${sessionCount}`);

      expect(sessionCount).toBe(userCount);
      expect(duration).toBeLessThan(60000); // Should complete within 1 minute
    }, 120000);

    it('should maintain performance with many active sessions', async () => {
      const activeSessionCount = 5000;
      console.log(`Creating ${activeSessionCount} active sessions...`);

      // Create many sessions
      const createPromises = Array.from({ length: activeSessionCount }, () =>
        request(app).get('/create-session')
      );

      await Promise.all(createPromises);

      // Verify all sessions were created
      const sessionCount = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      expect(sessionCount).toBe(activeSessionCount);

      // Now test performance with many existing sessions
      console.log('Testing performance with many active sessions...');

      const { duration } = await measureTime(async () => {
        const testPromises = Array.from({ length: 100 }, () => {
          const agent = request.agent(app);
          return agent.get('/create-session');
        });

        await Promise.all(testPromises);
      });

      const requestsPerSecond = 100 / (duration / 1000);
      console.log(`Performance with ${activeSessionCount} existing sessions: ${requestsPerSecond.toFixed(2)} req/sec`);

      expect(requestsPerSecond).toBeGreaterThan(10); // Should still be reasonably fast
    }, 180000);
  });

  describe('Session Store Operations Under Load', () => {
    it('should handle bulk session retrieval efficiently', async () => {
      const sessionCount = 2000;

      // Create many sessions
      console.log(`Creating ${sessionCount} sessions for bulk retrieval test...`);

      const createPromises = Array.from({ length: sessionCount }, (_, i) =>
        request(app).get('/create-session')
      );

      await Promise.all(createPromises);

      // Test bulk operations
      console.log('Testing bulk session operations...');

      // Test all() method
      const { result: allSessions, duration: allDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.all((err: any, sessions: any) => {
            if (err) reject(err);
            else resolve(sessions);
          });
        });
      });

      const typedSessions = allSessions as { [sid: string]: any } | null;
      const sessionKeys = typedSessions ? Object.keys(typedSessions) : [];
      console.log(`Retrieved all ${sessionKeys.length} sessions in ${allDuration.toFixed(2)}ms`);
      expect(sessionKeys).toHaveLength(sessionCount);
      expect(allDuration).toBeLessThan(10000); // Should complete within 10 seconds

      // Test ids() method
      const { result: sessionIds, duration: idsDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.ids((err: any, ids: any) => {
            if (err) reject(err);
            else resolve(ids);
          });
        });
      });

      const typedIds = sessionIds as string[] | undefined;
      const idsLength = typedIds ? typedIds.length : 0;
      console.log(`Retrieved ${idsLength} session IDs in ${idsDuration.toFixed(2)}ms`);
      expect(typedIds).toHaveLength(sessionCount);
      expect(idsDuration).toBeLessThan(5000); // IDs should be faster than full retrieval

      // Test length() method
      const { result: length, duration: lengthDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.length((err: any, length: any) => {
            if (err) reject(err);
            else resolve(length);
          });
        });
      });

      console.log(`Counted ${length} sessions in ${lengthDuration.toFixed(2)}ms`);
      expect(length).toBe(sessionCount);
      expect(lengthDuration).toBeLessThan(3000); // Count should be fastest
    }, 120000);

    it('should handle session cleanup under load', async () => {
      const sessionCount = 1000;

      // Create store with short TTL for cleanup testing
      const shortTtlStore = new ValkeyStore({
        client: client,
        prefix: 'cleanup-test-sess:',
        ttl: 3, // 3 seconds
        scanCount: 500,
        logErrors: false,
      });

      const cleanupApp = express();
      cleanupApp.use(session({
        store: shortTtlStore,
        secret: 'cleanup-test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false, maxAge: 3000 }, // 3 seconds
      }));

      cleanupApp.get('/create', (req: any, res) => {
        req.session.userId = `cleanup-user-${Math.random()}`;
        res.json({ sessionId: req.sessionID });
      });

      console.log(`Creating ${sessionCount} sessions with short TTL...`);

      // Create many sessions
      const createPromises = Array.from({ length: sessionCount }, () =>
        request(cleanupApp).get('/create')
      );

      await Promise.all(createPromises);

      // Verify all sessions were created
      const initialCount = await new Promise((resolve, reject) => {
        shortTtlStore.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      const typedInitialCount = initialCount as number;
      expect(typedInitialCount).toBe(sessionCount);

      // Wait for sessions to expire
      console.log('Waiting for sessions to expire...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check sessions have expired naturally
      console.log('Checking expired sessions...');

      const finalCount = await new Promise((resolve, reject) => {
        shortTtlStore.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      const typedFinalCount = finalCount as number;
      console.log(`Remaining sessions: ${typedFinalCount} (was ${typedInitialCount})`);

      // Valkey automatically removes expired keys on access
      // So we expect most sessions to be gone
      expect(typedFinalCount).toBeLessThan(100); // Most should have expired
    }, 30000);
  });

  describe('Stress Testing', () => {
    it('should handle extreme concurrent load', async () => {
      const extremeLoad = 2000;
      const batchSize = 100;

      console.log(`Stress testing with ${extremeLoad} operations in batches of ${batchSize}...`);

      let totalOperations = 0;
      let totalDuration = 0;

      // Process in batches to avoid overwhelming the system
      for (let batch = 0; batch < extremeLoad / batchSize; batch++) {
        const { duration } = await measureTime(async () => {
          const promises = Array.from({ length: batchSize }, () => {
            const randomOp = Math.floor(Math.random() * 3);

            switch (randomOp) {
              case 0:
                return request(app).get('/create-session');
              case 1:
                return request(app).get('/read-session');
              case 2:
                return request(app).post('/update-session').send({
                  batch: batch,
                  timestamp: Date.now(),
                  data: Math.random().toString(36),
                });
              default:
                return request(app).get('/create-session');
            }
          });

          const results = await Promise.all(promises);
          return results.filter(r => r.status === 200).length;
        });

        totalOperations += batchSize;
        totalDuration += duration;

        if (batch % 5 === 0) {
          console.log(`Completed batch ${batch + 1}/${extremeLoad / batchSize} in ${duration.toFixed(2)}ms`);
        }
      }

      const overallOpsPerSecond = totalOperations / (totalDuration / 1000);
      console.log(`Extreme load test: ${overallOpsPerSecond.toFixed(2)} ops/sec over ${totalOperations} operations`);

      // Final session count check
      const finalSessionCount = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      console.log(`Final session count: ${finalSessionCount}`);

      expect(overallOpsPerSecond).toBeGreaterThan(20); // Minimum acceptable performance
      expect(finalSessionCount).toBeGreaterThan(0); // Some sessions should exist
    }, 300000); // 5 minute timeout for stress test
  });
});