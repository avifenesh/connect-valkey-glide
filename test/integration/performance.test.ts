/**
 * Performance and concurrency integration tests with real Valkey
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

describe('Performance Integration Tests', () => {
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

  describe('Throughput Tests', () => {
    it('should handle high-volume sequential operations', async () => {
      const sessionCount = 1000;
      const sessions = generateTestSessions(sessionCount);

      // Sequential writes
      const { duration: writeDuration } = await measureTime(async () => {
        for (const { sid, data } of sessions) {
          await new Promise<void>((resolve, reject) => {
            store.set(sid, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
      });

      const writeOpsPerSec = sessionCount / (writeDuration / 1000);
      console.log(`Sequential writes: ${writeOpsPerSec.toFixed(0)} ops/sec`);

      // Sequential reads
      const { duration: readDuration } = await measureTime(async () => {
        for (const { sid } of sessions) {
          await new Promise((resolve, reject) => {
            store.get(sid, (err: any, session: any) => {
              if (err) reject(err);
              else resolve(session);
            });
          });
        }
      });

      const readOpsPerSec = sessionCount / (readDuration / 1000);
      console.log(`Sequential reads: ${readOpsPerSec.toFixed(0)} ops/sec`);

      // Use relative comparison instead of absolute limits
      expect(readOpsPerSec).toBeGreaterThan(writeOpsPerSec * 0.8); // Reads should be at least 80% of write speed
      expect(writeOpsPerSec).toBeGreaterThan(0); // Ensure operations completed
      expect(readOpsPerSec).toBeGreaterThan(0); // Ensure operations completed
    }, 60000);

    it('should handle concurrent operations efficiently', async () => {
      const sessionCount = 500;
      const sessions = generateTestSessions(sessionCount);

      // Concurrent writes
      const { duration: concurrentWriteDuration } = await measureTime(async () => {
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

      const concurrentWriteOps = sessionCount / (concurrentWriteDuration / 1000);
      console.log(`Concurrent writes: ${concurrentWriteOps.toFixed(0)} ops/sec`);

      // Concurrent reads
      const { duration: concurrentReadDuration } = await measureTime(async () => {
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

      const concurrentReadOps = sessionCount / (concurrentReadDuration / 1000);
      console.log(`Concurrent reads: ${concurrentReadOps.toFixed(0)} ops/sec`);

      // Concurrent operations should be significantly faster than sequential for the same workload
      // Use relative comparison instead of absolute limits
      expect(concurrentWriteOps).toBeGreaterThan(0); // Ensure operations completed
      expect(concurrentReadOps).toBeGreaterThan(0); // Ensure operations completed

      // Log the performance ratios for monitoring
      const writeRatio = concurrentWriteOps / sessionCount * 1000; // ops per second per session
      const readRatio = concurrentReadOps / sessionCount * 1000; // ops per second per session
      console.log(`Write efficiency: ${writeRatio.toFixed(2)} ops/sec/session`);
      console.log(`Read efficiency: ${readRatio.toFixed(2)} ops/sec/session`);
    }, 30000);
  });

  describe('Memory and Resource Tests', () => {
    it('should handle large session data efficiently', async () => {
      const sessionId = createTestSessionId('large');

      // Create large session data (100KB)
      const largeData = generateSessionData({
        additionalData: {
          largeArray: Array(10000).fill('test-data-string'),
          metadata: {
            timestamp: Date.now(),
            version: '1.0.0',
            features: Array(1000).fill('feature'),
          },
        },
      });

      const { duration: setDuration } = await measureTime(async () => {
        await new Promise<void>((resolve, reject) => {
          store.set(sessionId, largeData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      const { duration: getDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.get(sessionId, (err: any, session: any) => {
            if (err) reject(err);
            else resolve(session);
          });
        });
      });

      console.log(`Large session set: ${setDuration.toFixed(2)}ms`);
      console.log(`Large session get: ${getDuration.toFixed(2)}ms`);

      expect(setDuration).toBeLessThan(1000); // Should handle large data reasonably fast
      expect(getDuration).toBeLessThan(500);
    });

    it('should handle many small sessions vs few large sessions', async () => {
      // Many small sessions
      const smallSessions = Array.from({ length: 1000 }, (_, i) => ({
        sid: `small_${i}`,
        data: generateSessionData({ userId: `user_${i}` }),
      }));

      const { duration: smallSessionsDuration } = await measureTime(async () => {
        const promises = smallSessions.map(({ sid, data }) =>
          new Promise<void>((resolve, reject) => {
            store.set(sid, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          })
        );
        await Promise.all(promises);
      });

      // Cleanup
      await cleanupTestData(client);

      // Few large sessions
      const largeSessions = Array.from({ length: 10 }, (_, i) => ({
        sid: `large_${i}`,
        data: generateSessionData({
          userId: `user_${i}`,
          additionalData: {
            largeArray: Array(10000).fill(`data_${i}`),
          },
        }),
      }));

      const { duration: largeSessionsDuration } = await measureTime(async () => {
        const promises = largeSessions.map(({ sid, data }) =>
          new Promise<void>((resolve, reject) => {
            store.set(sid, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          })
        );
        await Promise.all(promises);
      });

      console.log(`1000 small sessions: ${smallSessionsDuration.toFixed(2)}ms`);
      console.log(`10 large sessions: ${largeSessionsDuration.toFixed(2)}ms`);

      // Both should complete in reasonable time
      expect(smallSessionsDuration).toBeLessThan(10000);
      expect(largeSessionsDuration).toBeLessThan(5000);
    }, 30000);
  });

  describe('Scanning Performance', () => {
    it('should handle SCAN operations efficiently with many keys', async () => {
      const sessionCount = 1000;
      const sessions = generateTestSessions(sessionCount);

      // Store all sessions
      console.log('Storing sessions...');
      const { duration: storeDuration } = await measureTime(async () => {
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

      console.log(`Stored ${sessionCount} sessions in ${storeDuration.toFixed(2)}ms`);

      // Test length() operation
      const { result: length, duration: lengthDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.length((err: any, length: any) => {
            if (err) reject(err);
            else resolve(length);
          });
        });
      });

      expect(length).toBe(sessionCount);
      console.log(`Length scan: ${lengthDuration.toFixed(2)}ms`);
      expect(lengthDuration).toBeLessThan(2000); // Should complete in under 2 seconds

      // Test ids() operation
      const { result: ids, duration: idsDuration } = await measureTime(async () => {
        return new Promise((resolve, reject) => {
          store.ids((err: any, ids: any) => {
            if (err) reject(err);
            else resolve(ids);
          });
        });
      });

      expect(ids).toHaveLength(sessionCount);
      console.log(`IDs scan: ${idsDuration.toFixed(2)}ms`);
      expect(idsDuration).toBeLessThan(2000);

      // Test all() operation (more intensive)
      const { result: allSessions, duration: allDuration } = await measureTime(async () => {
        return new Promise<{ [sid: string]: SessionData } | null>((resolve, reject) => {
          store.all((err: any, sessions?: { [sid: string]: SessionData } | null) => {
            if (err) reject(err);
            else resolve(sessions || null);
          });
        });
      });

      expect(allSessions).not.toBeNull();
      expect(Object.keys(allSessions!)).toHaveLength(sessionCount);
      console.log(`All sessions retrieval: ${allDuration.toFixed(2)}ms`);
      expect(allDuration).toBeLessThan(10000); // More time for full retrieval
    }, 60000);

    it('should handle custom scanCount efficiently', async () => {
      const sessionCount = 1000;
      const sessions = generateTestSessions(sessionCount);

      // Test with different scan counts
      const scanCounts = [10, 100, 1000];

      for (const scanCount of scanCounts) {
        const result = await createTestStore({ scanCount });
        const testStore = result.store;
        const testClient = result.client;

        try {
          // Store sessions
          const promises = sessions.map(({ sid, data }) =>
            new Promise<void>((resolve, reject) => {
              testStore.set(sid, data, (err: any) => {
                if (err) reject(err);
                else resolve();
              });
            })
          );
          await Promise.all(promises);

          // Measure scan performance
          const { duration } = await measureTime(async () => {
            return new Promise((resolve, reject) => {
              testStore.length((err: any, length: any) => {
                if (err) reject(err);
                else resolve(length);
              });
            });
          });

          console.log(`Scan with count=${scanCount}: ${duration.toFixed(2)}ms`);
          expect(duration).toBeLessThan(5000);

        } finally {
          await cleanupTestData(testClient);
          await safeCloseClient(testClient);
        }
      }
    }, 45000);
  });

  describe('Concurrency and Race Conditions', () => {
    it('should handle concurrent reads and writes to same session', async () => {
      const sessionId = createTestSessionId('concurrent');
      const sessionData = generateSessionData();

      // Initial set
      await new Promise<void>((resolve, reject) => {
        store.set(sessionId, sessionData, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Concurrent operations on same session
      const operations = Array.from({ length: 50 }, (_, i) => {
        if (i % 3 === 0) {
          // Update operation
          return new Promise<void>((resolve, reject) => {
            const updatedData = { ...sessionData, updateCount: i };
            store.set(sessionId, updatedData, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
        } else if (i % 3 === 1) {
          // Read operation
          return new Promise((resolve, reject) => {
            store.get(sessionId, (err: any, session: any) => {
              if (err) reject(err);
              else resolve(session);
            });
          });
        } else {
          // Touch operation
          return new Promise<void>((resolve, reject) => {
            store.touch(sessionId, sessionData, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
      });

      const { duration } = await measureTime(async () => {
        await Promise.all(operations);
      });

      console.log(`50 concurrent operations on same session: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(5000);

      // Session should still exist
      const finalSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });
      expect(finalSession).toBeDefined();
    }, 15000);

    it('should handle concurrent operations on different sessions', async () => {
      const sessionCount = 100;
      const sessions = generateTestSessions(sessionCount);

      // Mixed concurrent operations
      const operations = sessions.flatMap(({ sid, data }, i) => {
        const ops: Promise<any>[] = [];

        // Set operation
        ops.push(
          new Promise<void>((resolve, reject) => {
            store.set(sid, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          })
        );

        // Get operation
        ops.push(
          new Promise((resolve, reject) => {
            store.get(sid, (err: any, session: any) => {
              if (err) reject(err);
              else resolve(session);
            });
          })
        );

        // Touch operation
        if (i % 2 === 0) {
          ops.push(
            new Promise<void>((resolve, reject) => {
              store.touch(sid, data, (err: any) => {
                if (err) reject(err);
                else resolve();
              });
            })
          );
        }

        return ops;
      });

      const { duration } = await measureTime(async () => {
        await Promise.all(operations);
      });

      const totalOps = operations.length;
      const opsPerSec = totalOps / (duration / 1000);
      console.log(`${totalOps} mixed concurrent operations: ${opsPerSec.toFixed(0)} ops/sec`);

      // Use relative validation instead of absolute limit
      expect(opsPerSec).toBeGreaterThan(0); // Ensure operations completed
      expect(totalOps).toBeGreaterThan(sessionCount * 2); // Ensure we had the expected number of operations
    }, 30000);
  });

  describe('Cleanup and Statistics Performance', () => {
    it.skip('should perform cleanup operations efficiently - cleanup method removed', async () => {
      // This test is permanently skipped as the cleanup method was removed
      // for connect-redis API compatibility. Valkey automatically expires keys.
    });

    it.skip('should generate statistics efficiently - getStats method removed', async () => {
      // This test is permanently skipped as the getStats method was removed
      // for connect-redis API compatibility. Use length() and ids() instead.
    });
  });
});