/**
 * Real-world test: Passport.js authentication flow
 * Tests complete OAuth flow with passport-local strategy including:
 * - Session persistence across requests
 * - User serialization/deserialization
 * - Logout and session destruction
 */

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import request from 'supertest';
import { GlideClient, GlideClusterClient } from '@valkey/valkey-glide';
import { ValkeyStore } from '../../src';
import { createTestStore } from '../utils/test-helpers';

declare module 'express-session' {
  interface SessionData {
    passport?: {
      user?: string;
    };
  }
}

interface User {
  id: string;
  username: string;
  email: string;
}

// Simulated user database
const users: Map<string, User & { password: string }> = new Map([
  ['user1', { id: 'user1', username: 'alice', email: 'alice@example.com', password: 'password123' }],
  ['user2', { id: 'user2', username: 'bob', email: 'bob@example.com', password: 'secret456' }],
]);

describe('Passport.js Authentication Integration', () => {
  let app: express.Express;
  let store: ValkeyStore;
  let client: GlideClient | GlideClusterClient;
  let server: any;

  async function setupApp(useCluster = false) {
    const result = await createTestStore({ useCluster });
    store = result.store;
    client = result.client;

    app = express();

    // Session middleware
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(session({
      store,
      secret: 'test-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 30 * 60 * 1000 // 30 minutes
      }
    }));

    // Passport configuration
    app.use(passport.initialize());
    app.use(passport.session());

    // Configure local strategy
    passport.use(new LocalStrategy(
      (username, password, done) => {
        const user = Array.from(users.values()).find(u => u.username === username);
        if (!user) {
          return done(null, false, { message: 'Incorrect username.' });
        }
        if (user.password !== password) {
          return done(null, false, { message: 'Incorrect password.' });
        }
        const { password: _, ...userWithoutPassword } = user;
        return done(null, userWithoutPassword);
      }
    ));

    // Serialization
    passport.serializeUser((user: any, done) => {
      done(null, user.id);
    });

    passport.deserializeUser((id: string, done) => {
      const user = users.get(id);
      if (user) {
        const { password, ...userWithoutPassword } = user;
        done(null, userWithoutPassword);
      } else {
        done(new Error('User not found'));
      }
    });

    // Routes
    app.post('/login', passport.authenticate('local'), (req, res) => {
      res.json({
        success: true,
        user: req.user,
        sessionId: req.sessionID
      });
    });

    app.post('/logout', (req, res) => {
      req.logout((err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        req.session.destroy((err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.clearCookie('connect.sid');
          res.json({ success: true });
        });
      });
    });

    app.get('/profile', (req, res) => {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      res.json({ user: req.user });
    });

    app.get('/session-info', (req, res) => {
      res.json({
        sessionId: req.sessionID,
        isAuthenticated: req.isAuthenticated(),
        user: req.user || null,
        passport: req.session.passport || null
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

    it('should handle complete authentication lifecycle', async () => {
      const agent = request.agent(app);

      // Initial state - not authenticated
      let response = await agent.get('/profile');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Not authenticated');

      // Login
      response = await agent
        .post('/login')
        .send({ username: 'alice', password: 'password123' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('alice');
      const sessionId = response.body.sessionId;

      // Access protected route after login
      response = await agent.get('/profile');
      expect(response.status).toBe(200);
      expect(response.body.user.username).toBe('alice');

      // Check session info
      response = await agent.get('/session-info');
      expect(response.body.isAuthenticated).toBe(true);
      expect(response.body.sessionId).toBe(sessionId);
      expect(response.body.passport.user).toBe('user1');

      // Logout
      response = await agent.post('/logout');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify logout
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    });

    it('should persist sessions across multiple requests', async () => {
      const agent = request.agent(app);

      // Login
      await agent
        .post('/login')
        .send({ username: 'bob', password: 'secret456' });

      // Make multiple authenticated requests
      for (let i = 0; i < 5; i++) {
        const response = await agent.get('/profile');
        expect(response.status).toBe(200);
        expect(response.body.user.username).toBe('bob');
      }

      // Session should still be valid
      const response = await agent.get('/session-info');
      expect(response.body.isAuthenticated).toBe(true);
    });

    it('should handle failed authentication attempts', async () => {
      const agent = request.agent(app);

      // Wrong password
      let response = await agent
        .post('/login')
        .send({ username: 'alice', password: 'wrongpassword' });
      expect(response.status).toBe(401);

      // Non-existent user
      response = await agent
        .post('/login')
        .send({ username: 'nonexistent', password: 'password' });
      expect(response.status).toBe(401);

      // Should not be authenticated
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    });

    it('should handle session expiration correctly', async () => {
      // Create app with short session TTL
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      const result = await createTestStore({ useCluster: false });
      store = result.store;
      client = result.client;

      app = express();
      app.use(express.json());
      app.use(session({
        store,
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 1000 } // 1 second
      }));

      app.use(passport.initialize());
      app.use(passport.session());

      passport.use(new LocalStrategy(
        (username, password, done) => {
          const user = Array.from(users.values()).find(u => u.username === username);
          if (!user || user.password !== password) {
            return done(null, false);
          }
          const { password: _, ...userWithoutPassword } = user;
          return done(null, userWithoutPassword);
        }
      ));

      passport.serializeUser((user: any, done) => {
        done(null, user.id);
      });

      passport.deserializeUser((id: string, done) => {
        const user = users.get(id);
        if (user) {
          const { password, ...userWithoutPassword } = user;
          done(null, userWithoutPassword);
        } else {
          done(new Error('User not found'));
        }
      });

      app.post('/login', passport.authenticate('local'), (req, res) => {
        res.json({ success: true });
      });

      app.get('/profile', (req, res) => {
        if (!req.isAuthenticated()) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        res.json({ user: req.user });
      });

      server = app.listen(0);
      const agent = request.agent(app);

      // Login
      await agent
        .post('/login')
        .send({ username: 'alice', password: 'password123' });

      // Should be authenticated immediately
      let response = await agent.get('/profile');
      expect(response.status).toBe(200);

      // Wait for session to expire
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should no longer be authenticated
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    });

    it('should handle concurrent users with separate sessions', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);

      // Login both users
      await agent1
        .post('/login')
        .send({ username: 'alice', password: 'password123' });

      await agent2
        .post('/login')
        .send({ username: 'bob', password: 'secret456' });

      // Each should have their own session
      let response1 = await agent1.get('/profile');
      expect(response1.body.user.username).toBe('alice');

      let response2 = await agent2.get('/profile');
      expect(response2.body.user.username).toBe('bob');

      // Logout user 1
      await agent1.post('/logout');

      // User 1 should be logged out
      response1 = await agent1.get('/profile');
      expect(response1.status).toBe(401);

      // User 2 should still be logged in
      response2 = await agent2.get('/profile');
      expect(response2.status).toBe(200);
      expect(response2.body.user.username).toBe('bob');
    });

    it('should properly serialize and deserialize user objects', async () => {
      const agent = request.agent(app);

      // Login
      await agent
        .post('/login')
        .send({ username: 'alice', password: 'password123' });

      // Get session info to check serialization
      let response = await agent.get('/session-info');
      expect(response.body.passport.user).toBe('user1'); // Only ID is serialized

      // Get profile to check deserialization
      response = await agent.get('/profile');
      expect(response.body.user).toEqual({
        id: 'user1',
        username: 'alice',
        email: 'alice@example.com'
      });
      // Password should not be included
      expect(response.body.user.password).toBeUndefined();
    });
  });

  describe('Cluster Mode', () => {
    beforeEach(async () => {
      try {
        await setupApp(true);
      } catch (error) {
        // Cluster might not be available
        console.log('Cluster not available for passport test');
      }
    });

    it('should handle authentication in cluster mode', async () => {
      if (!client) {
        console.log('Skipping cluster test - cluster not available');
        return;
      }

      const agent = request.agent(app);

      // Login
      let response = await agent
        .post('/login')
        .send({ username: 'alice', password: 'password123' });
      expect(response.status).toBe(200);

      // Access protected route
      response = await agent.get('/profile');
      expect(response.status).toBe(200);
      expect(response.body.user.username).toBe('alice');

      // Logout
      await agent.post('/logout');

      // Verify logout
      response = await agent.get('/profile');
      expect(response.status).toBe(401);
    });
  });
});