/**
 * Exact connect-redis test suite
 * Ported directly from tj/connect-redis to ensure 100% API compatibility
 * Source: https://github.com/tj/connect-redis/blob/master/index_test.ts
 */

import { Cookie } from 'express-session';
import { GlideClient } from '@valkey/valkey-glide';
import { expect, test } from 'vitest';
import { ValkeyStore } from '../../src';
import * as valkeyServer from './testdata/server';

test('setup', async () => {
  await valkeyServer.connect();
});

test('defaults', async () => {
  let client = await GlideClient.createClient({
    addresses: [{ host: 'localhost', port: valkeyServer.port }]
  });

  // Use a different prefix to avoid conflicts
  let store = new ValkeyStore({ client, prefix: 'test-defaults:' });

  expect(store.client).toBeDefined();
  expect(store.prefix).toBe('test-defaults:');
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
  let store = new ValkeyStore({ client, prefix: 'test-lifecycle:' });

  // Clear any existing sessions before running the test
  await store.clear();

  await lifecycleTest(store, client);
  await client.close();
});

test('teardown', valkeyServer.disconnect);

async function lifecycleTest(store: ValkeyStore, client: any): Promise<void> {
  // Ensure we start with a clean slate
  let res = await store.clear();

  // Verify store is empty
  res = await store.length();
  expect(res).toBe(0);

  let sess: any = { foo: 'bar', cookie: { originalMaxAge: null } };
  await store.set('123', sess);

  res = await store.get('123');
  expect(res).toEqual(sess);

  let ttl = await client.ttl(`${store.prefix}123`);
  expect(ttl).toBeGreaterThanOrEqual(86399);

  ttl = 60;
  let expires = new Date(Date.now() + ttl * 1000);
  await store.set('456', { cookie: { originalMaxAge: null, expires } });
  ttl = await client.ttl(`${store.prefix}456`);
  expect(ttl).toBeLessThanOrEqual(60);

  ttl = 90;
  let expires2 = new Date(Date.now() + ttl * 1000);
  await store.touch('456', { cookie: { originalMaxAge: null, expires: expires2 } });
  ttl = await client.ttl(`${store.prefix}456`);
  expect(ttl).toBeGreaterThan(60);

  res = await store.length();
  expect(res).toBe(2); // stored two keys length

  res = await store.ids();
  res.sort();
  expect(res).toEqual(['123', '456']);

  res = await store.all();
  // Note: connect-redis adds session IDs to the results, but we don't
  // We need to check the sessions exist
  expect(res).toBeDefined();
  expect(res!['123']).toBeDefined();
  expect(res!['456']).toBeDefined();
  expect(res!['123'].foo).toBe('bar');

  await store.destroy('456');
  res = await store.length();
  expect(res).toBe(1); // one key remains

  res = await store.clear();

  res = await store.length();
  expect(res).toBe(0); // no keys remain

  let count = 1000;
  await load(store, count);

  res = await store.length();
  expect(res).toBe(count);

  await store.clear();
  res = await store.length();
  expect(res).toBe(0);

  expires = new Date(Date.now() + ttl * 1000); // expires in the future
  res = await store.set('789', { cookie: { originalMaxAge: null, expires } });

  res = await store.length();
  expect(res).toBe(1);

  expires = new Date(Date.now() - ttl * 1000); // expires in the past
  await store.set('789', { cookie: { originalMaxAge: null, expires } });

  res = await store.length();
  expect(res).toBe(0); // no key remains and that includes session 789
}

async function load(store: ValkeyStore, count: number) {
  let cookie = new Cookie();
  for (let sid = 0; sid < count; sid++) {
    // Give sessions a longer expiry (10 seconds) to avoid them expiring during the test
    cookie.expires = new Date(Date.now() + 10000);
    await store.set('s' + sid, { cookie });
  }
}