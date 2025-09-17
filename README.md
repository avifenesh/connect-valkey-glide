# connect-valkey-glide

Session store for Express/Connect using [valkey-glide](https://github.com/valkey-io/valkey-glide) client. Compatible with connect-redis API.

## Installation

```bash
npm install connect-valkey-glide
```

Note: Requires `@valkey/valkey-glide` and `express-session` as peer dependencies.

## Usage

```javascript
const express = require('express');
const session = require('express-session');
const { GlideClient } = require('@valkey/valkey-glide');
const { ValkeyStore } = require('connect-valkey-glide');

const app = express();

// Create Valkey client
const client = await GlideClient.createClient({
  addresses: [{ host: 'localhost', port: 6379 }]
});

// Configure session
app.use(session({
  store: new ValkeyStore({ client }),
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | GlideClient | required | valkey-glide client instance |
| `prefix` | string | `'sess:'` | Key prefix for sessions |
| `ttl` | number | `86400` | Session TTL in seconds |
| `disableTouch` | boolean | `false` | Disable touch operations |
| `disableTTL` | boolean | `false` | Disable TTL management |
| `scanCount` | number | `100` | SCAN batch size |
| `logErrors` | boolean | `true` | Log errors to console |

## API

All methods from connect-redis are supported. Methods can be used with callbacks or promises:

```javascript
// Callback style
store.get(sid, (err, session) => { });

// Promise style
const session = await store.get(sid);
```

### Methods

- `get(sid[, callback])` - Get session
- `set(sid, session[, callback])` - Set session
- `destroy(sid[, callback])` - Delete session
- `touch(sid, session[, callback])` - Reset TTL
- `all([callback])` - Get all sessions
- `length([callback])` - Count sessions
- `clear([callback])` - Delete all sessions
- `ids([callback])` - Get all session IDs

## Cluster Support

Works with both standalone and cluster modes:

```javascript
// Cluster client
const { GlideClusterClient } = require('@valkey/valkey-glide');

const client = await GlideClusterClient.createClient({
  addresses: [
    { host: 'localhost', port: 7000 },
    { host: 'localhost', port: 7001 },
    { host: 'localhost', port: 7002 }
  ]
});

const store = new ValkeyStore({ client });
```

## Security Features

This library includes several security enhancements:

- **Session ID Validation**: Automatically validates session IDs to prevent injection attacks
- **Memory Protection**: Optimized `all()` method prevents memory exhaustion with large session stores
- **TTL Safety**: Race condition-free TTL calculation ensures consistent expiration
- **Error Monitoring**: Enhanced error handling for better observability

### Production Security Best Practices

```javascript
app.use(session({
  store: new ValkeyStore({ client }),
  secret: process.env.SESSION_SECRET, // Use environment variables
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,      // HTTPS only
    httpOnly: true,    // Prevent XSS
    sameSite: 'strict', // CSRF protection
    maxAge: 30 * 60 * 1000 // 30 minutes
  },
  genid: () => crypto.randomUUID() // Strong session ID generation
}));
```

## Testing

```bash
# Run tests
npm test

# Test standalone mode
npm run test:standalone

# Test cluster mode
npm run test:cluster
```

## Compatibility

- Node.js 18+
- Express/Connect session middleware
- Valkey 7.2+ or Redis 6.2+

## License

MIT