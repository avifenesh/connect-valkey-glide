import { GlideClient, GlideClusterClient, Batch, ClusterBatch, TimeUnit, ClusterScanCursor } from '@valkey/valkey-glide';
import { SessionData, Store, Session, Cookie, ValkeyStoreOptions, ValkeyClient } from './types';
import { Request } from 'express';

export interface Serializer {
  parse: (s: string) => any | Promise<any>;
  stringify: (obj: any) => string;
}

/**
 * Utility function to handle optional callbacks
 * Enables dual callback/promise support like connect-redis
 */
function optionalCb<T>(
  fn: (cb: (err: any, data?: T) => void) => void,
  cb?: (err: any, data?: T) => void,
  errorEmitter?: { emit: (event: string, error: any) => void }
): Promise<T | undefined> | void {
  if (!cb) {
    return new Promise((resolve, reject) => {
      fn((err, data) => {
        if (err) {
          // Emit error for backward compatibility when no callback
          if (errorEmitter) {
            errorEmitter.emit('error', err);
          }
          reject(err);
        }
        else resolve(data);
      });
    });
  }

  fn(cb);
}

/**
 * Valkey session store for Express using valkey-glide
 * Drop-in replacement for connect-redis with enhanced performance
 */
export class ValkeyStore extends Store {
  public client: ValkeyClient;
  public prefix: string;
  public ttl: number | ((sess: SessionData) => number);
  public disableTTL: boolean;
  public disableTouch: boolean;
  public logErrors: boolean;
  public scanCount: number;
  public serializer: Serializer;

  constructor(options: ValkeyStoreOptions) {
    super();

    this.client = options.client;
    this.prefix = options.prefix || 'sess:';
    this.ttl = options.ttl || 86400; // 24 hours default
    this.disableTTL = options.disableTTL || false;
    this.disableTouch = options.disableTouch || false;
    this.logErrors = options.logErrors !== false; // default true
    this.scanCount = options.scanCount || 100;
    this.serializer = options.serializer || JSON;
  }

  /**
   * Generate session key with prefix
   */
  private key(sid: string): string {
    return `${this.prefix}${sid}`;
  }

  /**
   * Execute batch command with proper typing for both standalone and cluster clients
   */
  private async executeBatch(batch: Batch, atomic: boolean = false): Promise<any[] | null> {
    if (this.client instanceof GlideClient) {
      return this.client.exec(batch, atomic);
    } else {
      // For cluster client, we need to cast the batch
      return this.client.exec(batch as any, atomic);
    }
  }

  /**
   * Handle errors with optional logging
   */
  private handleError(error: Error, callback?: (err?: any) => void): void {
    if (this.logErrors) {
      console.error('ValkeyStore error:', error);
    }
    if (callback) {
      callback(error);
    } else {
      this.emit('error', error);
    }
  }

  /**
   * Get session data
   */
  async get(sid: string): Promise<SessionData | null>;
  async get(sid: string, callback: (err: any, session?: SessionData | null) => void): Promise<void>;
  async get(sid: string, callback?: (err: any, session?: SessionData | null) => void): Promise<SessionData | null | void> {
    const fn = (cb: (err: any, session?: SessionData | null) => void) => {
      const key = this.key(sid);
      // Debug logging for CI issues
      if (process.env.CI && sid.includes('crud')) {
        console.log('Getting session with key:', key);
      }

      this.client.get(key)
        .then((data) => {
          // Debug logging for CI issues
          if (process.env.CI && sid.includes('crud')) {
            console.log('Raw data from Valkey:', data);
          }
          if (!data) {
            return cb(null, null);
          }

          try {
            const parseResult = this.serializer.parse(typeof data === 'string' ? data : data.toString());

            // Handle both sync and async parse results
            if (parseResult instanceof Promise) {
              parseResult
                .then(session => cb(null, session))
                .catch(error => this.handleError(error as Error, cb));
            } else {
              cb(null, parseResult);
            }
          } catch (error) {
            this.handleError(error as Error, cb);
          }
        })
        .catch((error) => {
          this.handleError(error, cb);
        });
    };

    return optionalCb<SessionData | null>(fn, callback as any, this);
  }

  /**
   * Set session data
   */
  async set(sid: string, session: SessionData): Promise<void>;
  async set(sid: string, session: SessionData, callback: (err?: any) => void): Promise<void>;
  async set(sid: string, session: SessionData, callback?: (err?: any) => void): Promise<void> {
    const fn = (cb: (err?: any) => void) => {
      const key = this.key(sid);
      const ttl = this.getTTL(session);
      // Debug logging for CI issues
      if (process.env.CI && sid.includes('crud')) {
        console.log('Setting session with key:', key);
      }

      // If TTL is 0 or negative (expired), delete the session instead
      if (ttl <= 0 && !this.disableTTL) {
        this.client.del([key])
          .then(() => cb())
          .catch((error) => {
            this.handleError(error, cb);
          });
        return;
      }

      try {
        const sessionData = this.serializer.stringify(session);

        // Set with or without expiry based on TTL
        const setOptions = ttl > 0 ? {
          expiry: { type: TimeUnit.Seconds, count: ttl }
        } : undefined;

        this.client.set(key, sessionData, setOptions)
          .then(() => {
            // Debug logging for CI issues
            if (process.env.CI && sid.includes('crud')) {
              console.log('Session set successfully for key:', key);
            }
            cb();
          })
          .catch((error) => {
            // Debug logging for CI issues
            if (process.env.CI && sid.includes('crud')) {
              console.log('Error setting session:', error);
            }
            this.handleError(error, cb);
          });
      } catch (error) {
        this.handleError(error as Error, cb);
      }
    };

    return optionalCb<void>(fn as any, callback as any, this) as Promise<void>;
  }

  /**
   * Destroy session
   */
  async destroy(sid: string): Promise<void>;
  async destroy(sid: string, callback: (err?: any) => void): Promise<void>;
  async destroy(sid: string, callback?: (err?: any) => void): Promise<void> {
    const fn = (cb: (err?: any) => void) => {
      const key = this.key(sid);

      this.client.del([key])
        .then(() => cb())
        .catch((error) => {
          this.handleError(error, cb);
        });
    };

    return optionalCb<void>(fn as any, callback as any, this) as Promise<void>;
  }

  /**
   * Touch session to update expiry
   */
  async touch(sid: string, session: SessionData): Promise<void>;
  async touch(sid: string, session: SessionData, callback: (err?: any) => void): Promise<void>;
  async touch(sid: string, session: SessionData, callback?: (err?: any) => void): Promise<void> {
    if (this.disableTouch) {
      if (callback) callback();
      return Promise.resolve();
    }

    const fn = (cb: (err?: any) => void) => {
      const key = this.key(sid);
      const ttl = this.getTTL(session);

      this.client.expire(key, ttl)
        .then(() => cb())
        .catch((error) => {
          this.handleError(error, cb);
        });
    };

    return optionalCb<void>(fn as any, callback as any, this) as Promise<void>;
  }

  /**
   * Get all session IDs
   */
  async all(): Promise<{ [sid: string]: SessionData } | null>;
  async all(callback: (err: any, obj?: { [sid: string]: SessionData } | null) => void): Promise<void>;
  async all(callback?: (err: any, obj?: { [sid: string]: SessionData } | null) => void): Promise<{ [sid: string]: SessionData } | null | void> {
    const fn = async (cb: (err: any, obj?: { [sid: string]: SessionData } | null) => void) => {
      const pattern = `${this.prefix}*`;
      const sessions: { [sid: string]: SessionData } = {};

      try {
        // Process scan results in batches
        await this.scanAndProcessKeys(pattern, async (keys) => {
          if (keys.length === 0) return;

          // Use MGET for batch retrieval - works in both standalone and cluster
          const values = await this.client.mget(keys);

          // Process the values
          const parsePromises: Promise<void>[] = [];

          values.forEach((data, index) => {
            if (data) {
              const sid = keys[index].replace(this.prefix, '');

              try {
                const parseResult = this.serializer.parse(data as string);

                if (parseResult instanceof Promise) {
                  parsePromises.push(
                    parseResult
                      .then(session => { sessions[sid] = session; })
                      .catch(error => {
                        if (this.logErrors) {
                          console.warn('ValkeyStore: Invalid session data for key:', keys[index]);
                        }
                      })
                  );
                } else {
                  sessions[sid] = parseResult;
                }
              } catch (error) {
                // Skip invalid sessions
                if (this.logErrors) {
                  console.warn('ValkeyStore: Invalid session data for key:', keys[index]);
                }
              }
            }
          });

          // Wait for all async parsing to complete for this batch
          await Promise.all(parsePromises);
        });

        cb(null, sessions);
      } catch (error) {
        this.handleError(error as Error, cb);
      }
    };

    return optionalCb<{ [sid: string]: SessionData } | null>(fn, callback as any, this);
  }

  /**
   * Get session count
   */
  async length(): Promise<number>;
  async length(callback: (err: any, length?: number) => void): Promise<void>;
  async length(callback?: (err: any, length?: number) => void): Promise<number | void> {
    const fn = (cb: (err: any, length?: number) => void) => {
      const pattern = `${this.prefix}*`;

      this.scanKeys(pattern, (keys) => {
        cb(null, keys.length);
      })
      .catch((error) => {
        this.handleError(error, cb);
      });
    };

    return optionalCb<number>(fn, callback as any, this);
  }

  /**
   * Get all session IDs
   */
  async ids(): Promise<string[]>;
  async ids(callback: (err: any, ids?: string[]) => void): Promise<void>;
  async ids(callback?: (err: any, ids?: string[]) => void): Promise<string[] | void> {
    const fn = (cb: (err: any, ids?: string[]) => void) => {
      const pattern = `${this.prefix}*`;

      this.scanKeys(pattern, (keys) => {
        const sessionIds = keys.map(key => key.replace(this.prefix, ''));
        cb(null, sessionIds);
      })
      .catch((error) => {
        this.handleError(error, cb);
      });
    };

    return optionalCb<string[]>(fn, callback as any, this);
  }

  /**
   * Clear all sessions
   */
  async clear(): Promise<void>;
  async clear(callback: (err?: any) => void): Promise<void>;
  async clear(callback?: (err?: any) => void): Promise<void> {
    const fn = (cb: (err?: any) => void) => {
      const pattern = `${this.prefix}*`;

      this.scanKeys(pattern, (keys) => {
        if (keys.length === 0) {
          cb();
          return;
        }

        this.client.del(keys)
          .then(() => cb())
          .catch((error) => {
            this.handleError(error, cb);
          });
      })
      .catch((error) => {
        this.handleError(error, cb);
      });
    };

    return optionalCb<void>(fn as any, callback as any, this) as Promise<void>;
  }

  /**
   * Get TTL for session
   */
  private getTTL(session: SessionData): number {
    if (this.disableTTL) {
      return -1; // Never expire
    }

    // Check if cookie has expires field (Date or string)
    if (session.cookie && session.cookie.expires) {
      const expires = session.cookie.expires instanceof Date
        ? session.cookie.expires
        : new Date(session.cookie.expires);
      const now = Date.now();
      const ttl = Math.floor((expires.getTime() - now) / 1000);
      return ttl > 0 ? ttl : 0;
    }

    // Fallback to maxAge
    if (session.cookie && session.cookie.maxAge) {
      return Math.floor(session.cookie.maxAge / 1000);
    }

    // Fallback to configured TTL
    return typeof this.ttl === 'function' ? this.ttl(session) : this.ttl;
  }

  /**
   * Scan for keys matching pattern (collects all keys)
   */
  private async scanKeys(pattern: string, onComplete: (keys: string[]) => void): Promise<void> {
    const keys: string[] = [];
    // Check if we're dealing with a cluster client
    const isCluster = this.client instanceof GlideClusterClient;
    let cursor: any = isCluster ? new ClusterScanCursor() : '0';

    do {
      const [nextCursor, scanKeys] = await this.client.scan(cursor, {
        match: pattern,
        count: this.scanCount
      });

      keys.push(...scanKeys.map(k => typeof k === 'string' ? k : k.toString()));
      cursor = nextCursor;

      // Handle both string (standalone) and ClusterScanCursor (cluster) types
    } while (!this.isCursorFinished(cursor));

    onComplete(keys);
  }

  /**
   * Scan and process keys in batches
   */
  private async scanAndProcessKeys(pattern: string, onBatch: (keys: string[]) => Promise<void>): Promise<void> {
    // Check if we're dealing with a cluster client
    const isCluster = this.client instanceof GlideClusterClient;
    let cursor: any = isCluster ? new ClusterScanCursor() : '0';

    do {
      const [nextCursor, scanKeys] = await this.client.scan(cursor, {
        match: pattern,
        count: this.scanCount
      });

      if (scanKeys.length > 0) {
        const keys = scanKeys.map(k => typeof k === 'string' ? k : k.toString());
        await onBatch(keys);
      }

      cursor = nextCursor;

      // Handle both string (standalone) and ClusterScanCursor (cluster) types
    } while (!this.isCursorFinished(cursor));
  }

  /**
   * Check if cursor is finished for both standalone and cluster modes
   */
  private isCursorFinished(cursor: any): boolean {
    // For cluster mode, cursor has isFinished method
    if (cursor && typeof cursor.isFinished === 'function') {
      return cursor.isFinished();
    }
    // For standalone mode, cursor is a string
    return cursor === '0' || cursor.toString() === '0';
  }



  /**
   * Load session (express-session compatibility)
   */
  load(sid: string, callback: (err: any, session?: SessionData) => void): void {
    // Same as get method but with different signature
    this.get(sid, (err: any, session?: SessionData | null) => {
      if (err) {
        callback(err);
      } else {
        callback(undefined, session || undefined);
      }
    });
  }

}

/**
 * Create Valkey store factory function (similar to connect-redis)
 */
export default function createValkeyStore(session: any): typeof ValkeyStore {
  return ValkeyStore;
}

// Export types and aliases
export { ValkeyStore as Store };