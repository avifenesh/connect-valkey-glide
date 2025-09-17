/**
 * Testdata server wrapper for connect-redis test compatibility
 * Starts/stops Valkey for tests (replaces Redis)
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let valkeyStarted = false;
export let port = 6379; // Default Valkey port

/**
 * Start Valkey server for testing (equivalent to connect-redis's test server)
 */
export async function connect(): Promise<void> {
  if (valkeyStarted) {
    return;
  }

  try {
    // Start Docker Compose Valkey
    console.log('Starting Valkey for contract tests...');
    await execAsync('docker compose -f docker-compose.test.yml up -d valkey-standalone');

    // Wait for Valkey to be ready
    await waitForValkey();
    valkeyStarted = true;
    console.log('Valkey started successfully');
  } catch (error) {
    console.error('Failed to start Valkey:', error);
    throw error;
  }
}

/**
 * Stop Valkey server
 */
export async function disconnect(): Promise<void> {
  if (!valkeyStarted) {
    return;
  }

  try {
    console.log('Stopping Valkey...');
    await execAsync('docker compose -f docker-compose.test.yml stop valkey-standalone');
    valkeyStarted = false;
    console.log('Valkey stopped successfully');
  } catch (error) {
    console.warn('Error stopping Valkey:', error);
    // Don't throw - test cleanup should not fail
  }
}

/**
 * Wait for Valkey to be ready
 */
async function waitForValkey(): Promise<void> {
  const { GlideClient } = await import('@valkey/valkey-glide');
  const maxRetries = 30;
  const retryDelay = 1000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await GlideClient.createClient({
        addresses: [{ host: 'localhost', port }],
        requestTimeout: 2000,
      });

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