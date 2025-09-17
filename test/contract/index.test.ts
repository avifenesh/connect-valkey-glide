/**
 * Connect-Redis compatibility test suite
 * Ported from tj/connect-redis to ensure 100% API compatibility
 */

import { Cookie, SessionData } from 'express-session';
import { GlideClient } from '@valkey/valkey-glide';
import { expect, test } from 'vitest';
import { ValkeyStore } from '../../src';
import * as valkeyServer from './testdata/server';

// Test-specific session data interface
interface TestSessionData extends SessionData {
  userId?: string;
  data?: string;
  nested?: {
    array: number[];
    object: { key: string };
    date: string;
  };
}

test('setup', async () => {
  await valkeyServer.connect();
});

test('defaults', async () => {
  let client = await GlideClient.createClient({
    addresses: [{ host: 'localhost', port: valkeyServer.port }]
  });

  let store = new ValkeyStore({ client });

  expect(store.client).toBeDefined();
  expect(store.prefix).toBe('sess:');
  expect(store.ttl).toBe(86400); // defaults to one day
  expect(store.scanCount).toBe(100);
  expect(store.serializer).toBe(JSON);
  expect(store.disableTouch).toBe(false);
  expect(store.disableTTL).toBe(false);

  await client.close();
});

test('valkey', async () => {
  let client = await GlideClient.createClient({
    addresses: [{ host: 'localhost', port: valkeyServer.port }]
  });
  // Use a unique prefix for this test
  let store = new ValkeyStore({ client, prefix: 'test-orig:' });

  // Clear any existing sessions before running the test
  await store.clear();

  await lifecycleTest(store, client);
  await client.close();
});

test('teardown', valkeyServer.disconnect);

async function lifecycleTest(store: ValkeyStore, client: any): Promise<void> {
  // Test basic operations
  await testBasicOperations(store);

  // Test TTL functionality
  await testTTL(store);

  // Test bulk operations
  await testBulkOperations(store);

  // Test serialization
  await testSerialization(store);

  // Load test
  await load(store, 100);
}

async function testBasicOperations(store: ValkeyStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const testSid = 'test-basic-ops';
    const cookie = new Cookie();
    const sessionData: TestSessionData = { cookie, userId: 'test-user', data: 'test-data' };

    // Test SET
    store.set(testSid, sessionData, (err) => {
      if (err) return reject(err);

      // Test GET
      store.get(testSid, (err, session) => {
        if (err) return reject(err);
        expect(session).toBeDefined();
        const typedSession = session as TestSessionData;
        expect(typedSession.userId).toBe('test-user');

        // Test TOUCH
        store.touch(testSid, sessionData, (err) => {
          if (err) return reject(err);

          // Test DESTROY
          store.destroy(testSid, (err) => {
            if (err) return reject(err);

            // Verify destroyed
            store.get(testSid, (err, session) => {
              if (err) return reject(err);
              expect(session).toBeNull();
              resolve();
            });
          });
        });
      });
    });
  });
}

async function testTTL(store: ValkeyStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const testSid = 'test-ttl';
    const cookie = new Cookie();
    cookie.maxAge = 1000; // 1 second
    const sessionData = { cookie, userId: 'test-ttl-user' };

    store.set(testSid, sessionData, (err) => {
      if (err) return reject(err);

      // Should exist immediately
      store.get(testSid, (err, session) => {
        if (err) return reject(err);
        expect(session).toBeDefined();
        resolve();
      });
    });
  });
}

async function testBulkOperations(store: ValkeyStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sessions = [
      { sid: 'bulk1', data: { cookie: new Cookie(), userId: 'user1' } },
      { sid: 'bulk2', data: { cookie: new Cookie(), userId: 'user2' } },
      { sid: 'bulk3', data: { cookie: new Cookie(), userId: 'user3' } }
    ];

    // Store sessions
    let pending = sessions.length;
    sessions.forEach(({ sid, data }) => {
      store.set(sid, data, (err) => {
        if (err) return reject(err);
        if (--pending === 0) {
          // Test LENGTH
          store.length((err, length) => {
            if (err) return reject(err);
            expect(length).toBeGreaterThanOrEqual(3);

            // Test IDS
            store.ids((err, ids) => {
              if (err) return reject(err);
              expect(ids).toContain('bulk1');
              expect(ids).toContain('bulk2');
              expect(ids).toContain('bulk3');

              // Test ALL
              store.all((err, allSessions) => {
                if (err) return reject(err);
                expect(allSessions).toBeDefined();
                expect(allSessions!.bulk1).toBeDefined();
                expect(allSessions!.bulk2).toBeDefined();
                expect(allSessions!.bulk3).toBeDefined();

                // Test CLEAR
                store.clear((err) => {
                  if (err) return reject(err);

                  store.length((err, length) => {
                    if (err) return reject(err);
                    expect(length).toBe(0);
                    resolve();
                  });
                });
              });
            });
          });
        }
      });
    });
  });
}

async function testSerialization(store: ValkeyStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const testSid = 'test-serialization';
    const complexData: TestSessionData = {
      cookie: new Cookie(),
      nested: {
        array: [1, 2, 3],
        object: { key: 'value' },
        date: new Date().toISOString()
      }
    };

    store.set(testSid, complexData, (err) => {
      if (err) return reject(err);

      store.get(testSid, (err, session) => {
        if (err) return reject(err);
        expect(session).toBeDefined();
        const typedSession = session as TestSessionData;
        expect(typedSession.nested?.array).toEqual([1, 2, 3]);
        expect(typedSession.nested?.object.key).toBe('value');

        store.destroy(testSid, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  });
}

async function load(store: ValkeyStore, count: number) {
  let cookie = new Cookie();
  for (let sid = 0; sid < count; sid++) {
    cookie.expires = new Date(Date.now() + 2000); // 2 seconds to avoid race condition
    await new Promise<void>((resolve, reject) => {
      store.set('s' + sid, { cookie }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Verify all sessions were stored
  await new Promise<void>((resolve, reject) => {
    store.length((err, length) => {
      if (err) reject(err);
      else {
        expect(length).toBeGreaterThanOrEqual(count);
        resolve();
      }
    });
  });

  // Clean up
  await new Promise<void>((resolve, reject) => {
    store.clear((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}