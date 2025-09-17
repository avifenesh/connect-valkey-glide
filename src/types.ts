// Type declarations for express-session compatibility
import { SessionData, Store, Cookie, Session } from 'express-session';
import { Request } from 'express';
import { GlideClient, GlideClusterClient } from '@valkey/valkey-glide';

// Re-export SessionData from express-session for proper compatibility
export { SessionData, Cookie, Session, Store };

// Valkey client types
export type ValkeyClient = GlideClient | GlideClusterClient;

// Store configuration interface
export interface ValkeyStoreOptions {
  client: ValkeyClient;
  prefix?: string;
  ttl?: number | ((sess: SessionData) => number);
  disableTTL?: boolean;
  disableTouch?: boolean;
  scanCount?: number;
  logErrors?: boolean;
  serializer?: {
    stringify: (obj: any) => string;
    parse: (str: string) => any | Promise<any>;
  };
}