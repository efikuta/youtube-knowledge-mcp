import { google, youtube_v3 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import {
  YouTubeVideo,
  YouTubeChannel,
  YouTubeComment,
  YouTubeTranscript,
  YouTubeSearchResult,
  VideoDetailsResult,
  TrendingVideosResult,
  ChannelSearchResult,
  YouTubeAPIError,
  QuotaExceededError,
  YouTubeSearchParams,
  GetVideoDetailsParams,
  GetTrendingVideosParams,
  SearchChannelsParams
} from './types.js';
import { Logger } from 'winston';
import axios from 'axios';

export class YouTubeClient {
  private youtube: youtube_v3.Youtube;
  private auth: GoogleAuth;
  private logger: Logger;
  private quotaUsed: number = 0;
  private dailyQuotaLimit: number;

  constructor(
    apiKey: string,
    logger: Logger,
    dailyQuotaLimit: number = 10000
  ) {
    this.auth = new GoogleAuth({
      credentials: {
        type: 'service_account',
        private_key: '',
        private_key_id: '',
        client_email: '',
        client_id: '',
        auth_uri: '',
        token_uri: '',
        project_id: ''
      }
    });

    this.youtube = google.youtube({
      version: 'v3',
      auth: apiKey
    });

    this.logger = logger;
    this.dailyQuotaLimit = dailyQuotaLimit;
  }

  /**
   * Search for videos on YouTube
   */
  async searchVideos(params: YouTubeSearchParams): Promise<YouTubeSearchResult> {
    try {
      this.checkQuota(100); // Search costs 100 quota units

      const searchResponse = await this.youtube.search.list({
        part: ['snippet'],
        q: params.query,
        type: ['video'],
        maxResults: params.maxResults,
        order: params.order,
        publishedAfter: params.publishedAfter,
        publishedBefore: params.publishedBefore,
        videoDuration: params.videoDuration,
        videoDefinition: params.videoDefinition,
        regionCode: params.regionCode,
        safeSearch: 'moderate'
      });

      this.quotaUsed += 100;
      this.logger.info(`YouTube search completed. Quota used: ${this.quotaUsed}`);

      if (!searchResponse.data.items) {
        return { videos: [], totalResults: 0 };
      }

      // Get detailed video information
      const videoIds = searchResponse.data.items
        .map(item => item.id?.videoId)
        .filter(Boolean) as string[];

      const videos = await this.getVideosByIds(videoIds);

      return {
        videos,
        totalResults: searchResponse.data.pageInfo?.totalResults || 0,
        nextPageToken: searchResponse.data.nextPageToken,
        prevPageToken: searchResponse.data.prevPageToken
      };

    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Get detailed information about a specific video
   */
  async getVideoDetails(params: GetVideoDetailsParams): Promise<VideoDetailsResult> {
    try {
      const videos = await this.getVideosByIds([params.videoId]);
      const video = videos[0];
      
      if (!video) {
        throw new YouTubeAPIError(`Video not found: ${params.videoId}`);
      }

      const result: VideoDetailsResult = { video };

      // Get transcript if requested
      if (params.includeTranscript) {
        try {
          result.transcript = await this.getVideoTranscript(params.videoId);
        } catch (error) {
          this.logger.warn(`Failed to get transcript for ${params.videoId}:`, error);
        }
      }

      // Get comments if requested
      if (params.includeComments) {
        try {
          result.comments = await this.getVideoComments(
            params.videoId,
            params.maxComments,
            params.commentsOrder
          );
        } catch (error) {
          this.logger.warn(`Failed to get comments for ${params.videoId}:`, error);
        }
      }

      return result;

    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Get trending videos
   */
  async getTrendingVideos(params: GetTrendingVideosParams): Promise<TrendingVideosResult> {
    try {
      this.checkQuota(1); // Videos.list costs 1 quota unit

      const response = await this.youtube.videos.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        chart: 'mostPopular',
        regionCode: params.region,
        maxResults: params.maxResults,
        videoCategoryId: params.category
      });

      this.quotaUsed += 1;

      const videos = this.mapVideosResponse(response.data.items || []);

      return {
        videos,
        category: params.category,
        region: params.region
      };

    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Search for channels
   */
  async searchChannels(params: SearchChannelsParams): Promise<ChannelSearchResult> {
    try {
      this.checkQuota(100); // Search costs 100 quota units

      const searchResponse = await this.youtube.search.list({
        part: ['snippet'],
        q: params.query,
        type: ['channel'],
        maxResults: params.maxResults,
        order: params.order
      });

      this.quotaUsed += 100;

      if (!searchResponse.data.items) {
        return { channels: [], totalResults: 0 };
      }

      const channelIds = searchResponse.data.items
        .map(item => item.id?.channelId)
        .filter(Boolean) as string[];

      let channels: YouTubeChannel[] = [];

      if (params.includeStats && channelIds.length > 0) {
        this.checkQuota(1); // Channels.list costs 1 quota unit
        
        const channelsResponse = await this.youtube.channels.list({
          part: ['snippet', 'statistics'],
          id: channelIds
        });

        this.quotaUsed += 1;
        channels = this.mapChannelsResponse(channelsResponse.data.items || []);
      } else {
        channels = searchResponse.data.items.map(item => ({
          id: item.id?.channelId || '',
          title: item.snippet?.title || '',
          description: item.snippet?.description || '',
          publishedAt: item.snippet?.publishedAt || '',
          thumbnails: item.snippet?.thumbnails || {}
        }));
      }

      return {
        channels,
        totalResults: searchResponse.data.pageInfo?.totalResults || 0,
        nextPageToken: searchResponse.data.nextPageToken
      };

    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Get video transcript using unofficial API (since YouTube doesn't provide official transcript API)
   */
  private async getVideoTranscript(videoId: string): Promise<YouTubeTranscript[]> {
    try {
      // This is a simplified implementation. In a real-world scenario,
      // you might want to use a library like youtube-transcript-api
      // or implement proper caption parsing
      
      const _response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      // This is a placeholder - real implementation would parse captions
      // For production, consider using youtube-transcript or similar libraries
      this.logger.info(`Transcript extraction for ${videoId} not fully implemented`);
      
      return [];
      
    } catch (error) {
      this.logger.error(`Failed to get transcript for video ${videoId}:`, error);
      throw new YouTubeAPIError(`Failed to get transcript: ${error}`);
    }
  }

  /**
   * Get video comments
   */
  private async getVideoComments(
    videoId: string,
    maxResults: number = 50,
    order: 'relevance' | 'time' = 'relevance'
  ): Promise<YouTubeComment[]> {
    try {
      this.checkQuota(1); // CommentThreads.list costs 1 quota unit

      const response = await this.youtube.commentThreads.list({
        part: ['snippet'],
        videoId: videoId,
        maxResults: Math.min(maxResults, 100),
        order: order,
        textFormat: 'plainText'
      });

      this.quotaUsed += 1;

      const comments: YouTubeComment[] = [];
      
      response.data.items?.forEach(item => {
        const comment = item.snippet?.topLevelComment?.snippet;
        if (comment) {
          comments.push({
            id: item.snippet?.topLevelComment?.id || '',
            authorDisplayName: comment.authorDisplayName || '',
            authorChannelId: comment.authorChannelId?.value,
            textDisplay: comment.textDisplay || '',
            textOriginal: comment.textOriginal || '',
            likeCount: comment.likeCount || 0,
            publishedAt: comment.publishedAt || '',
            updatedAt: comment.updatedAt || ''
          });
        }
      });

      return comments;

    } catch (error) {
      this.logger.error(`Failed to get comments for video ${videoId}:`, error);
      throw new YouTubeAPIError(`Failed to get comments: ${error}`);
    }
  }

  /**
   * Get videos by their IDs
   */
  private async getVideosByIds(videoIds: string[]): Promise<YouTubeVideo[]> {
    if (videoIds.length === 0) return [];

    this.checkQuota(1); // Videos.list costs 1 quota unit per request

    const response = await this.youtube.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      id: videoIds
    });

    this.quotaUsed += 1;

    return this.mapVideosResponse(response.data.items || []);
  }

  /**
   * Map YouTube API video response to our video interface
   */
  private mapVideosResponse(items: youtube_v3.Schema$Video[]): YouTubeVideo[] {
    return items.map(item => ({
      id: item.id || '',
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      channelId: item.snippet?.channelId || '',
      channelTitle: item.snippet?.channelTitle || '',
      publishedAt: item.snippet?.publishedAt || '',
      thumbnails: item.snippet?.thumbnails || {},
      duration: item.contentDetails?.duration,
      viewCount: item.statistics?.viewCount,
      likeCount: item.statistics?.likeCount,
      commentCount: item.statistics?.commentCount,
      tags: item.snippet?.tags,
      categoryId: item.snippet?.categoryId
    }));
  }

  /**
   * Map YouTube API channel response to our channel interface
   */
  private mapChannelsResponse(items: youtube_v3.Schema$Channel[]): YouTubeChannel[] {
    return items.map(item => ({
      id: item.id || '',
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      subscriberCount: item.statistics?.subscriberCount,
      videoCount: item.statistics?.videoCount,
      viewCount: item.statistics?.viewCount,
      publishedAt: item.snippet?.publishedAt || '',
      thumbnails: item.snippet?.thumbnails || {},
      country: item.snippet?.country
    }));
  }

  /**
   * Check if we have enough quota for the operation
   */
  private checkQuota(cost: number): void {
    if (this.quotaUsed + cost > this.dailyQuotaLimit) {
      throw new QuotaExceededError(`Operation would exceed daily quota limit. Used: ${this.quotaUsed}, Cost: ${cost}, Limit: ${this.dailyQuotaLimit}`);
    }
  }

  /**
   * Handle API errors and convert them to our custom error types
   */
  private handleError(error: any): void {
    if (error.response?.status === 403) {
      if (error.response.data?.error?.message?.includes('quota')) {
        throw new QuotaExceededError(error.response.data.error.message);
      }
    }
    
    if (error.response?.status === 400) {
      throw new YouTubeAPIError(`Bad request: ${error.response.data?.error?.message || error.message}`, 400);
    }

    if (error.response?.status === 404) {
      throw new YouTubeAPIError(`Resource not found: ${error.response.data?.error?.message || error.message}`, 404);
    }

    this.logger.error('YouTube API error:', error);
  }

  /**
   * Get current quota usage
   */
  getQuotaUsage(): { used: number; limit: number; remaining: number } {
    return {
      used: this.quotaUsed,
      limit: this.dailyQuotaLimit,
      remaining: this.dailyQuotaLimit - this.quotaUsed
    };
  }

  /**
   * Reset quota usage (typically called daily)
   */
  resetQuota(): void {
    this.quotaUsed = 0;
    this.logger.info('YouTube API quota usage reset');
  }
}