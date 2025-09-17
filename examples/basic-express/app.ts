/**
 * Basic Express application with ValkeyStore session management
 *
 * This example demonstrates:
 * - Session creation and management
 * - User authentication flow
 * - Shopping cart functionality
 * - Session persistence and cleanup
 */

import express from 'express';
import session from 'express-session';
import { GlideClient } from '@valkey/valkey-glide';
import { ValkeyStore } from 'connect-valkey-glide';

interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
}

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

// Extend session data interface
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    user?: User;
    isAuthenticated?: boolean;
    loginTime?: string;
    cart?: CartItem[];
    preferences?: Record<string, any>;
  }
}

async function createApp() {
  // Create Valkey client
  const valkeyClient = await GlideClient.createClient({
    addresses: [{ host: 'localhost', port: 6379 }],
    requestTimeout: 5000,
  });

  // Create ValkeyStore instance
  const store = new ValkeyStore({
    client: valkeyClient,
    prefix: 'myapp:sess:',
    ttl: 86400, // 24 hours
    disableTTL: false,
    disableTouch: false,
    scanCount: 100,
    logErrors: true,
  });

  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session middleware with ValkeyStore
  app.use(session({
    store: store,
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    name: 'sessionId',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax',
    },
  }));

  // Mock user database (in real app, use a proper database)
  const users: User[] = [
    { id: '1', username: 'admin', email: 'admin@example.com', role: 'admin' },
    { id: '2', username: 'user1', email: 'user1@example.com', role: 'user' },
    { id: '3', username: 'user2', email: 'user2@example.com', role: 'user' },
  ];

  // Mock product catalog
  const products = [
    { id: 'p1', name: 'Laptop', price: 999.99, stock: 10 },
    { id: 'p2', name: 'Mouse', price: 29.99, stock: 50 },
    { id: 'p3', name: 'Keyboard', price: 79.99, stock: 25 },
    { id: 'p4', name: 'Monitor', price: 299.99, stock: 8 },
  ];

  // Authentication middleware
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.session.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  };

  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.session.isAuthenticated || req.session.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  // Routes

  // Home page
  app.get('/', (req, res) => {
    res.json({
      message: 'Welcome to ValkeyStore Demo App',
      sessionId: req.sessionID,
      isAuthenticated: req.session.isAuthenticated || false,
      user: req.session.user || null,
      endpoints: {
        auth: ['/login', '/logout', '/register'],
        profile: ['/profile', '/profile/preferences'],
        shopping: ['/products', '/cart', '/cart/add', '/cart/remove'],
        admin: ['/admin/sessions', '/admin/stats'],
      },
    });
  });

  // Authentication routes
  app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Simple authentication (in real app, hash passwords)
    const user = users.find(u => u.username === username && password === 'password123');

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    req.session.userId = user.id;
    req.session.user = user;
    req.session.isAuthenticated = true;
    req.session.loginTime = new Date().toISOString();

    // Initialize cart if it doesn't exist
    if (!req.session.cart) {
      req.session.cart = [];
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
      sessionId: req.sessionID,
    });
  });

  app.post('/logout', requireAuth, (req, res) => {
    const userId = req.session.userId;

    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
        return res.status(500).json({ error: 'Failed to logout' });
      }

      res.json({
        message: 'Logout successful',
        userId: userId,
      });
    });
  });

  app.post('/register', (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }

    // Check if user already exists
    if (users.find(u => u.username === username || u.email === email)) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Create new user
    const newUser: User = {
      id: Date.now().toString(),
      username,
      email,
      role: 'user',
    };

    users.push(newUser);

    res.json({
      message: 'Registration successful',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
      },
    });
  });

  // Profile routes
  app.get('/profile', requireAuth, (req, res) => {
    res.json({
      user: req.session.user,
      loginTime: req.session.loginTime,
      sessionId: req.sessionID,
      preferences: req.session.preferences || {},
    });
  });

  app.put('/profile/preferences', requireAuth, (req, res) => {
    req.session.preferences = {
      ...req.session.preferences,
      ...req.body,
      updatedAt: new Date().toISOString(),
    };

    res.json({
      message: 'Preferences updated',
      preferences: req.session.preferences,
    });
  });

  // Shopping routes
  app.get('/products', (req, res) => {
    res.json({
      products: products,
      cartItemCount: req.session.cart?.length || 0,
    });
  });

  app.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    res.json({
      cart: cart,
      itemCount: cart.length,
      totalItems: cart.reduce((sum, item) => sum + item.quantity, 0),
      total: parseFloat(total.toFixed(2)),
      isAuthenticated: req.session.isAuthenticated || false,
    });
  });

  app.post('/cart/add', (req, res) => {
    const { productId, quantity = 1 } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'Product ID required' });
    }

    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (quantity > product.stock) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    // Initialize cart if it doesn't exist
    if (!req.session.cart) {
      req.session.cart = [];
    }

    // Check if item already in cart
    const existingItem = req.session.cart.find(item => item.id === productId);

    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      req.session.cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        quantity: quantity,
      });
    }

    const total = req.session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    res.json({
      message: 'Item added to cart',
      cart: req.session.cart,
      itemCount: req.session.cart.length,
      total: parseFloat(total.toFixed(2)),
    });
  });

  app.delete('/cart/remove/:productId', (req, res) => {
    const { productId } = req.params;

    if (!req.session.cart) {
      return res.status(404).json({ error: 'Cart is empty' });
    }

    const initialLength = req.session.cart.length;
    req.session.cart = req.session.cart.filter(item => item.id !== productId);

    if (req.session.cart.length === initialLength) {
      return res.status(404).json({ error: 'Item not found in cart' });
    }

    const total = req.session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    res.json({
      message: 'Item removed from cart',
      cart: req.session.cart,
      itemCount: req.session.cart.length,
      total: parseFloat(total.toFixed(2)),
    });
  });

  // Admin routes
  app.get('/admin/sessions', requireAdmin, async (req, res) => {
    try {
      // Get all sessions
      const allSessions = await new Promise<Record<string, any>>((resolve, reject) => {
        store.all((err: any, sessions?: Record<string, any> | null) => {
          if (err) reject(err);
          else resolve(sessions || {});
        });
      });

      // Get session count
      const sessionCount = await new Promise<number>((resolve, reject) => {
        store.length((err: any, length?: number) => {
          if (err) reject(err);
          else resolve(length || 0);
        });
      });

      res.json({
        sessions: allSessions,
        sessionCount: sessionCount,
        activeSessions: Object.keys(allSessions).length,
      });
    } catch (error) {
      console.error('Error fetching sessions:', error);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  app.get('/admin/stats', requireAdmin, async (req, res) => {
    try {
      const sessionIds = await new Promise<string[]>((resolve, reject) => {
        store.ids((err: any, ids?: string[]) => {
          if (err) reject(err);
          else resolve(ids || []);
        });
      });

      const sessionCount = await new Promise<number>((resolve, reject) => {
        store.length((err: any, length?: number) => {
          if (err) reject(err);
          else resolve(length || 0);
        });
      });

      res.json({
        sessionCount: sessionCount,
        sessionIds: sessionIds,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: 'Failed to fetch statistics' });
    }
  });

  app.post('/admin/clear', requireAdmin, async (req, res) => {
    try {
      await new Promise<void>((resolve, reject) => {
        store.clear((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      res.json({
        message: 'All sessions cleared',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error during clear:', error);
      res.status(500).json({ error: 'Failed to clear sessions' });
    }
  });

  app.delete('/admin/sessions/:sessionId', requireAdmin, (req, res) => {
    const { sessionId } = req.params;

    store.destroy(sessionId, (err: any) => {
      if (err) {
        console.error('Error destroying session:', err);
        return res.status(500).json({ error: 'Failed to destroy session' });
      }

      res.json({
        message: 'Session destroyed',
        sessionId: sessionId,
      });
    });
  });

  // Health check
  app.get('/health', async (req, res) => {
    try {
      // Test Valkey connection
      await valkeyClient.ping();

      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        valkey: 'connected',
        uptime: process.uptime(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        valkey: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Error handling
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      path: req.originalUrl,
    });
  });

  return { app, store, valkeyClient };
}

// Start server if this file is run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  createApp().then(({ app, store, valkeyClient }) => {
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📦 Using ValkeyStore with prefix: myapp:sess:`);
      console.log('');
      console.log('Available endpoints:');
      console.log('  POST /login - Login (use username: admin/user1/user2, password: password123)');
      console.log('  POST /logout - Logout');
      console.log('  POST /register - Register new user');
      console.log('  GET  /profile - Get user profile');
      console.log('  PUT  /profile/preferences - Update preferences');
      console.log('  GET  /products - List products');
      console.log('  GET  /cart - View cart');
      console.log('  POST /cart/add - Add to cart');
      console.log('  GET  /admin/sessions - View all sessions (admin only)');
      console.log('  GET  /admin/stats - View statistics (admin only)');
      console.log('  GET  /health - Health check');
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully...');
      server.close(async () => {
        try {
          await valkeyClient.close();
          console.log('✅ Server and Valkey connection closed');
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully...');
      server.close(async () => {
        try {
          await valkeyClient.close();
          console.log('✅ Server and Valkey connection closed');
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });
    });
  }).catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

export { createApp };