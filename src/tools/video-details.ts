import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { QuotaManager } from '../utils/quota.js';
import { TranscriptProcessor } from '../utils/transcript.js';
import { 
  GetVideoDetailsParams, 
  VideoDetailsResult, 
  GetVideoDetailsSchema,
  QuotaExceededError,
  YouTubeTranscript
} from '../types.js';

export class VideoDetailsTool {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private quotaManager: QuotaManager,
    private transcriptProcessor: TranscriptProcessor,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<VideoDetailsResult> {
    // Validate input parameters
    const params = GetVideoDetailsSchema.parse(args);
    
    this.logger.info(`Getting video details for: ${params.videoId}`);

    // Generate cache key
    const cacheKey = this.cache.getVideoDetailsKey(
      params.videoId, 
      params.includeTranscript, 
      params.includeComments
    );

    // Check cache first
    const cached = await this.cache.get<VideoDetailsResult>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached video details for: ${params.videoId}`);
      return cached;
    }

    // Check quota before making API call
    const operationCost = this.calculateOperationCost(params);
    if (!this.quotaManager.canPerformOperation(operationCost)) {
      throw new QuotaExceededError('Insufficient quota for video details operation');
    }

    try {
      // Get video details from YouTube API
      const result = await this.youtubeClient.getVideoDetails(params);
      
      // Record quota usage
      await this.quotaManager.recordUsage(operationCost, 'video_details');
      
      // Enhance the result with additional processing
      const enhancedResult = await this.enhanceVideoDetails(result, params);
      
      // Cache the result
      await this.cache.set(cacheKey, enhancedResult);
      
      this.logger.info(`Video details retrieved for: ${params.videoId}`);
      
      return enhancedResult;

    } catch (error) {
      this.logger.error(`Failed to get video details for ${params.videoId}:`, error);
      
      // Try to return partial cached data if quota exceeded
      if (error instanceof QuotaExceededError) {
        const partialCache = await this.getPartialCachedData(params.videoId);
        if (partialCache) {
          this.logger.warn('Returning partial cached data due to quota limits');
          return partialCache;
        }
      }
      
      throw error;
    }
  }

  /**
   * Calculate the quota cost for the operation based on what data is requested
   */
  private calculateOperationCost(params: GetVideoDetailsParams): number {
    let cost = 1; // Base cost for video details
    
    if (params.includeComments) {
      cost += 1; // Additional cost for comments
    }
    
    // Note: Transcript extraction doesn't use YouTube API quota
    // as it uses web scraping (though this has its own limitations)
    
    return cost;
  }

  /**
   * Enhance video details with additional processing and analysis
   */
  private async enhanceVideoDetails(
    result: VideoDetailsResult, 
    _params: GetVideoDetailsParams
  ): Promise<VideoDetailsResult> {
    const enhanced = { ...result };

    // Process transcript if available
    if (enhanced.transcript && enhanced.transcript.length > 0) {
      const processedTranscript = this.transcriptProcessor.processTranscript(enhanced.transcript);
      
      // Add transcript metadata
      (enhanced as any).transcriptMetadata = processedTranscript.summary;
      
      // Extract topics from transcript
      const topics = this.transcriptProcessor.extractTopics(enhanced.transcript);
      if (!enhanced.analysis) enhanced.analysis = {};
      enhanced.analysis.topics = topics.slice(0, 10); // Top 10 topics
    }

    // Analyze comments if available
    if (enhanced.comments && enhanced.comments.length > 0) {
      const commentAnalysis = this.analyzeComments(enhanced.comments);
      if (!enhanced.analysis) enhanced.analysis = {};
      enhanced.analysis = { ...enhanced.analysis, ...commentAnalysis };
    }

    // Add engagement metrics
    enhanced.analysis = {
      ...enhanced.analysis,
      engagementMetrics: this.calculateEngagementMetrics(enhanced.video)
    };

    return enhanced;
  }

  /**
   * Analyze video comments for sentiment and common themes
   */
  private analyzeComments(comments: any[]): {
    sentiment?: 'positive' | 'negative' | 'neutral';
    commonThemes?: string[];
    questionCount?: number;
    avgCommentLength?: number;
  } {
    if (comments.length === 0) return {};

    let positiveCount = 0;
    let negativeCount = 0;
    let questionCount = 0;
    let totalLength = 0;
    const words: string[] = [];

    // Positive and negative indicators
    const positiveWords = ['great', 'awesome', 'amazing', 'love', 'excellent', 'perfect', 'best', 'good', 'nice', 'fantastic'];
    const negativeWords = ['bad', 'awful', 'terrible', 'hate', 'worst', 'stupid', 'boring', 'useless', 'horrible', 'disappointing'];

    comments.forEach(comment => {
      const text = comment.textOriginal?.toLowerCase() || '';
      totalLength += text.length;
      
      // Count questions
      if (text.includes('?')) {
        questionCount++;
      }
      
      // Simple sentiment analysis
      const hasPositive = positiveWords.some(word => text.includes(word));
      const hasNegative = negativeWords.some(word => text.includes(word));
      
      if (hasPositive && !hasNegative) {
        positiveCount++;
      } else if (hasNegative && !hasPositive) {
        negativeCount++;
      }
      
      // Collect words for theme analysis
      const commentWords = text.split(/\s+/)
        .filter(word => word.length > 3)
        .filter(word => !this.isStopWord(word));
      words.push(...commentWords);
    });

    // Determine overall sentiment
    let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
    const totalSentimentComments = positiveCount + negativeCount;
    if (totalSentimentComments > 0) {
      const positiveRatio = positiveCount / totalSentimentComments;
      if (positiveRatio > 0.6) {
        sentiment = 'positive';
      } else if (positiveRatio < 0.4) {
        sentiment = 'negative';
      }
    }

    // Find common themes (most frequent words)
    const wordCount: Record<string, number> = {};
    words.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });

    const commonThemes = Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([word]) => word);

    return {
      sentiment,
      commonThemes,
      questionCount,
      avgCommentLength: comments.length > 0 ? Math.round(totalLength / comments.length) : 0
    };
  }

  /**
   * Calculate engagement metrics for a video
   */
  private calculateEngagementMetrics(video: any): {
    likeToViewRatio?: number;
    commentToViewRatio?: number;
    engagementScore?: number;
  } {
    const views = parseInt(video.viewCount || '0');
    const likes = parseInt(video.likeCount || '0');
    const comments = parseInt(video.commentCount || '0');

    if (views === 0) return {};

    const likeToViewRatio = likes / views;
    const commentToViewRatio = comments / views;
    
    // Simple engagement score (0-100)
    const engagementScore = Math.min(100, (likeToViewRatio + commentToViewRatio) * 10000);

    return {
      likeToViewRatio: Number(likeToViewRatio.toFixed(6)),
      commentToViewRatio: Number(commentToViewRatio.toFixed(6)),
      engagementScore: Number(engagementScore.toFixed(2))
    };
  }

  /**
   * Search within video transcript
   */
  async searchInTranscript(videoId: string, query: string): Promise<{
    matches: Array<{
      text: string;
      start: number;
      duration: number;
      context: string;
    }>;
    totalMatches: number;
  }> {
    // Check cache for transcript
    const transcriptKey = this.cache.getTranscriptKey(videoId);
    let transcript = await this.cache.get<YouTubeTranscript[]>(transcriptKey);

    if (!transcript) {
      // Get video details with transcript
      const videoDetails = await this.execute({ 
        videoId, 
        includeTranscript: true, 
        includeComments: false 
      });
      transcript = videoDetails.transcript || [];
    }

    return this.transcriptProcessor.searchTranscript(transcript, query);
  }

  /**
   * Get video summary based on transcript and metadata
   */
  async getVideoSummary(videoId: string): Promise<{
    title: string;
    duration: string;
    summary: string;
    keyTopics: string[];
    highlights: Array<{ text: string; timestamp: number }>;
  }> {
    const details = await this.execute({
      videoId,
      includeTranscript: true,
      includeComments: false
    });

    const video = details.video;
    const transcript = details.transcript || [];

    // Generate summary from transcript
    let summary = 'No transcript available';
    let highlights: Array<{ text: string; timestamp: number }> = [];
    
    if (transcript.length > 0) {
      const processed = this.transcriptProcessor.processTranscript(transcript);
      summary = processed.paragraphs.slice(0, 2).join(' '); // First 2 paragraphs
      
      // Create highlights (segments with important keywords)
      const importantKeywords = ['important', 'key', 'main', 'crucial', 'essential', 'remember', 'note'];
      highlights = transcript
        .filter(segment => 
          importantKeywords.some(keyword => 
            segment.text.toLowerCase().includes(keyword)
          )
        )
        .slice(0, 5)
        .map(segment => ({
          text: segment.text,
          timestamp: segment.start
        }));
    }

    return {
      title: video.title,
      duration: video.duration || 'Unknown',
      summary: summary || video.description.slice(0, 500) + '...',
      keyTopics: details.analysis?.topics || [],
      highlights
    };
  }

  /**
   * Get partial cached data as fallback
   */
  private async getPartialCachedData(videoId: string): Promise<VideoDetailsResult | null> {
    try {
      // Try to get basic video details without transcript/comments
      const basicKey = this.cache.getVideoDetailsKey(videoId, false, false);
      const cached = await this.cache.get<VideoDetailsResult>(basicKey);
      
      if (cached) {
        return {
          ...cached,
          metadata: {
            partial: true,
            reason: 'quota_exceeded'
          }
        } as any;
      }
      
      return null;
    } catch (error) {
      this.logger.error('Failed to get partial cached data:', error);
      return null;
    }
  }

  /**
   * Check if word is a stop word (helper method)
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have',
      'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you',
      'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they',
      'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my'
    ]);
    
    return stopWords.has(word.toLowerCase());
  }
}