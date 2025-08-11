import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { QuotaManager } from '../utils/quota.js';
import { 
  SearchChannelsParams, 
  ChannelSearchResult, 
  SearchChannelsSchema,
  QuotaExceededError
} from '../types.js';

export class ChannelSearchTool {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private quotaManager: QuotaManager,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<ChannelSearchResult & {
    metadata?: {
      quotaUsed: number;
      cached: boolean;
      analysis?: {
        categoryDistribution: Record<string, number>;
        subscriberRanges: Record<string, number>;
        avgVideosPerChannel: number;
        topPerformers: Array<{
          name: string;
          subscribers: number;
          videos: number;
        }>;
      };
    };
  }> {
    // Validate input parameters
    const params = SearchChannelsSchema.parse(args);
    
    this.logger.info(`Searching channels for: "${params.query}"`);

    // Generate cache key
    const cacheKey = `channels:${Buffer.from(JSON.stringify(params)).toString('base64')}`;

    // Check cache first
    const cached = await this.cache.get<ChannelSearchResult>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached channel search results for: "${params.query}"`);
      return {
        ...cached,
        metadata: {
          quotaUsed: 0,
          cached: true
        }
      };
    }

    // Check quota before making API call
    const operationCost = QuotaManager.getOperationCost('channel_search');
    if (!this.quotaManager.canPerformOperation(operationCost)) {
      throw new QuotaExceededError('Insufficient quota for channel search operation');
    }

    // Optimize operation based on quota availability
    const optimizedMaxResults = this.quotaManager.optimizeOperation('channel_search', params.maxResults);
    if (optimizedMaxResults === 0) {
      throw new QuotaExceededError('Cannot perform channel search due to quota constraints');
    }

    const optimizedParams: SearchChannelsParams = {
      ...params,
      maxResults: optimizedMaxResults
    };

    try {
      // Perform the channel search
      const result = await this.youtubeClient.searchChannels(optimizedParams);
      
      // Record quota usage
      await this.quotaManager.recordUsage(operationCost, 'channel_search');
      
      // Add additional cost if we fetched detailed stats
      if (params.includeStats) {
        const additionalCost = Math.ceil(result.channels.length / 50); // 1 unit per 50 channels
        await this.quotaManager.recordUsage(additionalCost, 'channel_details');
      }

      // Enhance the result with analysis
      const enhancedResult = await this.enhanceChannelResults(result);
      
      // Cache the result
      await this.cache.set(cacheKey, enhancedResult);
      
      this.logger.info(
        `Channel search completed for "${params.query}": ${result.channels.length} channels found`
      );

      return {
        ...enhancedResult,
        metadata: {
          quotaUsed: operationCost + (params.includeStats ? Math.ceil(result.channels.length / 50) : 0),
          cached: false,
          analysis: this.analyzeChannelData(result.channels)
        }
      };

    } catch (error) {
      this.logger.error(`Channel search failed for "${params.query}":`, error);
      
      // Try fallback strategies if quota exceeded
      if (error instanceof QuotaExceededError) {
        const fallbackResults = await this.getFallbackChannelData(params.query);
        if (fallbackResults) {
          this.logger.warn('Returning fallback channel data due to quota limits');
          return {
            ...fallbackResults,
            metadata: {
              quotaUsed: 0,
              cached: true,
              fallback: true
            }
          } as any;
        }
      }
      
      throw error;
    }
  }

  /**
   * Enhance channel search results with additional metadata and analysis
   */
  private async enhanceChannelResults(result: ChannelSearchResult): Promise<ChannelSearchResult> {
    // Add ranking based on multiple factors
    const enhancedChannels = result.channels.map((channel, index) => {
      const subscribers = parseInt(channel.subscriberCount || '0');
      const videoCount = parseInt(channel.videoCount || '0');
      const totalViews = parseInt(channel.viewCount || '0');

      // Calculate engagement score
      const avgViewsPerVideo = videoCount > 0 ? totalViews / videoCount : 0;
      const subscriberEngagement = subscribers > 0 ? avgViewsPerVideo / subscribers : 0;

      return {
        ...channel,
        metadata: {
          rank: index + 1,
          engagementScore: Number((subscriberEngagement * 100).toFixed(2)),
          avgViewsPerVideo: Math.round(avgViewsPerVideo),
          category: this.categorizeChannel(channel),
          growthIndicators: this.assessChannelGrowth(channel)
        }
      };
    });

    // Sort by engagement score for better results
    enhancedChannels.sort((a, b) => (b.metadata?.engagementScore || 0) - (a.metadata?.engagementScore || 0));

    return {
      ...result,
      channels: enhancedChannels as any
    };
  }

  /**
   * Analyze channel data to provide insights
   */
  private analyzeChannelData(channels: any[]): {
    categoryDistribution: Record<string, number>;
    subscriberRanges: Record<string, number>;
    avgVideosPerChannel: number;
    topPerformers: Array<{
      name: string;
      subscribers: number;
      videos: number;
    }>;
  } {
    const categoryDistribution: Record<string, number> = {};
    const subscriberRanges: Record<string, number> = {
      '0-1K': 0,
      '1K-10K': 0,
      '10K-100K': 0,
      '100K-1M': 0,
      '1M+': 0
    };

    let totalVideos = 0;
    const topPerformers = [];

    channels.forEach(channel => {
      // Categorize channel
      const category = this.categorizeChannel(channel);
      categoryDistribution[category] = (categoryDistribution[category] || 0) + 1;

      // Categorize by subscriber count
      const subscribers = parseInt(channel.subscriberCount || '0');
      if (subscribers >= 1000000) subscriberRanges['1M+']++;
      else if (subscribers >= 100000) subscriberRanges['100K-1M']++;
      else if (subscribers >= 10000) subscriberRanges['10K-100K']++;
      else if (subscribers >= 1000) subscriberRanges['1K-10K']++;
      else subscriberRanges['0-1K']++;

      // Count videos
      const videos = parseInt(channel.videoCount || '0');
      totalVideos += videos;

      // Add to top performers
      topPerformers.push({
        name: channel.title,
        subscribers,
        videos
      });
    });

    // Sort top performers and take top 5
    topPerformers.sort((a, b) => b.subscribers - a.subscribers);
    const topFive = topPerformers.slice(0, 5);

    return {
      categoryDistribution,
      subscriberRanges,
      avgVideosPerChannel: channels.length > 0 ? Math.round(totalVideos / channels.length) : 0,
      topPerformers: topFive
    };
  }

  /**
   * Categorize channel based on title and description
   */
  private categorizeChannel(channel: any): string {
    const text = `${channel.title} ${channel.description}`.toLowerCase();

    const categories = {
      'gaming': ['gaming', 'game', 'gameplay', 'streamer', 'twitch', 'esports'],
      'tech': ['tech', 'technology', 'programming', 'coding', 'software', 'hardware'],
      'education': ['education', 'tutorial', 'learn', 'course', 'teaching', 'school'],
      'entertainment': ['entertainment', 'comedy', 'funny', 'prank', 'reaction'],
      'music': ['music', 'song', 'artist', 'band', 'musician', 'singer'],
      'lifestyle': ['lifestyle', 'vlog', 'daily', 'life', 'personal', 'family'],
      'news': ['news', 'politics', 'current', 'events', 'breaking', 'media'],
      'business': ['business', 'entrepreneur', 'startup', 'finance', 'money'],
      'health': ['health', 'fitness', 'workout', 'nutrition', 'medical', 'wellness'],
      'travel': ['travel', 'adventure', 'explore', 'trip', 'journey', 'vacation']
    };

    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => text.includes(keyword))) {
        return category;
      }
    }

    return 'general';
  }

  /**
   * Assess channel growth indicators
   */
  private assessChannelGrowth(channel: any): {
    likely_growing: boolean;
    activity_level: 'high' | 'medium' | 'low';
    consistency_score: number;
  } {
    const videoCount = parseInt(channel.videoCount || '0');
    const subscribers = parseInt(channel.subscriberCount || '0');
    
    // Simple heuristics for growth assessment
    const videosPerSubscriber = subscribers > 0 ? videoCount / subscribers : 0;
    const likely_growing = videosPerSubscriber < 0.01 && subscribers > 1000; // Many subs, fewer videos = potential for growth

    let activity_level: 'high' | 'medium' | 'low' = 'low';
    if (videoCount > 100) activity_level = 'high';
    else if (videoCount > 20) activity_level = 'medium';

    // Consistency score (placeholder - would need upload frequency data)
    const consistency_score = Math.min(100, videoCount / 10); // Simple metric

    return {
      likely_growing,
      activity_level,
      consistency_score: Number(consistency_score.toFixed(0))
    };
  }

  /**
   * Advanced channel search with filters
   */
  async advancedChannelSearch(params: {
    query: string;
    minSubscribers?: number;
    maxSubscribers?: number;
    category?: string;
    country?: string;
    sortBy?: 'subscribers' | 'videos' | 'relevance';
    maxResults?: number;
  }): Promise<ChannelSearchResult> {
    // First get basic results
    let searchQuery = params.query;
    
    // Add category to search if specified
    if (params.category) {
      searchQuery += ` ${params.category}`;
    }

    const result = await this.execute({
      query: searchQuery,
      maxResults: params.maxResults || 20,
      includeStats: true,
      order: 'relevance'
    });

    // Filter by subscriber count if specified
    if (params.minSubscribers || params.maxSubscribers) {
      result.channels = result.channels.filter(channel => {
        const subscribers = parseInt(channel.subscriberCount || '0');
        if (params.minSubscribers && subscribers < params.minSubscribers) return false;
        if (params.maxSubscribers && subscribers > params.maxSubscribers) return false;
        return true;
      });
    }

    // Filter by country if specified
    if (params.country) {
      result.channels = result.channels.filter(channel => 
        channel.country === params.country
      );
    }

    // Sort results if specified
    if (params.sortBy) {
      result.channels.sort((a, b) => {
        switch (params.sortBy) {
          case 'subscribers':
            return parseInt(b.subscriberCount || '0') - parseInt(a.subscriberCount || '0');
          case 'videos':
            return parseInt(b.videoCount || '0') - parseInt(a.videoCount || '0');
          default:
            return 0; // Keep original relevance order
        }
      });
    }

    return result;
  }

  /**
   * Get channel recommendations based on a seed channel
   */
  async getChannelRecommendations(channelId: string, maxResults: number = 10): Promise<{
    seedChannel: any;
    recommendations: any[];
    reasoning: string[];
  }> {
    try {
      // Get details of the seed channel first
      const seedChannelResult = await this.youtubeClient.searchChannels({
        query: channelId, // This is simplified - in reality you'd get channel by ID
        maxResults: 1,
        includeStats: true
      });

      if (seedChannelResult.channels.length === 0) {
        throw new Error('Seed channel not found');
      }

      const seedChannel = seedChannelResult.channels[0];
      const category = this.categorizeChannel(seedChannel);
      
      // Search for similar channels
      const similarChannels = await this.execute({
        query: `${category} ${seedChannel.title.split(' ').slice(-2).join(' ')}`, // Use last 2 words of title
        maxResults,
        includeStats: true,
        order: 'relevance'
      });

      // Filter out the seed channel and rank by similarity
      const recommendations = similarChannels.channels
        .filter(channel => channel.id !== seedChannel.id)
        .slice(0, maxResults);

      const reasoning = [
        `Channels in the same category: ${category}`,
        `Similar subscriber count range`,
        `Related content based on title keywords`,
        `Active channels with recent uploads`
      ];

      return {
        seedChannel,
        recommendations,
        reasoning
      };

    } catch (error) {
      this.logger.error(`Failed to get channel recommendations for ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Get trending channels in a specific category
   */
  async getTrendingChannels(category: string, region: string = 'US'): Promise<{
    category: string;
    region: string;
    channels: any[];
    insights: {
      avgGrowthRate: number;
      popularContentTypes: string[];
      emergingTrends: string[];
    };
  }> {
    const result = await this.execute({
      query: `trending ${category} channels 2024`,
      maxResults: 20,
      includeStats: true,
      order: 'relevance'
    });

    // Analyze trends
    const insights = {
      avgGrowthRate: 0, // Placeholder - would need historical data
      popularContentTypes: this.extractContentTypes(result.channels),
      emergingTrends: this.identifyEmergingTrends(result.channels)
    };

    return {
      category,
      region,
      channels: result.channels,
      insights
    };
  }

  /**
   * Get fallback channel data from cache
   */
  private async getFallbackChannelData(query: string): Promise<ChannelSearchResult | null> {
    try {
      // Try to find similar cached queries
      const fallbackQueries = [
        query,
        query.split(' ')[0], // First word only
        'popular channels', // Generic fallback
      ];

      for (const fallbackQuery of fallbackQueries) {
        const fallbackKey = `channels:${Buffer.from(JSON.stringify({ query: fallbackQuery })).toString('base64')}`;
        const cached = await this.cache.get<ChannelSearchResult>(fallbackKey);
        if (cached) {
          return cached;
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Failed to get fallback channel data:', error);
      return null;
    }
  }

  // Helper methods
  private extractContentTypes(channels: any[]): string[] {
    const types = channels.map(channel => this.categorizeChannel(channel));
    const typeCount: Record<string, number> = {};
    types.forEach(type => {
      typeCount[type] = (typeCount[type] || 0) + 1;
    });

    return Object.entries(typeCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([type]) => type);
  }

  private identifyEmergingTrends(channels: any[]): string[] {
    // Simple trend identification based on common words in channel descriptions
    const allDescriptions = channels
      .map(channel => channel.description)
      .join(' ')
      .toLowerCase();

    const trendWords = allDescriptions
      .split(/\s+/)
      .filter(word => word.length > 4)
      .filter(word => !this.isStopWord(word));

    const wordCount: Record<string, number> = {};
    trendWords.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });

    return Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([word]) => word);
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have',
      'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you'
    ]);
    return stopWords.has(word.toLowerCase());
  }
}