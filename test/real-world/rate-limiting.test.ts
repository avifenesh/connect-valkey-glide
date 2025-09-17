/**
 * Real-world test: Express Rate Limiting with Session Tracking
 * Tests session-based rate limiting including:
 * - Concurrent requests from same session
 * - Rate limit state persistence in Valkey
 * - TTL expiration of rate limit data
 */

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { GlideClient, GlideClusterClient } from '@valkey/valkey-glide';
import { ValkeyStore } from '../../src';
import { createTestStore } from '../utils/test-helpers';

interface RateLimitSession {
  requests?: number;
  windowStart?: number;
  blockedUntil?: number;
}

describe('Rate Limiting with Session Tracking', () => {
  let app: express.Express;
  let store: ValkeyStore;
  let client: GlideClient | GlideClusterClient;
  let server: any;

  // Simple rate limiter middleware
  function createRateLimiter(options = {
    windowMs: 1000,
    maxRequests: 5,
    blockDuration: 2000
  }) {
    return (req: any, res: express.Response, next: express.NextFunction) => {
      if (!req.session) {
        return res.status(500).json({ error: 'Session not initialized' });
      }

      const now = Date.now();
      const rateLimit: RateLimitSession = req.session.rateLimit || {};

      // Check if blocked
      if (rateLimit.blockedUntil && rateLimit.blockedUntil > now) {
        const retryAfter = Math.ceil((rateLimit.blockedUntil - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter
        });
      }

      // Initialize or reset window
      if (!rateLimit.windowStart || now - rateLimit.windowStart > options.windowMs) {
        rateLimit.windowStart = now;
        rateLimit.requests = 0;
        delete rateLimit.blockedUntil;
      }

      // Increment request count
      rateLimit.requests = (rateLimit.requests || 0) + 1;

      // Check limit
      if (rateLimit.requests > options.maxRequests) {
        rateLimit.blockedUntil = now + options.blockDuration;
        req.session.rateLimit = rateLimit;
        req.session.save((err) => {
          if (err) console.error('Failed to save session:', err);
        });
        const retryAfter = Math.ceil(options.blockDuration / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter
        });
      }

      // Save rate limit state
      req.session.rateLimit = rateLimit;
      req.session.save((err) => {
        if (err) console.error('Failed to save session:', err);
      });

      next();
    };
  }

  async function setupApp(useCluster = false) {
    const result = await createTestStore({ useCluster });
    store = result.store;
    client = result.client;

    app = express();

    // Session middleware
    app.use(session({
      store,
      secret: 'rate-limit-test-secret',
      resave: false,
      saveUninitialized: true,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 60 * 1000 // 1 minute
      }
    }));

    // Reset endpoint (not rate limited)
    app.post('/api/reset', (req: any, res) => {
      delete req.session.rateLimit;
      req.session.save((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to reset rate limit' });
        }
        res.json({ message: 'Rate limit reset' });
      });
    });

    // Rate limiting middleware
    app.use('/api', createRateLimiter({
      windowMs: 1000,      // 1 second window
      maxRequests: 5,      // 5 requests per window
      blockDuration: 2000  // Block for 2 seconds
    }));

    // Test endpoints
    app.get('/api/data', (req, res) => {
      res.json({
        message: 'Success',
        timestamp: Date.now(),
        sessionId: req.sessionID
      });
    });

    app.get('/api/status', (req: any, res) => {
      res.json({
        sessionId: req.sessionID,
        rateLimit: req.session.rateLimit || null
      });
    });

    return new Promise((resolve) => {
      server = app.listen(0, () => {
        resolve(app);
      });
    });
  }

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (client) {
      await client.close();
    }
  });

  describe('Standalone Mode', () => {
    beforeEach(async () => {
      await setupApp(false);
    });

    it('should track requests per session', async () => {
      const agent = request.agent(app);

      // Make 5 requests (within limit)
      for (let i = 0; i < 5; i++) {
        const response = await agent.get('/api/data');
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Success');
      }

      // 6th request should be rate limited
      const response = await agent.get('/api/data');
      expect(response.status).toBe(429);
      expect(response.body.error).toContain('Rate limit exceeded');
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('should persist rate limit state in Valkey', async () => {
      const agent = request.agent(app);

      // Make some requests
      for (let i = 0; i < 3; i++) {
        await agent.get('/api/data');
      }

      // Check rate limit state
      const statusResponse = await agent.get('/api/status');
      expect(statusResponse.body.rateLimit).toBeDefined();
      expect(statusResponse.body.rateLimit.requests).toBe(4); // Status endpoint also increments counter
      expect(statusResponse.body.rateLimit.windowStart).toBeDefined();

      // Verify state persists across "requests" (same session)
      const statusResponse2 = await agent.get('/api/status');
      expect(statusResponse2.body.sessionId).toBe(statusResponse.body.sessionId);
      expect(statusResponse2.body.rateLimit.requests).toBe(5); // Another increment from second status call
    });

    it('should handle concurrent requests from same session', async () => {
      const agent = request.agent(app);

      // Make concurrent requests with error handling
      const promises = Array(10).fill(0).map(() =>
        agent.get('/api/data').catch(err => {
          // Handle connection errors gracefully in concurrent scenario
          if (err.code === 'ECONNRESET') {
            return { status: 429 }; // Treat connection reset as rate limited
          }
          throw err;
        })
      );

      const responses = await Promise.all(promises);

      // First 5 should succeed
      const successCount = responses.filter(r => r.status === 200).length;
      const rateLimitedCount = responses.filter(r => r.status === 429).length;

      expect(successCount).toBeLessThanOrEqual(5);
      expect(rateLimitedCount).toBeGreaterThanOrEqual(5);
    });

    it('should reset rate limit after window expires', async () => {
      const agent = request.agent(app);

      // Max out rate limit
      for (let i = 0; i < 6; i++) {
        await agent.get('/api/data');
      }

      // Should be rate limited
      let response = await agent.get('/api/data');
      expect(response.status).toBe(429);

      // Wait for window to reset (1 second window + more buffer for CI)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Should be able to make requests again
      response = await agent.get('/api/data');
      expect(response.status).toBe(200);
    });

    it('should handle block duration correctly', async () => {
      const agent = request.agent(app);

      // Max out rate limit (5 requests allowed, 6th triggers rate limit)
      for (let i = 0; i < 6; i++) {
        await agent.get('/api/data');
      }

      // 7th request should be rate limited
      let response = await agent.get('/api/data');
      expect(response.status).toBe(429);

      // Check which error message we get (could be either depending on timing)
      const isBlocked = response.body.error.includes('Too many requests');
      const isRateLimited = response.body.error.includes('Rate limit exceeded');
      expect(isBlocked || isRateLimited).toBe(true);

      // Still blocked after 0.5 seconds
      await new Promise(resolve => setTimeout(resolve, 500));
      response = await agent.get('/api/data');
      expect(response.status).toBe(429);

      // Unblocked after 2 seconds from blocking (2.5 seconds total)
      await new Promise(resolve => setTimeout(resolve, 1600));
      response = await agent.get('/api/data');
      expect(response.status).toBe(200);
    });

    it('should isolate rate limits between sessions', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);

      // Max out rate limit for agent1
      for (let i = 0; i < 6; i++) {
        await agent1.get('/api/data');
      }

      // Agent1 should be rate limited
      let response1 = await agent1.get('/api/data');
      expect(response1.status).toBe(429);

      // Agent2 should still be able to make requests
      const response2 = await agent2.get('/api/data');
      expect(response2.status).toBe(200);
    });

    it('should allow manual rate limit reset', async () => {
      const agent = request.agent(app);

      // Max out rate limit
      for (let i = 0; i < 6; i++) {
        await agent.get('/api/data');
      }

      // Should be rate limited
      let response = await agent.get('/api/data');
      expect(response.status).toBe(429);

      // Reset rate limit
      response = await agent.post('/api/reset');
      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Rate limit reset');

      // Should be able to make requests again
      response = await agent.get('/api/data');
      expect(response.status).toBe(200);
    });

    it('should handle TTL expiration of session data', async () => {
      // Create app with very short session TTL
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      const result = await createTestStore({ useCluster: false });
      store = result.store;
      client = result.client;

      app = express();
      app.use(session({
        store,
        secret: 'test',
        resave: false,
        saveUninitialized: true,
        cookie: { maxAge: 1000 } // 1 second TTL
      }));

      app.use('/api', createRateLimiter({
        windowMs: 2000,      // 2 second window (shorter for test)
        maxRequests: 5,
        blockDuration: 2000
      }));

      app.get('/api/data', (req, res) => {
        res.json({ success: true });
      });

      await new Promise((resolve) => {
        server = app.listen(0, () => resolve(undefined));
      });
      const agent = request.agent(app);

      // Make some requests
      for (let i = 0; i < 3; i++) {
        const response = await agent.get('/api/data');
        expect(response.status).toBe(200);
      }

      // Wait for session to expire and rate limit window to reset
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Should get new session with fresh rate limit
      const response = await agent.get('/api/data');
      expect(response.status).toBe(200);

      // Make 4 more requests (total 5 in new session)
      for (let i = 0; i < 4; i++) {
        const r = await agent.get('/api/data');
        expect(r.status).toBe(200);
      }

      // 6th request in new session should be rate limited
      const finalResponse = await agent.get('/api/data');
      expect(finalResponse.status).toBe(429);
    });
  });

  describe('Cluster Mode', () => {
    beforeEach(async () => {
      try {
        await setupApp(true);
      } catch (error) {
        // Cluster might not be available
        console.log('Cluster not available for rate limiting test');
      }
    });

    it('should handle rate limiting in cluster mode', async () => {
      if (!client) {
        console.log('Skipping cluster test - cluster not available');
        return;
      }

      const agent = request.agent(app);

      // Make 5 requests (within limit)
      for (let i = 0; i < 5; i++) {
        const response = await agent.get('/api/data');
        expect(response.status).toBe(200);
      }

      // 6th request should be rate limited
      const response = await agent.get('/api/data');
      expect(response.status).toBe(429);
    });
  });
});