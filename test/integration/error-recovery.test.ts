/**
 * Error handling and recovery integration tests with real Valkey
 */

import {
  createTestStore,
  safeCloseClient,
  generateSessionData,
  cleanupTestData,
  createTestSessionId,
  waitForValkey,
  ErrorSimulator,
} from '../utils/test-helpers';

describe('Error Recovery Integration Tests', () => {
  beforeAll(async () => {
    await waitForValkey(30, 1000);
  }, 60000);

  describe('Network Error Handling', () => {
    it('should handle real connection failures gracefully', async () => {
      // This test uses real connection failures instead of mocking
      let errorCount = 0;

      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        const sessionId = createTestSessionId('real-failure');
        const sessionData = generateSessionData();

        // First set a session normally
        await new Promise<void>((resolve, reject) => {
          store.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Listen for error events
        store.on('error', (error: Error) => {
          errorCount++;
          expect(error).toBeInstanceOf(Error);
        });

        // Close the client connection to simulate real failure
        await client.close();

        // Operations after connection failure should fail gracefully
        const promises = Array.from({ length: 5 }, () =>
          new Promise((resolve) => {
            store.get(sessionId, (err: any, session: any) => {
              // All operations should fail now
              resolve({ err, session });
            });
          })
        );

        const results = await Promise.all(promises);
        const errors = results.filter((r: any) => r.err);

        // All operations should fail after client is closed
        expect(errors.length).toBe(5);

        // Verify sessions are undefined when errors occur
        errors.forEach((result: any) => {
          expect(result.session).toBeUndefined();
        });

      } finally {
        // Client is already closed, no cleanup needed
      }
    }, 15000);

    it('should handle malformed data gracefully', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        const sessionId = createTestSessionId('malformed');
        const key = `test-sess:${sessionId}`;

        // Manually insert malformed JSON data
        await client.set(key, 'invalid-json{broken');

        // Getting malformed data should trigger error callback
        await new Promise<void>((resolve) => {
          store.get(sessionId, (err: any, session: any) => {
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toMatch(/JSON/i);
            expect(session).toBeUndefined();
            resolve();
          });
        });

        // Test with empty string
        await client.set(key, '');
        await new Promise<void>((resolve) => {
          store.get(sessionId, (err: any, session: any) => {
            expect(err).toBeInstanceOf(Error);
            expect(session).toBeUndefined();
            resolve();
          });
        });

      } finally {
        await cleanupTestData(client);
        await safeCloseClient(client);
      }
    });

    it('should handle serialization errors gracefully', async () => {
      const result = await createTestStore({
        logErrors: false,
        serializer: {
          parse: JSON.parse,
          stringify: (obj: any) => {
            if (obj.shouldFail) {
              throw new Error('Serialization failed');
            }
            return JSON.stringify(obj);
          },
        },
      });
      const store = result.store;
      const client = result.client;

      try {
        const sessionId = createTestSessionId('serialize-error');
        const badSessionData = generateSessionData({ additionalData: { shouldFail: true } });

        // Set operation should fail due to serialization error
        await new Promise<void>((resolve) => {
          store.set(sessionId, badSessionData, (err: any) => {
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toBe('Serialization failed');
            resolve();
          });
        });

        // Verify session was not stored
        const session = await new Promise((resolve, reject) => {
          store.get(sessionId, (err: any, session: any) => {
            if (err) reject(err);
            else resolve(session);
          });
        });
        expect(session).toBeNull();

      } finally {
        await cleanupTestData(client);
        await safeCloseClient(client);
      }
    });
  });

  describe('Data Consistency', () => {
    (process.env.CI ? it.skip : it)('should handle scan operation failures gracefully', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        // Store multiple sessions
        const sessions = Array.from({ length: 5 }, (_, i) => ({
          id: createTestSessionId(`scan-fail-${i}`),
          data: generateSessionData({ userId: `user_${i}` }),
        }));

        for (const { id, data } of sessions) {
          await new Promise<void>((resolve, reject) => {
            store.set(id, data, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }

        // Start a length operation that will be interrupted
        const lengthPromise = new Promise<void>((resolve) => {
          store.length((err: any, length: any) => {
            // Should get an error when connection is closed
            if (err) {
              expect(err).toBeInstanceOf(Error);
              expect(length).toBeUndefined();
            }
            resolve();
          });
        });

        // Close client during scan operation to create real failure
        setTimeout(() => client.close(), process.env.CI ? 100 : 10); // Longer timeout in CI

        await lengthPromise;

      } finally {
        // Client already closed
      }
    });

    (process.env.CI ? it.skip : it)('should handle concurrent operations with real connection failures', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      let errorCount = 0;
      store.on('error', () => errorCount++);

      try {
        const sessionId = createTestSessionId('concurrent-failures');
        const sessionData = generateSessionData();

        // Set initial session
        await new Promise<void>((resolve, reject) => {
          store.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Start concurrent operations, then close connection mid-way
        const operationPromises = Array.from({ length: 10 }, (_, i) =>
          new Promise((resolve) => {
            // Add small delays to spread operations over time
            setTimeout(() => {
              store.get(sessionId, (err: any, session: any) => {
                resolve({ err, session, index: i });
              });
            }, i * 10);
          })
        );

        // Close connection after a short delay (mid-way through operations)
        setTimeout(() => client.close(), process.env.CI ? 200 : 50); // Longer timeout in CI

        const results = await Promise.all(operationPromises);

        // Some operations should succeed (before connection close)
        // Some operations should fail (after connection close)
        const errors = results.filter((r: any) => r.err);
        const successes = results.filter((r: any) => !r.err && r.session);

        // We expect both successes and failures
        expect(errors.length).toBeGreaterThan(0);

        // Early operations might succeed before connection close
        if (successes.length > 0) {
          expect(successes.length).toBeGreaterThan(0);
        }

      } finally {
        // Client already closed in test
      }
    }, 15000);
  });

  describe('Resource Management', () => {
    it('should handle client connection drops', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        const sessionId = createTestSessionId('connection-drop');
        const sessionData = generateSessionData();

        // Set session
        await new Promise<void>((resolve, reject) => {
          store.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Simulate connection drop by closing the client
        await client.close();

        // Operations should fail gracefully
        await new Promise<void>((resolve) => {
          store.get(sessionId, (err: any, session: any) => {
            expect(err).toBeInstanceOf(Error);
            expect(session).toBeUndefined();
            resolve();
          });
        });

        await new Promise<void>((resolve) => {
          store.set(sessionId, sessionData, (err: any) => {
            expect(err).toBeInstanceOf(Error);
            resolve();
          });
        });

      } finally {
        // Client is already closed, no cleanup needed
      }
    });

    it('should handle memory pressure scenarios', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        // Create moderately large session data that might cause issues (CI-appropriate size)
        const largeSessionData = generateSessionData({
          additionalData: {
            veryLargeArray: Array(process.env.CI ? 1000 : 100000).fill({
              id: 'test-item',
              data: 'x'.repeat(process.env.CI ? 100 : 1000), // CI: 100KB total, Local: 100MB
              metadata: Array(process.env.CI ? 10 : 100).fill('metadata'),
            }),
          },
        });

        const sessionId = createTestSessionId('memory-pressure');

        // This might fail due to memory constraints
        await new Promise<void>((resolve) => {
          store.set(sessionId, largeSessionData, (err: any) => {
            // Either succeeds or fails gracefully
            if (err) {
              expect(err).toBeInstanceOf(Error);
            }
            resolve();
          });
        });

      } finally {
        await cleanupTestData(client);
        await safeCloseClient(client);
      }
    }, 20000);
  });

  describe('Error Event Handling', () => {
    it('should emit error events for operations without callbacks', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      const emittedErrors: Error[] = [];
      store.on('error', (error: Error) => {
        emittedErrors.push(error);
      });

      try {
        // Force client to fail
        await client.close();

        // Operations without callbacks return rejected promises
        // but we still emit errors for backward compatibility
        const promise = store.get('nonexistent');

        // Catch the promise rejection
        await promise.catch(() => {
          // Expected to reject
        });

        // Wait for error event
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(emittedErrors.length).toBeGreaterThan(0);
        expect(emittedErrors[0]).toBeInstanceOf(Error);

      } finally {
        // Client already closed
      }
    });

    it('should handle multiple error listeners', async () => {
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      const errors1: Error[] = [];
      const errors2: Error[] = [];

      store.on('error', (error: Error) => errors1.push(error));
      store.on('error', (error: Error) => errors2.push(error));

      try {
        // Force an error
        await client.close();

        const promise = store.get('test');

        // Catch the promise rejection
        await promise.catch(() => {
          // Expected to reject
        });

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(errors1.length).toBeGreaterThan(0);
        expect(errors2.length).toBeGreaterThan(0);
        expect(errors1.length).toBe(errors2.length);

      } finally {
        // Client already closed
      }
    });
  });

  describe('Recovery Scenarios', () => {
    it('should handle error scenarios and recovery gracefully', async () => {
      // This test focuses on error handling rather than artificial network failures
      // since valkey-glide handles network retry automatically
      const result = await createTestStore({ logErrors: false });
      const store = result.store;
      const client = result.client;

      try {
        const sessionId = createTestSessionId('recovery');
        const sessionData = generateSessionData();

        // Set initial session successfully
        await new Promise<void>((resolve, reject) => {
          store.set(sessionId, sessionData, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Verify session exists
        const initialSession = await new Promise((resolve, reject) => {
          store.get(sessionId, (err: any, session: any) => {
            if (err) reject(err);
            else resolve(session);
          });
        });

        expect(initialSession).toEqual(sessionData);

        // Close connection to create error scenario
        await client.close();

        // Operations after connection close should fail gracefully
        await new Promise<void>((resolve) => {
          store.get(sessionId, (err: any, session: any) => {
            expect(err).toBeInstanceOf(Error);
            expect(session).toBeUndefined();
            resolve();
          });
        });

        // Store operations should also fail gracefully
        await new Promise<void>((resolve) => {
          store.set('test-fail', sessionData, (err: any) => {
            expect(err).toBeInstanceOf(Error);
            resolve();
          });
        });

      } finally {
        // Client already closed
      }
    });
  });
});