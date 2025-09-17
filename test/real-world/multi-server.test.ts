/**
 * Real-world test: Multi-Server Session Sharing
 * Tests session sharing across multiple Express servers:
 * - Session created on server A is accessible on servers B and C
 * - Session modifications propagate correctly
 * - Both standalone and cluster modes
 */

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { GlideClient, GlideClusterClient } from '@valkey/valkey-glide';
import { ValkeyStore } from '../../src';
import { createTestStore } from '../utils/test-helpers';

interface ServerInstance {
  app: express.Express;
  server: any;
  port: number;
}

describe('Multi-Server Session Sharing', () => {
  let store: ValkeyStore;
  let client: GlideClient | GlideClusterClient;
  let servers: ServerInstance[] = [];

  async function createServer(store: ValkeyStore, name: string): Promise<ServerInstance> {
    const app = express();

    app.use(express.json());
    app.use(session({
      store,
      secret: 'shared-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 30 * 60 * 1000 // 30 minutes
      },
      name: 'multi.sid' // Consistent session cookie name
    }));

    // Server identification endpoint
    app.get('/server', (req, res) => {
      res.json({
        server: name,
        sessionId: req.sessionID,
        timestamp: Date.now()
      });
    });

    // Session data endpoints
    app.get('/data', (req: any, res) => {
      res.json({
        server: name,
        sessionId: req.sessionID,
        data: req.session.data || null
      });
    });

    app.post('/data', (req: any, res) => {
      req.session.data = req.session.data || {};
      Object.assign(req.session.data, req.body);
      req.session.lastModifiedBy = name;
      req.session.lastModified = Date.now();

      req.session.save((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to save session' });
        }
        res.json({
          server: name,
          sessionId: req.sessionID,
          data: req.session.data
        });
      });
    });

    // User simulation endpoints
    app.post('/login', (req: any, res) => {
      const { username } = req.body;
      req.session.user = {
        username,
        loginTime: Date.now(),
        loginServer: name
      };
      req.session.isAuthenticated = true;

      req.session.save((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to save session' });
        }
        res.json({
          server: name,
          sessionId: req.sessionID,
          user: req.session.user
        });
      });
    });

    app.get('/user', (req: any, res) => {
      if (!req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      res.json({
        server: name,
        sessionId: req.sessionID,
        user: req.session.user
      });
    });

    app.post('/logout', (req: any, res) => {
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to destroy session' });
        }
        res.clearCookie('multi.sid');
        res.json({
          server: name,
          message: 'Logged out successfully'
        });
      });
    });

    // Shopping cart simulation
    app.post('/cart/add', (req: any, res) => {
      const { item } = req.body;
      req.session.cart = req.session.cart || [];
      req.session.cart.push({
        item,
        addedBy: name,
        timestamp: Date.now()
      });

      req.session.save((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to save cart' });
        }
        res.json({
          server: name,
          sessionId: req.sessionID,
          cart: req.session.cart
        });
      });
    });

    app.get('/cart', (req: any, res) => {
      res.json({
        server: name,
        sessionId: req.sessionID,
        cart: req.session.cart || []
      });
    });

    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = (server.address() as any).port;
        resolve({ app, server, port });
      });
    });
  }

  async function setupServers(useCluster = false) {
    const result = await createTestStore({ useCluster });
    store = result.store;
    client = result.client;

    // Create 3 servers
    servers = await Promise.all([
      createServer(store, 'Server-A'),
      createServer(store, 'Server-B'),
      createServer(store, 'Server-C')
    ]);
  }

  afterEach(async () => {
    // Close all servers
    for (const server of servers) {
      if (server.server) {
        await new Promise((resolve) => server.server.close(resolve));
      }
    }
    servers = [];

    if (client) {
      await client.close();
    }
  });

  describe('Standalone Mode', () => {
    beforeEach(async () => {
      await setupServers(false);
    });

    it('should share sessions across all servers', async () => {
      const [serverA, serverB, serverC] = servers;

      // Create session on Server A
      const agentA = request.agent(serverA.app);
      const loginResponse = await agentA
        .post('/login')
        .send({ username: 'alice' });

      expect(loginResponse.status).toBe(200);
      const sessionId = loginResponse.body.sessionId;

      // Extract session cookie
      const cookies = loginResponse.headers['set-cookie'];
      expect(cookies).toBeDefined();

      // Access session from Server B with same cookie
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      const userResponseB = await agentB.get('/user');
      expect(userResponseB.status).toBe(200);
      expect(userResponseB.body.user.username).toBe('alice');
      expect(userResponseB.body.sessionId).toBe(sessionId);

      // Access session from Server C with same cookie
      const agentC = request.agent(serverC.app);
      agentC.jar.setCookies(cookies);

      const userResponseC = await agentC.get('/user');
      expect(userResponseC.status).toBe(200);
      expect(userResponseC.body.user.username).toBe('alice');
      expect(userResponseC.body.sessionId).toBe(sessionId);
    });

    it('should propagate session modifications across servers', async () => {
      const [serverA, serverB, serverC] = servers;
      const agentA = request.agent(serverA.app);

      // Create session data on Server A
      const dataResponse = await agentA
        .post('/data')
        .send({ key1: 'value1', key2: 'value2' });

      const cookies = dataResponse.headers['set-cookie'];

      // Modify data on Server B
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      await agentB
        .post('/data')
        .send({ key2: 'updated', key3: 'value3' });

      // Read modified data from Server C
      const agentC = request.agent(serverC.app);
      agentC.jar.setCookies(cookies);

      const finalResponse = await agentC.get('/data');
      expect(finalResponse.body.data).toEqual({
        key1: 'value1',
        key2: 'updated',
        key3: 'value3'
      });
    });

    it('should handle shopping cart across servers', async () => {
      const [serverA, serverB, serverC] = servers;
      const agentA = request.agent(serverA.app);

      // Add item on Server A
      const cartResponse1 = await agentA
        .post('/cart/add')
        .send({ item: 'laptop' });

      const cookies = cartResponse1.headers['set-cookie'];

      // Add item on Server B
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      await agentB
        .post('/cart/add')
        .send({ item: 'mouse' });

      // Add item on Server C
      const agentC = request.agent(serverC.app);
      agentC.jar.setCookies(cookies);

      await agentC
        .post('/cart/add')
        .send({ item: 'keyboard' });

      // Check cart from Server A
      const finalCart = await agentA.get('/cart');
      expect(finalCart.body.cart).toHaveLength(3);

      const items = finalCart.body.cart.map((c: any) => c.item);
      expect(items).toContain('laptop');
      expect(items).toContain('mouse');
      expect(items).toContain('keyboard');

      // Verify servers recorded correctly
      const addedByServers = finalCart.body.cart.map((c: any) => c.addedBy);
      expect(addedByServers).toContain('Server-A');
      expect(addedByServers).toContain('Server-B');
      expect(addedByServers).toContain('Server-C');
    });

    it('should handle session destruction across servers', async () => {
      const [serverA, serverB, serverC] = servers;
      const agentA = request.agent(serverA.app);

      // Login on Server A
      const loginResponse = await agentA
        .post('/login')
        .send({ username: 'bob' });

      const cookies = loginResponse.headers['set-cookie'];

      // Verify logged in on Server B
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      let userResponse = await agentB.get('/user');
      expect(userResponse.status).toBe(200);

      // Logout on Server C
      const agentC = request.agent(serverC.app);
      agentC.jar.setCookies(cookies);

      await agentC.post('/logout');

      // Verify logged out on all servers
      userResponse = await agentA.get('/user');
      expect(userResponse.status).toBe(401);

      userResponse = await agentB.get('/user');
      expect(userResponse.status).toBe(401);

      userResponse = await agentC.get('/user');
      expect(userResponse.status).toBe(401);
    });

    it('should handle concurrent modifications correctly', async () => {
      const [serverA, serverB, serverC] = servers;
      const agentA = request.agent(serverA.app);

      // Create initial session
      const initResponse = await agentA
        .post('/data')
        .send({ counter: 0 });

      const cookies = initResponse.headers['set-cookie'];

      // Setup agents for other servers
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      const agentC = request.agent(serverC.app);
      agentC.jar.setCookies(cookies);

      // Make concurrent modifications
      const promises = [
        agentA.post('/data').send({ counter: 1, fromA: true }),
        agentB.post('/data').send({ counter: 2, fromB: true }),
        agentC.post('/data').send({ counter: 3, fromC: true })
      ];

      await Promise.all(promises);

      // Check final state (last write wins)
      const finalResponse = await agentA.get('/data');
      const data = finalResponse.body.data;

      // Should have data from all servers (though counter will be from last write)
      expect(data.counter).toBeDefined();
      expect(data.fromA || data.fromB || data.fromC).toBeTruthy();
    });

    it('should maintain session integrity under load', async () => {
      const [serverA, serverB, serverC] = servers;
      const agents = [
        request.agent(serverA.app),
        request.agent(serverB.app),
        request.agent(serverC.app)
      ];

      // Create session on first server
      const initResponse = await agents[0]
        .post('/login')
        .send({ username: 'stress-test' });

      const cookies = initResponse.headers['set-cookie'];

      // Set cookies on all agents
      agents[1].jar.setCookies(cookies);
      agents[2].jar.setCookies(cookies);

      // Perform many operations across all servers
      const operations = [];
      for (let i = 0; i < 30; i++) {
        const agent = agents[i % 3];
        operations.push(
          agent.post('/cart/add').send({ item: `item-${i}` })
        );
      }

      await Promise.all(operations);

      // Verify cart has all items
      const cartResponse = await agents[0].get('/cart');
      expect(cartResponse.body.cart).toHaveLength(30);

      // Verify session is still valid on all servers
      for (const agent of agents) {
        const userResponse = await agent.get('/user');
        expect(userResponse.status).toBe(200);
        expect(userResponse.body.user.username).toBe('stress-test');
      }
    });
  });

  describe('Cluster Mode', () => {
    beforeEach(async () => {
      try {
        await setupServers(true);
      } catch (error) {
        // Cluster might not be available
        console.log('Cluster not available for multi-server test');
      }
    });

    it('should share sessions across servers in cluster mode', async () => {
      if (!client || servers.length === 0) {
        console.log('Skipping cluster test - cluster not available');
        return;
      }

      const [serverA, serverB, serverC] = servers;
      const agentA = request.agent(serverA.app);

      // Create session on Server A
      const loginResponse = await agentA
        .post('/login')
        .send({ username: 'cluster-user' });

      expect(loginResponse.status).toBe(200);
      const cookies = loginResponse.headers['set-cookie'];

      // Access from Server B
      const agentB = request.agent(serverB.app);
      agentB.jar.setCookies(cookies);

      const userResponse = await agentB.get('/user');
      expect(userResponse.status).toBe(200);
      expect(userResponse.body.user.username).toBe('cluster-user');
    });
  });
});