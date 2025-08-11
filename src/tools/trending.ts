import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { QuotaManager } from '../utils/quota.js';
import { 
  GetTrendingVideosParams, 
  TrendingVideosResult, 
  GetTrendingVideosSchema,
  QuotaExceededError
} from '../types.js';

export class TrendingVideosTool {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private quotaManager: QuotaManager,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<TrendingVideosResult> {
    // Validate input parameters
    const params = GetTrendingVideosSchema.parse(args);
    
    this.logger.info(`Getting trending videos for region: ${params.region}, category: ${params.category || 'all'}`);

    // Generate cache key
    const cacheKey = this.cache.getTrendingKey(params.region, params.category);

    // Check cache first
    const cached = await this.cache.get<TrendingVideosResult>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached trending videos for region: ${params.region}`);
      return cached;
    }

    // Check quota before making API call
    const operationCost = QuotaManager.getOperationCost('trending');
    if (!this.quotaManager.canPerformOperation(operationCost)) {
      throw new QuotaExceededError('Insufficient quota for trending videos operation');
    }

    // Optimize operation based on quota availability
    const optimizedMaxResults = this.quotaManager.optimizeOperation('trending', params.maxResults);
    if (optimizedMaxResults === 0) {
      throw new QuotaExceededError('Cannot perform trending operation due to quota constraints');
    }

    const optimizedParams: GetTrendingVideosParams = {
      ...params,
      maxResults: optimizedMaxResults
    };

    try {
      // Get trending videos from YouTube API
      const result = await this.youtubeClient.getTrendingVideos(optimizedParams);
      
      // Record quota usage
      await this.quotaManager.recordUsage(operationCost, 'trending');
      
      // Enhance the result with additional metadata
      const enhancedResult = await this.enhanceTrendingData(result);
      
      // Cache the result (trending data changes frequently, so shorter TTL)
      await this.cache.set(cacheKey, enhancedResult, 1800); // 30 minutes TTL
      
      this.logger.info(`Retrieved ${result.videos.length} trending videos for region: ${params.region}`);
      
      return enhancedResult;

    } catch (error) {
      this.logger.error(`Failed to get trending videos for region ${params.region}:`, error);
      
      // Try to return cached data if quota exceeded
      if (error instanceof QuotaExceededError) {
        const fallbackCache = await this.getFallbackTrendingData(params.region);
        if (fallbackCache) {
          this.logger.warn('Returning fallback trending data due to quota limits');
          return fallbackCache;
        }
      }
      
      throw error;
    }
  }

  /**
   * Enhance trending data with additional analysis and metadata
   */
  private async enhanceTrendingData(result: TrendingVideosResult): Promise<TrendingVideosResult> {
    const enhanced = { ...result };

    // Add trending analysis
    const analysis = this.analyzeTrendingPatterns(result.videos);
    
    return {
      ...enhanced,
      analysis,
      metadata: {
        retrievedAt: new Date().toISOString(),
        totalVideos: result.videos.length,
        categories: this.getUniqueCategories(result.videos),
        avgViews: this.calculateAverageViews(result.videos),
        topChannels: this.getTopChannels(result.videos)
      }
    } as any;
  }

  /**
   * Analyze patterns in trending videos
   */
  private analyzeTrendingPatterns(videos: any[]): {
    popularTopics: string[];
    avgDuration: string;
    mostActiveChannels: Array<{ name: string; videoCount: number }>;
    viewDistribution: { min: number; max: number; avg: number };
    publishTimePatterns: Record<string, number>;
  } {
    if (videos.length === 0) {
      return {
        popularTopics: [],
        avgDuration: '0',
        mostActiveChannels: [],
        viewDistribution: { min: 0, max: 0, avg: 0 },
        publishTimePatterns: {}
      };
    }

    // Extract topics from titles and descriptions
    const allText = videos
      .map(video => `${video.title} ${video.description}`)
      .join(' ')
      .toLowerCase();
    
    const words = allText.split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !this.isStopWord(word));

    const wordCount: Record<string, number> = {};
    words.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });

    const popularTopics = Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([word]) => word);

    // Calculate average duration (simplified)
    const avgDurationMs = videos.reduce((sum, video) => {
      // Parse ISO 8601 duration (PT1H2M3S format)
      const duration = video.duration || 'PT0S';
      const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const hours = parseInt(match[1] || '0');
        const minutes = parseInt(match[2] || '0');
        const seconds = parseInt(match[3] || '0');
        return sum + (hours * 3600 + minutes * 60 + seconds);
      }
      return sum;
    }, 0) / videos.length;

    const avgDuration = this.formatDuration(Math.round(avgDurationMs));

    // Find most active channels
    const channelCount: Record<string, number> = {};
    videos.forEach(video => {
      channelCount[video.channelTitle] = (channelCount[video.channelTitle] || 0) + 1;
    });

    const mostActiveChannels = Object.entries(channelCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, videoCount]) => ({ name, videoCount }));

    // View distribution
    const views = videos.map(video => parseInt(video.viewCount || '0'));
    const viewDistribution = {
      min: Math.min(...views),
      max: Math.max(...views),
      avg: Math.round(views.reduce((sum, v) => sum + v, 0) / views.length)
    };

    // Publish time patterns (hour of day)
    const publishTimePatterns: Record<string, number> = {};
    videos.forEach(video => {
      const hour = new Date(video.publishedAt).getHours();
      const hourRange = `${hour}:00-${hour + 1}:00`;
      publishTimePatterns[hourRange] = (publishTimePatterns[hourRange] || 0) + 1;
    });

    return {
      popularTopics,
      avgDuration,
      mostActiveChannels,
      viewDistribution,
      publishTimePatterns
    };
  }

  /**
   * Get trending videos by category
   */
  async getTrendingByCategory(
    category: string, 
    region: string = 'US', 
    maxResults: number = 25
  ): Promise<TrendingVideosResult> {
    // Map common category names to YouTube category IDs
    const categoryMap: Record<string, string> = {
      'music': '10',
      'gaming': '20',
      'entertainment': '24',
      'news': '25',
      'education': '27',
      'science': '28',
      'technology': '28',
      'sports': '17',
      'travel': '19',
      'comedy': '23'
    };

    const categoryId = categoryMap[category.toLowerCase()] || category;

    return this.execute({
      category: categoryId,
      region,
      maxResults
    });
  }

  /**
   * Get trending videos from multiple regions
   */
  async getGlobalTrending(regions: string[] = ['US', 'GB', 'CA', 'AU']): Promise<{
    byRegion: Record<string, TrendingVideosResult>;
    globalTrends: {
      commonVideos: any[];
      regionalDifferences: Record<string, string[]>;
    };
  }> {
    const results: Record<string, TrendingVideosResult> = {};
    
    // Get trending videos for each region
    for (const region of regions) {
      try {
        results[region] = await this.execute({
          region,
          maxResults: 10
        });
      } catch (error) {
        this.logger.warn(`Failed to get trending videos for ${region}:`, error);
      }
    }

    // Analyze global trends
    const allVideos = Object.values(results).flatMap(result => result.videos);
    const videoMap = new Map();
    
    allVideos.forEach(video => {
      if (videoMap.has(video.id)) {
        videoMap.get(video.id).regions.push(video.region || 'unknown');
      } else {
        videoMap.set(video.id, { 
          ...video, 
          regions: [video.region || 'unknown'] 
        });
      }
    });

    const commonVideos = Array.from(videoMap.values())
      .filter(video => video.regions.length > 1)
      .sort((a, b) => b.regions.length - a.regions.length);

    // Find regional differences
    const regionalDifferences: Record<string, string[]> = {};
    regions.forEach(region => {
      if (results[region]) {
        const uniqueToRegion = results[region].videos
          .filter(video => !commonVideos.some(common => common.id === video.id))
          .map(video => video.title);
        regionalDifferences[region] = uniqueToRegion.slice(0, 5);
      }
    });

    return {
      byRegion: results,
      globalTrends: {
        commonVideos: commonVideos.slice(0, 10),
        regionalDifferences
      }
    };
  }

  /**
   * Get fallback trending data from cache (even if expired)
   */
  private async getFallbackTrendingData(region: string): Promise<TrendingVideosResult | null> {
    try {
      // Try different cache keys as fallback
      const fallbackKeys = [
        this.cache.getTrendingKey(region),
        this.cache.getTrendingKey('US'), // Fallback to US
        this.cache.getTrendingKey('GB')  // Fallback to GB
      ];

      for (const key of fallbackKeys) {
        const cached = await this.cache.get<TrendingVideosResult>(key);
        if (cached) {
          return {
            ...cached,
            metadata: {
              ...((cached as any).metadata || {}),
              fallback: true,
              originalRegion: region
            }
          } as any;
        }
      }
      
      return null;
    } catch (error) {
      this.logger.error('Failed to get fallback trending data:', error);
      return null;
    }
  }

  /**
   * Helper methods
   */
  private getUniqueCategories(videos: any[]): string[] {
    const categories = videos
      .map(video => video.categoryId)
      .filter(Boolean);
    return [...new Set(categories)];
  }

  private calculateAverageViews(videos: any[]): number {
    const totalViews = videos.reduce((sum, video) => {
      return sum + parseInt(video.viewCount || '0');
    }, 0);
    return Math.round(totalViews / videos.length);
  }

  private getTopChannels(videos: any[]): Array<{ name: string; videoCount: number }> {
    const channelCount: Record<string, number> = {};
    videos.forEach(video => {
      channelCount[video.channelTitle] = (channelCount[video.channelTitle] || 0) + 1;
    });

    return Object.entries(channelCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, videoCount]) => ({ name, videoCount }));
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have',
      'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you',
      'do', 'at', 'this', 'but', 'his', 'by', 'from'
    ]);
    
    return stopWords.has(word.toLowerCase());
  }
}