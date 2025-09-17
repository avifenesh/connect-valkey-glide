# Basic Express Example with ValkeyStore

This example demonstrates how to use `connect-valkey-glide` as a session store in a typical Express.js application.

## Features Demonstrated

- User authentication and session management
- Shopping cart functionality with persistent sessions
- User preferences storage
- Admin panel for session monitoring
- Session cleanup and statistics
- Health checks and error handling
- Graceful shutdown with connection cleanup

## Prerequisites

1. Node.js 18+ installed
2. Valkey server running on localhost:6379
3. TypeScript for development (optional)

## Quick Start

1. **Start Valkey server:**
   ```bash
   # Using Docker
   docker run -d -p 6379:6379 valkey/valkey:8.0.1

   # Or using the test infrastructure
   cd ../../
   npm run valkey:start
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the application:**
   ```bash
   # Development mode with TypeScript
   npm run dev

   # Or build and run
   npm run build
   npm start
   ```

4. **Open your browser:**
   Navigate to http://localhost:3000

## API Endpoints

### Authentication
- `POST /login` - Login with username/password
- `POST /logout` - Logout and destroy session
- `POST /register` - Register new user

### User Management
- `GET /profile` - Get user profile and preferences
- `PUT /profile/preferences` - Update user preferences

### Shopping
- `GET /products` - List available products
- `GET /cart` - View shopping cart
- `POST /cart/add` - Add item to cart
- `DELETE /cart/remove/:productId` - Remove item from cart

### Administration
- `GET /admin/sessions` - View all active sessions (admin only)
- `GET /admin/stats` - View session statistics (admin only)
- `POST /admin/cleanup` - Clean up expired sessions (admin only)
- `DELETE /admin/sessions/:sessionId` - Destroy specific session (admin only)

### System
- `GET /health` - Health check endpoint

## Default Users

For testing, you can use these pre-configured users:

| Username | Password    | Role  |
|----------|------------|-------|
| admin    | password123 | admin |
| user1    | password123 | user  |
| user2    | password123 | user  |

## Example Usage

### 1. Login
```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "password123"}' \
  -c cookies.txt
```

### 2. Add items to cart
```bash
curl -X POST http://localhost:3000/cart/add \
  -H "Content-Type: application/json" \
  -d '{"productId": "p1", "quantity": 2}' \
  -b cookies.txt
```

### 3. View cart
```bash
curl -X GET http://localhost:3000/cart -b cookies.txt
```

### 4. View session statistics (admin only)
```bash
curl -X GET http://localhost:3000/admin/stats -b cookies.txt
```

## Configuration Options

The ValkeyStore is configured with these options:

```typescript
const store = new ValkeyStore({
  client: valkeyClient,           // Valkey client instance
  prefix: 'myapp:sess:',         // Session key prefix
  ttl: 86400,                    // Session TTL (24 hours)
  disableTTL: false,             // Allow TTL
  disableTouch: false,           // Allow touch operations
  scanCount: 100,                // SCAN batch size
  logErrors: true,               // Log errors to console
});
```

## Session Configuration

Express session is configured with:

```typescript
app.use(session({
  store: store,                  // Our ValkeyStore instance
  secret: 'your-secret-key',     // Change in production!
  name: 'sessionId',             // Cookie name
  resave: false,                 // Don't save unchanged sessions
  saveUninitialized: false,      // Don't save empty sessions
  cookie: {
    secure: false,               // Set to true in production with HTTPS
    httpOnly: true,              // Prevent XSS attacks
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',             // CSRF protection
  },
}));
```

## Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment ('production' enables secure cookies)
- `SESSION_SECRET` - Session secret key (change in production!)

## Production Considerations

1. **Security:**
   - Change the session secret
   - Enable secure cookies with HTTPS
   - Use environment variables for configuration
   - Implement proper user authentication with password hashing

2. **Performance:**
   - Adjust `scanCount` based on expected session volume
   - Consider session TTL based on your application needs
   - Monitor session statistics for optimization

3. **Monitoring:**
   - Use the `/health` endpoint for health checks
   - Monitor session statistics via `/admin/stats`
   - Set up proper error logging and monitoring

4. **Scaling:**
   - Multiple app instances can share the same ValkeyStore
   - Sessions persist across server restarts
   - Consider Valkey clustering for high availability

## Troubleshooting

1. **Connection Issues:**
   - Ensure Valkey is running and accessible
   - Check network connectivity to Valkey server
   - Verify connection configuration

2. **Session Issues:**
   - Check browser cookies are enabled
   - Verify session configuration matches your needs
   - Monitor session expiration times

3. **Performance Issues:**
   - Monitor session count and cleanup regularly
   - Adjust scan count for bulk operations
   - Consider session data size optimization

## Migration from connect-redis

This example is a drop-in replacement for connect-redis. Simply:

1. Replace `import ConnectRedis from 'connect-redis'` with `import { ValkeyStore } from 'connect-valkey-glide'`
2. Replace Redis client with Valkey client
3. Update client configuration for valkey-glide API

All session functionality remains identical!