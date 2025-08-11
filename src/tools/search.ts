import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { QuotaManager } from '../utils/quota.js';
import { 
  YouTubeSearchParams, 
  YouTubeSearchResult, 
  YouTubeSearchSchema,
  QuotaExceededError
} from '../types.js';

export class YouTubeSearchTool {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private quotaManager: QuotaManager,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<YouTubeSearchResult> {
    // Validate input parameters
    const params = YouTubeSearchSchema.parse(args);
    
    this.logger.info(`Executing YouTube search for: "${params.query}"`);

    // Generate cache key
    const cacheKey = this.cache.getSearchKey(params.query, params);

    // Check cache first
    const cached = await this.cache.get<YouTubeSearchResult>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached search results for: "${params.query}"`);
      return cached;
    }

    // Check quota before making API call
    const operationCost = QuotaManager.getOperationCost('search');
    if (!this.quotaManager.canPerformOperation(operationCost)) {
      throw new QuotaExceededError('Insufficient quota for search operation');
    }

    // Optimize operation based on quota availability
    const optimizedMaxResults = this.quotaManager.optimizeOperation('search', params.maxResults);
    if (optimizedMaxResults === 0) {
      throw new QuotaExceededError('Cannot perform search operation due to quota constraints');
    }

    // Update params with optimized values
    const optimizedParams: YouTubeSearchParams = {
      ...params,
      maxResults: optimizedMaxResults
    };

    try {
      // Perform the search
      const result = await this.youtubeClient.searchVideos(optimizedParams);
      
      // Record quota usage
      await this.quotaManager.recordUsage(operationCost, 'search');
      
      // Cache the result
      await this.cache.set(cacheKey, result);
      
      this.logger.info(
        `Search completed for "${params.query}": ${result.videos.length} videos found`
      );

      // Add additional metadata to response
      const enrichedResult: YouTubeSearchResult & { 
        metadata?: { 
          quotaUsed: number; 
          cached: boolean; 
          optimized?: boolean; 
        } 
      } = {
        ...result,
        metadata: {
          quotaUsed: operationCost,
          cached: false,
          optimized: optimizedMaxResults !== params.maxResults
        }
      };

      return enrichedResult;

    } catch (error) {
      this.logger.error(`Search failed for "${params.query}":`, error);
      
      // If quota exceeded, try to return cached results even if expired
      if (error instanceof QuotaExceededError) {
        const expiredCache = await this.getCachedResultIgnoreExpiry(cacheKey);
        if (expiredCache) {
          this.logger.warn('Returning expired cache due to quota limits');
          return {
            ...expiredCache,
            metadata: {
              quotaUsed: 0,
              cached: true,
              expired: true
            }
          } as any;
        }
      }
      
      throw error;
    }
  }

  /**
   * Get cached result even if expired (fallback for quota limits)
   */
  private async getCachedResultIgnoreExpiry(_cacheKey: string): Promise<YouTubeSearchResult | null> {
    try {
      // This would require accessing the cache manager's internal storage
      // For now, return null - in production, implement expired cache retrieval
      return null;
    } catch (error) {
      this.logger.error('Failed to retrieve expired cache:', error);
      return null;
    }
  }

  /**
   * Get search suggestions based on query
   */
  async getSuggestions(query: string, limit: number = 5): Promise<string[]> {
    // Simple implementation - in production, use YouTube's autocomplete API
    const commonQueries = [
      'tutorial', 'review', 'how to', 'explained', 'guide',
      'tips', 'tricks', 'best', 'latest', 'news', 'analysis'
    ];

    const suggestions = commonQueries
      .filter(suggestion => suggestion.includes(query.toLowerCase()) || query.toLowerCase().includes(suggestion))
      .slice(0, limit);

    return suggestions;
  }

  /**
   * Advanced search with multiple filters
   */
  async advancedSearch(params: {
    query: string;
    channel?: string;
    duration?: { min?: number; max?: number };
    publishedRange?: { from: string; to: string };
    minViews?: number;
    maxResults?: number;
  }): Promise<YouTubeSearchResult> {
    let searchQuery = params.query;

    // Add channel filter
    if (params.channel) {
      searchQuery += ` channel:${params.channel}`;
    }

    // Construct YouTube search parameters
    const searchParams: YouTubeSearchParams = {
      query: searchQuery,
      maxResults: params.maxResults || 10,
      publishedAfter: params.publishedRange?.from,
      publishedBefore: params.publishedRange?.to,
      order: params.minViews ? 'viewCount' : 'relevance'
    };

    // Set duration filter
    if (params.duration) {
      if (params.duration.max && params.duration.max <= 4 * 60) {
        searchParams.videoDuration = 'short'; // 0-4 minutes
      } else if (params.duration.min && params.duration.min >= 20 * 60) {
        searchParams.videoDuration = 'long'; // 20+ minutes
      } else {
        searchParams.videoDuration = 'medium'; // 4-20 minutes
      }
    }

    const result = await this.execute(searchParams);

    // Post-process results if view count filter is specified
    if (params.minViews && result.videos) {
      result.videos = result.videos.filter(video => {
        const views = parseInt(video.viewCount || '0');
        return views >= params.minViews!;
      });
    }

    return result;
  }

  /**
   * Search for videos by topic with category filtering
   */
  async searchByTopic(topic: string, options: {
    category?: string;
    recency?: 'hour' | 'day' | 'week' | 'month' | 'year';
    quality?: 'high' | 'standard';
    maxResults?: number;
  } = {}): Promise<YouTubeSearchResult> {
    const searchParams: YouTubeSearchParams = {
      query: topic,
      maxResults: options.maxResults || 10,
      videoDefinition: options.quality || 'any'
    };

    // Set recency filter
    if (options.recency) {
      const now = new Date();
      let publishedAfter: Date;
      
      switch (options.recency) {
        case 'hour':
          publishedAfter = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case 'day':
          publishedAfter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
          publishedAfter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          publishedAfter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case 'year':
          publishedAfter = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
      }
      
      searchParams.publishedAfter = publishedAfter!.toISOString();
    }

    return this.execute(searchParams);
  }

  /**
   * Get trending searches (mock implementation)
   */
  async getTrendingSearches(): Promise<string[]> {
    // In production, this would connect to YouTube's trending search API
    // For now, return some common trending topics
    return [
      'AI news',
      'tech review',
      'tutorial',
      'music 2024',
      'gaming',
      'cooking',
      'fitness',
      'travel vlog',
      'movie trailer',
      'news today'
    ];
  }
}