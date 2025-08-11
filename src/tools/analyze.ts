import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { TranscriptProcessor } from '../utils/transcript.js';
import { 
  AnalyzeVideoContentParams, 
  AnalyzeVideoContentSchema,
  YouTubeTranscript,
  YouTubeComment
} from '../types.js';

export class AnalyzeContentTool {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private transcriptProcessor: TranscriptProcessor,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<{
    videoId: string;
    analysis: {
      topics?: string[];
      sentiment?: 'positive' | 'negative' | 'neutral';
      questions?: string[];
      summary?: string;
      keywords?: string[];
      readabilityScore?: number;
      contentType?: string;
      difficulty?: 'beginner' | 'intermediate' | 'advanced';
      engagement?: {
        likeRatio: number;
        commentEngagement: string;
        viewVelocity?: number;
      };
      timestamps?: Array<{
        time: number;
        topic: string;
        importance: number;
      }>;
    };
    metadata: {
      analysisTypes: string[];
      dataSourcesUsed: string[];
      processingTime: number;
    };
  }> {
    const startTime = Date.now();
    
    // Validate input parameters
    const params = AnalyzeVideoContentSchema.parse(args);
    
    this.logger.info(`Analyzing video content for: ${params.videoId}`);

    // Generate cache key
    const cacheKey = `analysis:${params.videoId}:${params.analysisType.sort().join(',')}:${params.includeComments}`;

    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached analysis for: ${params.videoId}`);
      return cached;
    }

    try {
      // Get video details
      const videoDetails = await this.youtubeClient.getVideoDetails({
        videoId: params.videoId,
        includeTranscript: true,
        includeComments: params.includeComments,
        maxComments: 50
      });

      const analysis: any = {};
      const dataSourcesUsed: string[] = ['video_metadata'];

      // Perform requested analysis types
      for (const analysisType of params.analysisType) {
        switch (analysisType) {
          case 'topics':
            analysis.topics = await this.extractTopics(videoDetails, dataSourcesUsed);
            break;
          case 'sentiment':
            analysis.sentiment = await this.analyzeSentiment(videoDetails, dataSourcesUsed);
            break;
          case 'questions':
            analysis.questions = await this.extractQuestions(videoDetails, dataSourcesUsed);
            break;
          case 'summary':
            analysis.summary = await this.generateSummary(videoDetails, dataSourcesUsed);
            break;
          case 'keywords':
            analysis.keywords = await this.extractKeywords(videoDetails, dataSourcesUsed);
            break;
        }
      }

      // Add additional analysis
      analysis.readabilityScore = this.calculateReadabilityScore(videoDetails);
      analysis.contentType = this.identifyContentType(videoDetails);
      analysis.difficulty = this.assessDifficulty(videoDetails);
      analysis.engagement = this.analyzeEngagement(videoDetails);
      analysis.timestamps = this.generateTimestamps(videoDetails);

      const result = {
        videoId: params.videoId,
        analysis,
        metadata: {
          analysisTypes: params.analysisType,
          dataSourcesUsed,
          processingTime: Date.now() - startTime
        }
      };

      // Cache the result
      await this.cache.set(cacheKey, result, 3600); // 1 hour TTL

      this.logger.info(`Analysis completed for: ${params.videoId} in ${Date.now() - startTime}ms`);
      
      return result;

    } catch (error) {
      this.logger.error(`Failed to analyze video content for ${params.videoId}:`, error);
      throw error;
    }
  }

  /**
   * Extract topics from video content
   */
  private async extractTopics(videoDetails: any, dataSources: string[]): Promise<string[]> {
    const topics: string[] = [];
    
    // Extract from title and description
    const titleWords = this.extractSignificantWords(videoDetails.video.title);
    const descWords = this.extractSignificantWords(videoDetails.video.description);
    topics.push(...titleWords.slice(0, 3), ...descWords.slice(0, 2));

    // Extract from transcript if available
    if (videoDetails.transcript && videoDetails.transcript.length > 0) {
      const transcriptTopics = this.transcriptProcessor.extractTopics(videoDetails.transcript);
      topics.push(...transcriptTopics.slice(0, 5));
      dataSources.push('transcript');
    }

    // Extract from tags
    if (videoDetails.video.tags) {
      topics.push(...videoDetails.video.tags.slice(0, 3));
    }

    // Remove duplicates and filter
    const uniqueTopics = [...new Set(topics)]
      .filter(topic => topic.length > 2)
      .slice(0, 10);

    return uniqueTopics;
  }

  /**
   * Analyze sentiment of video content
   */
  private async analyzeSentiment(videoDetails: any, dataSources: string[]): Promise<'positive' | 'negative' | 'neutral'> {
    let positiveCount = 0;
    let negativeCount = 0;
    let totalCount = 0;

    const positiveWords = [
      'great', 'awesome', 'amazing', 'excellent', 'perfect', 'love', 'best',
      'wonderful', 'fantastic', 'incredible', 'outstanding', 'brilliant',
      'good', 'nice', 'helpful', 'useful', 'easy', 'simple', 'clear'
    ];

    const negativeWords = [
      'bad', 'awful', 'terrible', 'horrible', 'worst', 'hate', 'difficult',
      'hard', 'confusing', 'boring', 'useless', 'disappointing', 'poor',
      'wrong', 'error', 'problem', 'issue', 'fail', 'broken', 'annoying'
    ];

    // Analyze title and description
    const titleDesc = `${videoDetails.video.title} ${videoDetails.video.description}`.toLowerCase();
    totalCount += this.countSentimentWords(titleDesc, positiveWords, negativeWords, (pos, neg) => {
      positiveCount += pos;
      negativeCount += neg;
    });

    // Analyze transcript
    if (videoDetails.transcript) {
      const transcriptText = videoDetails.transcript.map(t => t.text).join(' ').toLowerCase();
      totalCount += this.countSentimentWords(transcriptText, positiveWords, negativeWords, (pos, neg) => {
        positiveCount += pos;
        negativeCount += neg;
      });
      dataSources.push('transcript');
    }

    // Analyze comments if available
    if (videoDetails.comments) {
      const commentsText = videoDetails.comments.map(c => c.textOriginal).join(' ').toLowerCase();
      totalCount += this.countSentimentWords(commentsText, positiveWords, negativeWords, (pos, neg) => {
        positiveCount += pos;
        negativeCount += neg;
      });
      dataSources.push('comments');
    }

    if (totalCount === 0) return 'neutral';

    const positiveRatio = positiveCount / (positiveCount + negativeCount);
    if (positiveRatio > 0.6) return 'positive';
    if (positiveRatio < 0.4) return 'negative';
    return 'neutral';
  }

  /**
   * Extract questions from video content
   */
  private async extractQuestions(videoDetails: any, dataSources: string[]): Promise<string[]> {
    const questions: string[] = [];

    // Extract from title and description
    const titleDescQuestions = this.extractQuestionsFromText(
      `${videoDetails.video.title} ${videoDetails.video.description}`
    );
    questions.push(...titleDescQuestions);

    // Extract from transcript
    if (videoDetails.transcript) {
      const transcriptText = videoDetails.transcript.map(t => t.text).join(' ');
      const transcriptQuestions = this.extractQuestionsFromText(transcriptText);
      questions.push(...transcriptQuestions);
      dataSources.push('transcript');
    }

    // Extract from comments
    if (videoDetails.comments) {
      const commentQuestions = videoDetails.comments
        .filter(c => c.textOriginal.includes('?'))
        .map(c => c.textOriginal)
        .slice(0, 5);
      questions.push(...commentQuestions);
      dataSources.push('comments');
    }

    return questions.slice(0, 10);
  }

  /**
   * Generate a summary of the video content
   */
  private async generateSummary(videoDetails: any, dataSources: string[]): Promise<string> {
    let summary = '';

    // Start with title and basic info
    const video = videoDetails.video;
    summary += `"${video.title}" by ${video.channelTitle}. `;

    // Add view and engagement info
    const views = parseInt(video.viewCount || '0');
    const likes = parseInt(video.likeCount || '0');
    if (views > 0) {
      summary += `This video has ${this.formatNumber(views)} views`;
      if (likes > 0) {
        summary += ` and ${this.formatNumber(likes)} likes`;
      }
      summary += '. ';
    }

    // Add duration info
    if (video.duration) {
      const duration = this.parseDuration(video.duration);
      summary += `Duration: ${duration}. `;
    }

    // Add description summary
    if (video.description && video.description.length > 50) {
      const descSummary = video.description.slice(0, 200).trim() + '...';
      summary += descSummary + ' ';
    }

    // Add transcript summary if available
    if (videoDetails.transcript && videoDetails.transcript.length > 0) {
      const processed = this.transcriptProcessor.processTranscript(videoDetails.transcript);
      if (processed.paragraphs.length > 0) {
        summary += 'Content covers: ' + processed.paragraphs[0].slice(0, 150) + '...';
      }
      dataSources.push('transcript');
    }

    return summary.trim();
  }

  /**
   * Extract keywords from video content
   */
  private async extractKeywords(videoDetails: any, dataSources: string[]): Promise<string[]> {
    const keywords: Set<string> = new Set();

    // Extract from title (weighted heavily)
    const titleKeywords = this.extractSignificantWords(videoDetails.video.title);
    titleKeywords.forEach(keyword => keywords.add(keyword));

    // Extract from description
    const descKeywords = this.extractSignificantWords(videoDetails.video.description);
    descKeywords.slice(0, 5).forEach(keyword => keywords.add(keyword));

    // Extract from tags
    if (videoDetails.video.tags) {
      videoDetails.video.tags.forEach(tag => keywords.add(tag.toLowerCase()));
    }

    // Extract from transcript
    if (videoDetails.transcript) {
      const transcriptKeywords = this.transcriptProcessor.extractTopics(videoDetails.transcript);
      transcriptKeywords.slice(0, 10).forEach(keyword => keywords.add(keyword));
      dataSources.push('transcript');
    }

    return Array.from(keywords).slice(0, 15);
  }

  /**
   * Calculate readability score (0-100, higher = more readable)
   */
  private calculateReadabilityScore(videoDetails: any): number {
    if (!videoDetails.transcript || videoDetails.transcript.length === 0) {
      return 50; // Default score for no transcript
    }

    const text = videoDetails.transcript.map(t => t.text).join(' ');
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    if (sentences.length === 0 || words.length === 0) return 50;

    // Simple readability calculation (based on Flesch Reading Ease)
    const avgSentenceLength = words.length / sentences.length;
    const avgSyllables = this.estimateAverageSyllables(words);
    
    const score = 206.835 - (1.015 * avgSentenceLength) - (84.6 * avgSyllables);
    
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Identify content type based on patterns
   */
  private identifyContentType(videoDetails: any): string {
    const title = videoDetails.video.title.toLowerCase();
    const description = videoDetails.video.description.toLowerCase();
    const content = `${title} ${description}`;

    const patterns = {
      'tutorial': ['tutorial', 'how to', 'guide', 'step by step', 'learn'],
      'review': ['review', 'unboxing', 'first impressions', 'hands on'],
      'news': ['news', 'breaking', 'update', 'announcement', 'latest'],
      'entertainment': ['funny', 'comedy', 'prank', 'reaction', 'challenge'],
      'educational': ['explained', 'science', 'history', 'documentary', 'facts'],
      'music': ['official music video', 'song', 'album', 'artist', 'music'],
      'gaming': ['gameplay', 'walkthrough', 'let\'s play', 'game', 'gaming'],
      'vlog': ['vlog', 'day in my life', 'daily', 'personal', 'behind the scenes']
    };

    let bestMatch = 'general';
    let maxMatches = 0;

    for (const [type, keywords] of Object.entries(patterns)) {
      const matches = keywords.filter(keyword => content.includes(keyword)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        bestMatch = type;
      }
    }

    return bestMatch;
  }

  /**
   * Assess content difficulty level
   */
  private assessDifficulty(videoDetails: any): 'beginner' | 'intermediate' | 'advanced' {
    const title = videoDetails.video.title.toLowerCase();
    const description = videoDetails.video.description.toLowerCase();
    
    const beginnerKeywords = ['beginner', 'basic', 'introduction', 'getting started', 'basics', 'simple', 'easy'];
    const advancedKeywords = ['advanced', 'expert', 'professional', 'deep dive', 'complex', 'detailed analysis'];
    
    const content = `${title} ${description}`;
    
    const beginnerScore = beginnerKeywords.filter(keyword => content.includes(keyword)).length;
    const advancedScore = advancedKeywords.filter(keyword => content.includes(keyword)).length;
    
    if (beginnerScore > advancedScore && beginnerScore > 0) return 'beginner';
    if (advancedScore > beginnerScore && advancedScore > 0) return 'advanced';
    
    return 'intermediate';
  }

  /**
   * Analyze engagement metrics
   */
  private analyzeEngagement(videoDetails: any): {
    likeRatio: number;
    commentEngagement: string;
    viewVelocity?: number;
  } {
    const video = videoDetails.video;
    const views = parseInt(video.viewCount || '0');
    const likes = parseInt(video.likeCount || '0');
    const comments = parseInt(video.commentCount || '0');

    const likeRatio = views > 0 ? (likes / views) * 1000 : 0; // likes per 1000 views
    
    let commentEngagement = 'low';
    if (views > 0) {
      const commentRatio = (comments / views) * 1000;
      if (commentRatio > 5) commentEngagement = 'high';
      else if (commentRatio > 2) commentEngagement = 'medium';
    }

    return {
      likeRatio: Number(likeRatio.toFixed(2)),
      commentEngagement
    };
  }

  /**
   * Generate important timestamps from transcript
   */
  private generateTimestamps(videoDetails: any): Array<{
    time: number;
    topic: string;
    importance: number;
  }> {
    if (!videoDetails.transcript || videoDetails.transcript.length === 0) {
      return [];
    }

    const importantKeywords = [
      'important', 'key', 'main', 'crucial', 'essential', 'remember',
      'first', 'second', 'third', 'finally', 'conclusion', 'summary',
      'tip', 'trick', 'secret', 'hack', 'mistake', 'avoid'
    ];

    const timestamps = videoDetails.transcript
      .map((segment: YouTubeTranscript, _index: number) => {
        const text = segment.text.toLowerCase();
        const importance = importantKeywords.filter(keyword => 
          text.includes(keyword)
        ).length;
        
        if (importance > 0) {
          return {
            time: Math.round(segment.start),
            topic: segment.text.slice(0, 100),
            importance
          };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    return timestamps;
  }

  // Helper methods
  private extractSignificantWords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !this.isStopWord(word))
      .slice(0, 10);
  }

  private countSentimentWords(
    text: string, 
    positiveWords: string[], 
    negativeWords: string[],
    callback: (pos: number, neg: number) => void
  ): number {
    let pos = 0;
    let neg = 0;
    
    positiveWords.forEach(word => {
      const matches = (text.match(new RegExp(word, 'g')) || []).length;
      pos += matches;
    });
    
    negativeWords.forEach(word => {
      const matches = (text.match(new RegExp(word, 'g')) || []).length;
      neg += matches;
    });
    
    callback(pos, neg);
    return pos + neg;
  }

  private extractQuestionsFromText(text: string): string[] {
    return text
      .split(/[.!]/)
      .filter(sentence => sentence.includes('?'))
      .map(question => question.trim())
      .filter(question => question.length > 10)
      .slice(0, 5);
  }

  private estimateAverageSyllables(words: string[]): number {
    const totalSyllables = words.reduce((sum, word) => {
      return sum + Math.max(1, word.replace(/[^aeiou]/gi, '').length);
    }, 0);
    return totalSyllables / words.length;
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  }

  private parseDuration(duration: string): string {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 'Unknown';
    
    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');
    
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have',
      'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you'
    ]);
    return stopWords.has(word.toLowerCase());
  }
}