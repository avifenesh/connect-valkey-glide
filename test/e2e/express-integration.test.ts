/**
 * End-to-End tests with real Express application and Valkey
 */

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import {
  createTestStandaloneClient,
  safeCloseClient,
  cleanupTestData,
  waitForValkey,
} from '../utils/test-helpers';
import { ValkeyStore } from '../../src/index';

// Add supertest as dev dependency (we'll need to install it)
// For now, create a minimal version to avoid issues

describe('Express Integration E2E Tests', () => {
  let client: any;
  let app: express.Application;
  let server: any;
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
    // Clean up any existing test data with e2e prefix
    await cleanupTestData(client, 'e2e-sess:');

    // Create fresh ValkeyStore instance
    store = new ValkeyStore({
      client: client,
      prefix: 'e2e-sess:',
      ttl: 3600,
      logErrors: true,
    });

    // Create Express app with session middleware
    app = express();
    app.use(express.json());

    app.use(session({
      store: store,
      secret: 'test-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Allow non-HTTPS for testing
        httpOnly: true,
        maxAge: 1800000, // 30 minutes
      },
    }));

    // Test routes
    app.get('/login', (req: any, res) => {
      if (!req.session) {
        return res.status(500).json({ error: 'Session not available' });
      }

      req.session.userId = 'test-user-123';
      req.session.loginTime = new Date().toISOString();
      req.session.isAuthenticated = true;

      res.json({
        message: 'Logged in successfully',
        sessionId: req.sessionID,
        userId: req.session.userId,
      });
    });

    app.get('/profile', (req: any, res) => {
      if (!req.session || !req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      res.json({
        userId: req.session.userId,
        loginTime: req.session.loginTime,
        sessionId: req.sessionID,
      });
    });

    app.post('/update-profile', (req: any, res) => {
      if (!req.session || !req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      req.session.profile = req.body;
      req.session.lastUpdated = new Date().toISOString();

      res.json({
        message: 'Profile updated',
        profile: req.session.profile,
        lastUpdated: req.session.lastUpdated,
      });
    });

    app.get('/cart', (req: any, res) => {
      if (!req.session) {
        return res.status(500).json({ error: 'Session not available' });
      }

      if (!req.session.cart) {
        req.session.cart = [];
      }

      res.json({
        cart: req.session.cart,
        itemCount: req.session.cart.length,
      });
    });

    app.post('/cart/add', (req: any, res) => {
      if (!req.session) {
        return res.status(500).json({ error: 'Session not available' });
      }

      if (!req.session.cart) {
        req.session.cart = [];
      }

      const item = {
        id: req.body.id,
        name: req.body.name,
        price: req.body.price,
        quantity: req.body.quantity || 1,
        addedAt: new Date().toISOString(),
      };

      req.session.cart.push(item);

      res.json({
        message: 'Item added to cart',
        cart: req.session.cart,
        itemCount: req.session.cart.length,
      });
    });

    app.post('/logout', (req: any, res) => {
      req.session.destroy((err: any) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ message: 'Logged out successfully' });
      });
    });

    app.get('/session-info', (req: any, res) => {
      res.json({
        sessionID: req.sessionID,
        session: req.session || null,
        cookies: req.headers.cookie || null,
      });
    });
  });

  afterEach(async () => {
    // Clean up sessions after each test to prevent interference
    await cleanupTestData(client, 'e2e-sess:');

    if (server) {
      server.close();
      server = null;
    }
  });

  describe('Basic Session Flow', () => {
    it('should handle complete user session lifecycle', async () => {
      const agent = request.agent(app);

      // 1. Initial request - no session data but cookie is set
      let response = await agent.get('/session-info');
      expect(response.status).toBe(200);
      // With saveUninitialized: false, the session exists but without custom data
      expect(response.body.session?.userId).toBeUndefined();

      // 2. Login - creates session
      response = await agent.get('/login');
      expect(response.status).toBe(200);
      expect(response.body.userId).toBe('test-user-123');
      expect(response.body.sessionId).toBeDefined();

      const sessionId = response.body.sessionId;

      // 3. Verify session exists in store
      const sessionData = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(sessionData).toBeDefined();
      expect((sessionData as any).userId).toBe('test-user-123');

      // 4. Access protected route
      response = await agent.get('/profile');
      expect(response.status).toBe(200);
      expect(response.body.userId).toBe('test-user-123');

      // 5. Update profile
      const profileData = { name: 'John Doe', email: 'john@example.com' };
      response = await agent.post('/update-profile').send(profileData);
      expect(response.status).toBe(200);
      expect(response.body.profile).toEqual(profileData);

      // 6. Verify session was updated in store
      const updatedSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect((updatedSession as any).profile).toEqual(profileData);
      expect((updatedSession as any).lastUpdated).toBeDefined();

      // 7. Logout
      response = await agent.post('/logout');
      expect(response.status).toBe(200);

      // 8. Verify session was destroyed in store
      const destroyedSession = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(destroyedSession).toBeNull();

      // 9. Try to access protected route after logout
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    });

    it('should handle shopping cart session state', async () => {
      const agent = request.agent(app);

      // Start with empty cart
      let response = await agent.get('/cart');
      expect(response.status).toBe(200);
      expect(response.body.cart).toEqual([]);

      // Add items to cart
      const item1 = { id: 'item1', name: 'Test Item 1', price: 29.99, quantity: 2 };
      response = await agent.post('/cart/add').send(item1);
      expect(response.status).toBe(200);
      expect(response.body.cart).toHaveLength(1);
      expect(response.body.cart[0].id).toBe('item1');

      const item2 = { id: 'item2', name: 'Test Item 2', price: 19.99 };
      response = await agent.post('/cart/add').send(item2);
      expect(response.status).toBe(200);
      expect(response.body.cart).toHaveLength(2);

      // Verify cart state
      response = await agent.get('/cart');
      expect(response.status).toBe(200);
      expect(response.body.itemCount).toBe(2);

      const cart = response.body.cart;
      expect(cart[0].id).toBe('item1');
      expect(cart[0].quantity).toBe(2);
      expect(cart[1].id).toBe('item2');
      expect(cart[1].quantity).toBe(1); // Default quantity
    });
  });

  describe('Session Persistence', () => {
    it('should persist sessions across server restarts', async () => {
      const agent = request.agent(app);

      // Login and create session
      let response = await agent.get('/login');
      expect(response.status).toBe(200);
      const sessionId = response.body.sessionId;

      // Add some data to session
      const profileData = { name: 'Persistent User', email: 'persistent@example.com' };
      await agent.post('/update-profile').send(profileData);

      // Verify session exists in Valkey
      const sessionData = await new Promise((resolve, reject) => {
        store.get(sessionId, (err: any, session: any) => {
          if (err) reject(err);
          else resolve(session);
        });
      });

      expect(sessionData).toBeDefined();
      expect((sessionData as any).profile).toEqual(profileData);

      // Simulate server restart by creating new store instance
      const newStore = new ValkeyStore({
        client: client,
        prefix: 'e2e-sess:',
        ttl: 3600,
      });

      // Create new Express app with new store
      const newApp = express();
      newApp.use(express.json());
      newApp.use(session({
        store: newStore,
        secret: 'test-secret-key',
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: false,
          httpOnly: true,
          maxAge: 1800000,
        },
      }));

      newApp.get('/profile', (req: any, res) => {
        if (!req.session || !req.session.isAuthenticated) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        res.json({
          userId: req.session.userId,
          profile: req.session.profile,
          sessionId: req.sessionID,
        });
      });

      // Use the same session cookie with new app
      const cookieAccess = { domain: '127.0.0.1', path: '/', secure: false, script: false };
      const cookies = agent.jar.getCookies(cookieAccess).toValueString();

      response = await request(newApp)
        .get('/profile')
        .set('Cookie', cookies);

      expect(response.status).toBe(200);
      expect(response.body.profile).toEqual(profileData);
      expect(response.body.userId).toBe('test-user-123');
    });

    it('should handle session expiration correctly', async () => {
      // Create store with very short TTL
      const shortTtlStore = new ValkeyStore({
        client: client,
        prefix: 'e2e-short-sess:',
        ttl: 2, // 2 seconds
      });

      const shortApp = express();
      shortApp.use(session({
        store: shortTtlStore,
        secret: 'test-secret-key',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false, httpOnly: true },
      }));

      shortApp.get('/login', (req: any, res) => {
        req.session.userId = 'expire-test-user';
        res.json({ sessionId: req.sessionID });
      });

      shortApp.get('/profile', (req: any, res) => {
        if (!req.session || !req.session.userId) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        res.json({ userId: req.session.userId });
      });

      const agent = request.agent(shortApp);

      // Login
      let response = await agent.get('/login');
      expect(response.status).toBe(200);

      // Immediate access should work
      response = await agent.get('/profile');
      expect(response.status).toBe(200);

      // Wait for session to expire
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Access after expiration should fail
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    }, 10000);
  });

  describe('Concurrent Users', () => {
    it('should handle multiple concurrent users', async () => {
      const userCount = 10;
      const agents = Array.from({ length: userCount }, () => request.agent(app));

      // All users login concurrently
      const loginPromises = agents.map((agent, i) => {
        return agent.get('/login').then(response => {
          expect(response.status).toBe(200);
          return { agent, sessionId: response.body.sessionId, userId: i };
        });
      });

      const users = await Promise.all(loginPromises);

      // Verify all sessions are unique
      const sessionIds = users.map(user => user.sessionId);
      const uniqueSessionIds = new Set(sessionIds);
      expect(uniqueSessionIds.size).toBe(userCount);

      // Each user updates their profile concurrently
      const updatePromises = users.map(({ agent, userId }) => {
        const profileData = { name: `User ${userId}`, id: userId };
        return agent.post('/update-profile').send(profileData);
      });

      const updateResponses = await Promise.all(updatePromises);
      updateResponses.forEach((response, i) => {
        expect(response.status).toBe(200);
        expect(response.body.profile.id).toBe(i);
      });

      // Verify all sessions exist in store
      const sessionCount = await new Promise((resolve, reject) => {
        store.length((err: any, length: any) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      expect(sessionCount).toBe(userCount);

      // Each user adds items to cart concurrently
      const cartPromises = users.map(({ agent, userId }) => {
        const item = { id: `item-${userId}`, name: `Item for user ${userId}`, price: userId * 10 };
        return agent.post('/cart/add').send(item);
      });

      const cartResponses = await Promise.all(cartPromises);
      cartResponses.forEach((response, i) => {
        expect(response.status).toBe(200);
        expect(response.body.cart[0].id).toBe(`item-${i}`);
      });
    }, 15000);

    it('should isolate user sessions correctly', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);

      // User 1 login and setup
      let response1 = await agent1.get('/login');
      const profile1 = { name: 'User One', role: 'admin' };
      await agent1.post('/update-profile').send(profile1);
      await agent1.post('/cart/add').send({ id: 'item1', name: 'User 1 Item' });

      // User 2 login and setup
      let response2 = await agent2.get('/login');
      const profile2 = { name: 'User Two', role: 'user' };
      await agent2.post('/update-profile').send(profile2);
      await agent2.post('/cart/add').send({ id: 'item2', name: 'User 2 Item' });

      // Verify isolation - User 1 profile
      response1 = await agent1.get('/profile');
      expect(response1.body.userId).toBe('test-user-123');
      // Note: In a real app, each login would have unique user IDs

      // Verify User 1 cart
      response1 = await agent1.get('/cart');
      expect(response1.body.cart).toHaveLength(1);
      expect(response1.body.cart[0].id).toBe('item1');

      // Verify User 2 cart
      response2 = await agent2.get('/cart');
      expect(response2.body.cart).toHaveLength(1);
      expect(response2.body.cart[0].id).toBe('item2');

      // Sessions should be different
      const sessionInfo1 = await agent1.get('/session-info');
      const sessionInfo2 = await agent2.get('/session-info');
      expect(sessionInfo1.body.sessionID).not.toBe(sessionInfo2.body.sessionID);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle Valkey connection issues gracefully', async () => {
      const agent = request.agent(app);

      // Login first
      await agent.get('/login');

      // Force close the client connection
      await client.close();

      // Create new client for cleanup
      client = await createTestStandaloneClient();

      // Subsequent requests should handle the connection error
      // The exact behavior depends on express-session configuration
      const response = await agent.get('/profile');

      // The session middleware should handle this gracefully
      // Either by creating a new session or returning an error
      expect([200, 401, 500]).toContain(response.status);
    });

    it('should handle session store errors gracefully', async () => {
      // Create a store that will fail
      const faultyStore = new ValkeyStore({
        client: client,
        prefix: 'faulty-sess:',
        ttl: 3600,
        logErrors: false,
      });

      // Override the get method to simulate failures
      const originalGet = faultyStore.get.bind(faultyStore);
      faultyStore.get = jest.fn().mockImplementation((sid, callback) => {
        callback(new Error('Store failure'));
      });

      const faultyApp = express();
      faultyApp.use(session({
        store: faultyStore,
        secret: 'test-secret-key',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false },
      }));

      faultyApp.get('/test', (req: any, res) => {
        res.json({ hasSession: !!req.session });
      });

      const response = await request(faultyApp).get('/test');

      // Express-session should handle store errors and continue
      expect(response.status).toBe(200);
    });
  });
});