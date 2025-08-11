import Redis from 'ioredis';
import { Logger } from 'winston';
import { CacheEntry } from '../types.js';

export interface CacheConfig {
  redis?: {
    host: string;
    port: number;
    password?: string;
  };
  ttl: {
    transcripts: number;
    videoDetails: number;
    searchResults: number;
    comments: number;
  };
}

export class CacheManager {
  private redis?: Redis;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private logger: Logger;
  private config: CacheConfig;
  private useRedis: boolean = false;

  constructor(config: CacheConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    if (config.redis) {
      try {
        this.redis = new Redis({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3,
          lazyConnect: true
        });

        this.redis.on('connect', () => {
          this.useRedis = true;
          this.logger.info('Connected to Redis cache');
        });

        this.redis.on('error', (err) => {
          this.logger.error('Redis error:', err);
          this.useRedis = false;
        });

      } catch (error) {
        this.logger.warn('Failed to initialize Redis, falling back to memory cache:', error);
        this.useRedis = false;
      }
    }

    // Clean up memory cache every 5 minutes
    setInterval(() => {
      this.cleanupMemoryCache();
    }, 5 * 60 * 1000);
  }

  /**
   * Get a value from cache
   */
  async get<T = any>(key: string): Promise<T | null> {
    try {
      if (this.useRedis && this.redis) {
        const cached = await this.redis.get(key);
        if (cached) {
          const entry: CacheEntry<T> = JSON.parse(cached);
          if (this.isExpired(entry)) {
            await this.redis.del(key);
            return null;
          }
          return entry.data;
        }
      } else {
        const entry = this.memoryCache.get(key);
        if (entry) {
          if (this.isExpired(entry)) {
            this.memoryCache.delete(key);
            return null;
          }
          return entry.data as T;
        }
      }
      return null;
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set a value in cache
   */
  async set<T = any>(key: string, data: T, ttl?: number): Promise<void> {
    try {
      const cacheEntry: CacheEntry<T> = {
        data,
        timestamp: Date.now(),
        ttl: ttl || this.getDefaultTTL(key)
      };

      if (this.useRedis && this.redis) {
        await this.redis.setex(key, cacheEntry.ttl, JSON.stringify(cacheEntry));
      } else {
        this.memoryCache.set(key, cacheEntry);
      }

      this.logger.debug(`Cached data for key: ${key}`);
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}:`, error);
    }
  }

  /**
   * Delete a value from cache
   */
  async del(key: string): Promise<void> {
    try {
      if (this.useRedis && this.redis) {
        await this.redis.del(key);
      } else {
        this.memoryCache.delete(key);
      }
    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      if (this.useRedis && this.redis) {
        await this.redis.flushdb();
      } else {
        this.memoryCache.clear();
      }
      this.logger.info('Cache cleared');
    } catch (error) {
      this.logger.error('Cache clear error:', error);
    }
  }

  /**
   * Get cache key for video details
   */
  getVideoDetailsKey(videoId: string, includeTranscript: boolean = false, includeComments: boolean = false): string {
    return `video:${videoId}:${includeTranscript ? 'transcript' : 'basic'}:${includeComments ? 'comments' : 'no-comments'}`;
  }

  /**
   * Get cache key for search results
   */
  getSearchKey(query: string, params: any): string {
    const paramsString = JSON.stringify(params);
    return `search:${Buffer.from(query + paramsString).toString('base64')}`;
  }

  /**
   * Get cache key for trending videos
   */
  getTrendingKey(region: string, category?: string): string {
    return `trending:${region}:${category || 'all'}`;
  }

  /**
   * Get cache key for channel details
   */
  getChannelKey(channelId: string): string {
    return `channel:${channelId}`;
  }

  /**
   * Get cache key for video transcript
   */
  getTranscriptKey(videoId: string): string {
    return `transcript:${videoId}`;
  }

  /**
   * Get cache key for video comments
   */
  getCommentsKey(videoId: string, maxResults: number, order: string): string {
    return `comments:${videoId}:${maxResults}:${order}`;
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttl * 1000;
  }

  /**
   * Get default TTL based on key type
   */
  private getDefaultTTL(key: string): number {
    if (key.startsWith('transcript:')) {
      return this.config.ttl.transcripts;
    } else if (key.startsWith('video:')) {
      return this.config.ttl.videoDetails;
    } else if (key.startsWith('search:')) {
      return this.config.ttl.searchResults;
    } else if (key.startsWith('comments:')) {
      return this.config.ttl.comments;
    } else if (key.startsWith('trending:')) {
      return this.config.ttl.searchResults; // Use same TTL as search results
    } else if (key.startsWith('channel:')) {
      return this.config.ttl.videoDetails; // Use same TTL as video details
    }
    return 3600; // Default 1 hour
  }

  /**
   * Clean up expired entries from memory cache
   */
  private cleanupMemoryCache(): void {
    let cleaned = 0;
    for (const [key, entry] of this.memoryCache.entries()) {
      if (this.isExpired(entry)) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { memoryEntries: number; redisConnected: boolean } {
    return {
      memoryEntries: this.memoryCache.size,
      redisConnected: this.useRedis
    };
  }

  /**
   * Close cache connections
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}