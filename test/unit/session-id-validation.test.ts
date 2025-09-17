/**
 * Unit tests for session ID validation
 */

import { ValkeyStore } from '../../src';
import { GlideClient } from '@valkey/valkey-glide';

// Mock client for testing
const mockClient = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
} as any;

describe('Session ID Validation', () => {
  let store: ValkeyStore;

  beforeEach(() => {
    store = new ValkeyStore({ client: mockClient });
  });

  describe('Valid Session IDs', () => {
    it('should accept normal string session IDs', async () => {
      mockClient.get.mockResolvedValue(null);

      expect(async () => {
        await store.get('valid-session-id-123');
      }).not.toThrow();

      expect(async () => {
        await store.get('session_with_underscores');
      }).not.toThrow();

      expect(async () => {
        await store.get('session-with-dashes');
      }).not.toThrow();
    });

    it('should accept numeric session IDs', async () => {
      mockClient.get.mockResolvedValue(null);

      expect(async () => {
        await store.get(123);
      }).not.toThrow();

      expect(async () => {
        await store.get(0);
      }).not.toThrow();

      expect(async () => {
        await store.get(999999);
      }).not.toThrow();
    });

    it('should accept session IDs with allowed special characters', async () => {
      mockClient.get.mockResolvedValue(null);

      expect(async () => {
        await store.get('session.with.dots');
      }).not.toThrow();

      expect(async () => {
        await store.get('session:with:colons');
      }).not.toThrow();
    });
  });

  describe('Invalid Session IDs', () => {
    it('should reject empty or invalid session IDs', async () => {
      await expect(store.get('')).rejects.toThrow('Session ID must be a non-empty value');
      await expect(store.get(null as any)).rejects.toThrow('Session ID must be a non-empty value');
      await expect(store.get(undefined as any)).rejects.toThrow('Session ID must be a non-empty value');
    });

    it('should reject session IDs with control characters', async () => {
      await expect(store.get('session\0id')).rejects.toThrow('Invalid session ID format: contains control characters');
      await expect(store.get('session\nid')).rejects.toThrow('Invalid session ID format: contains control characters');
      await expect(store.get('session\rid')).rejects.toThrow('Invalid session ID format: contains control characters');
    });

    it('should reject session IDs that are too long', async () => {
      const longSessionId = 'a'.repeat(256);
      await expect(store.get(longSessionId)).rejects.toThrow('Session ID too long: maximum 255 characters allowed');
    });

    it('should accept session IDs at the length limit', async () => {
      mockClient.get.mockResolvedValue(null);
      const maxLengthSessionId = 'a'.repeat(255);

      expect(async () => {
        await store.get(maxLengthSessionId);
      }).not.toThrow();
    });
  });

  describe('TTL Calculation', () => {
    it('should handle TTL calculation consistently', () => {
      const sessionData = {
        cookie: {
          expires: new Date(Date.now() + 10000) // 10 seconds from now
        }
      };

      // Access private method for testing
      const getTTL = (store as any).getTTL.bind(store);

      const ttl1 = getTTL(sessionData);
      const ttl2 = getTTL(sessionData);

      // TTL should be consistent (within 1 second tolerance for timing)
      expect(Math.abs(ttl1 - ttl2)).toBeLessThanOrEqual(1);
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl2).toBeGreaterThan(0);
    });

    it('should return non-negative TTL values', () => {
      const expiredSessionData = {
        cookie: {
          expires: new Date(Date.now() - 10000) // 10 seconds ago (expired)
        }
      };

      const getTTL = (store as any).getTTL.bind(store);
      const ttl = getTTL(expiredSessionData);

      expect(ttl).toBe(0); // Should be 0, not negative
    });
  });
});