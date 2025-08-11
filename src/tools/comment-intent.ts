import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { RobustLLMService } from '../utils/llm-service.js';
import { 
  AnalyzeCommentIntentsParams, 
  AnalyzeCommentIntentsSchema,
  CommentIntentAnalysis,
  CommentIntent,
  YouTubeComment
} from '../types.js';

export class CommentIntentAnalyzer {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private llmService: RobustLLMService,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<CommentIntentAnalysis> {
    const params = AnalyzeCommentIntentsSchema.parse(args);
    
    this.logger.info(`Analyzing comment intents for video: ${params.videoId}`);

    // Generate cache key
    const cacheKey = `comment_intents:${params.videoId}:${params.maxComments}:${JSON.stringify(params.intentCategories || [])}`;

    // Check cache first
    const cached = await this.cache.get<CommentIntentAnalysis>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached comment intent analysis for: ${params.videoId}`);
      return cached;
    }

    try {
      // Step 1: Get video details with comments
      const videoDetails = await this.youtubeClient.getVideoDetails({
        videoId: params.videoId,
        includeTranscript: false,
        includeComments: true,
        maxComments: params.maxComments
      });

      if (!videoDetails.comments || videoDetails.comments.length === 0) {
        throw new Error(`No comments found for video ${params.videoId}`);
      }

      // Step 2: Analyze comments in batches using LLM
      const intents = await this.analyzeCommentsInBatches(
        videoDetails.comments,
        params.intentCategories
      );

      // Step 3: Generate summary and trends
      const analysis = await this.generateAnalysisSummary(
        params.videoId,
        intents,
        videoDetails.comments
      );

      // Cache the result
      await this.cache.set(cacheKey, analysis, 3600); // 1 hour cache
      
      this.logger.info(`Comment intent analysis completed for ${params.videoId}: ${intents.length} intents identified`);
      
      return analysis;

    } catch (error) {
      this.logger.error(`Failed to analyze comment intents for ${params.videoId}:`, error);
      throw error;
    }
  }

  /**
   * Analyze comments in batches to avoid token limits
   */
  private async analyzeCommentsInBatches(
    comments: YouTubeComment[],
    intentCategories?: string[]
  ): Promise<CommentIntent[]> {
    const batchSize = 20; // Process 20 comments at a time
    const allIntents: CommentIntent[] = [];

    for (let i = 0; i < comments.length; i += batchSize) {
      const batch = comments.slice(i, i + batchSize);
      
      try {
        const batchIntents = await this.analyzeCommentBatch(batch, intentCategories);
        allIntents.push(...batchIntents);
        
        // Small delay to manage rate limits
        if (i + batchSize < comments.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        this.logger.warn(`Failed to analyze comment batch ${i}-${i + batchSize}:`, error);
        
        // Fallback to rule-based analysis for this batch
        const fallbackIntents = this.analyzeCommentsRuleBased(batch);
        allIntents.push(...fallbackIntents);
      }
    }

    return allIntents;
  }

  /**
   * Analyze a batch of comments using LLM
   */
  private async analyzeCommentBatch(
    comments: YouTubeComment[],
    intentCategories?: string[]
  ): Promise<CommentIntent[]> {
    const prompt = this.buildIntentAnalysisPrompt(comments, intentCategories);

    const response = await this.llmService.generateWithFallback({
      prompt,
      model: 'gpt-4o-mini', // Cost-effective for classification
      maxTokens: 1500,
      temperature: 0.1,
      responseFormat: 'json'
    });

    try {
      const analysis = JSON.parse(response.content);
      return this.processLLMIntentResponse(analysis, comments);
    } catch (error) {
      this.logger.warn('Failed to parse LLM intent response, falling back to rule-based:', error);
      return this.analyzeCommentsRuleBased(comments);
    }
  }

  /**
   * Build prompt for LLM intent analysis
   */
  private buildIntentAnalysisPrompt(
    comments: YouTubeComment[],
    intentCategories?: string[]
  ): string {
    const defaultIntents = [
      'question', 'praise', 'criticism', 'request', 'sharing', 'correction', 'discussion'
    ];
    
    const intents = intentCategories && intentCategories.length > 0 
      ? intentCategories 
      : defaultIntents;

    const commentTexts = comments.map((comment, index) => 
      `${index + 1}. "${comment.textOriginal}" - by ${comment.authorDisplayName}`
    ).join('\n');

    return `Analyze the intent behind these YouTube comments. Classify each comment's primary intent and provide confidence scores.

Available Intent Categories:
${intents.map(intent => `- ${intent}: ${this.getIntentDescription(intent)}`).join('\n')}

Comments to analyze:
${commentTexts}

For each comment, determine:
1. Primary intent category
2. Confidence score (0-1)
3. Brief context explanation
4. Suggested response (if actionable)

Respond with JSON in this format:
{
  "intents": [
    {
      "commentIndex": 1,
      "intent": "question",
      "confidence": 0.95,
      "context": "User asking about specific technique mentioned in video",
      "suggestedResponse": "Consider creating a follow-up video about this topic"
    }
  ]
}`;
  }

  /**
   * Get description for intent categories
   */
  private getIntentDescription(intent: string): string {
    const descriptions: Record<string, string> = {
      'question': 'User asking for information, clarification, or help',
      'praise': 'Positive feedback, compliments, appreciation',
      'criticism': 'Negative feedback, complaints, or constructive criticism',
      'request': 'Asking for specific content, features, or actions',
      'sharing': 'Sharing personal experiences, stories, or additional information',
      'correction': 'Pointing out errors or providing corrections',
      'discussion': 'Starting or contributing to discussion about the topic'
    };
    
    return descriptions[intent] || 'General intent category';
  }

  /**
   * Process LLM response into CommentIntent objects
   */
  private processLLMIntentResponse(
    analysis: any,
    comments: YouTubeComment[]
  ): CommentIntent[] {
    if (!analysis.intents || !Array.isArray(analysis.intents)) {
      throw new Error('Invalid LLM response format');
    }

    return analysis.intents
      .filter((intent: any) => 
        intent.commentIndex >= 1 && 
        intent.commentIndex <= comments.length
      )
      .map((intent: any) => {
        const comment = comments[intent.commentIndex - 1];
        
        return {
          intent: intent.intent,
          confidence: Math.max(0, Math.min(1, intent.confidence || 0.5)),
          text: comment.textOriginal,
          author: comment.authorDisplayName,
          timestamp: comment.publishedAt,
          context: intent.context,
          suggestedResponse: intent.suggestedResponse
        };
      });
  }

  /**
   * Fallback rule-based comment analysis
   */
  private analyzeCommentsRuleBased(comments: YouTubeComment[]): CommentIntent[] {
    return comments.map(comment => {
      const text = comment.textOriginal.toLowerCase();
      const intent = this.classifyCommentRuleBased(text);
      
      return {
        intent,
        confidence: 0.6, // Lower confidence for rule-based
        text: comment.textOriginal,
        author: comment.authorDisplayName,
        timestamp: comment.publishedAt,
        context: `Rule-based classification: detected as ${intent}`
      };
    });
  }

  /**
   * Rule-based intent classification
   */
  private classifyCommentRuleBased(text: string): CommentIntent['intent'] {
    // Question patterns
    if (text.includes('?') || 
        text.match(/\b(how|what|why|when|where|can you|could you|please explain)\b/)) {
      return 'question';
    }

    // Praise patterns
    if (text.match(/\b(great|amazing|awesome|excellent|love|perfect|fantastic|best|thank you)\b/)) {
      return 'praise';
    }

    // Criticism patterns
    if (text.match(/\b(bad|awful|terrible|wrong|disagree|stupid|hate|worst)\b/)) {
      return 'criticism';
    }

    // Request patterns
    if (text.match(/\b(please|can you|could you|would you|make a video|tutorial on)\b/)) {
      return 'request';
    }

    // Correction patterns
    if (text.match(/\b(actually|incorrect|mistake|wrong|should be|correction)\b/)) {
      return 'correction';
    }

    // Sharing patterns
    if (text.match(/\b(i think|in my experience|i found|i tried|i use|my approach)\b/)) {
      return 'sharing';
    }

    // Default to discussion
    return 'discussion';
  }

  /**
   * Generate comprehensive analysis summary
   */
  private async generateAnalysisSummary(
    videoId: string,
    intents: CommentIntent[],
    allComments: YouTubeComment[]
  ): Promise<CommentIntentAnalysis> {
    // Calculate intent distribution
    const intentDistribution: Record<string, number> = {};
    intents.forEach(intent => {
      intentDistribution[intent.intent] = (intentDistribution[intent.intent] || 0) + 1;
    });

    // Extract top questions
    const questions = intents
      .filter(intent => intent.intent === 'question')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map(intent => intent.text);

    // Sentiment breakdown
    const sentimentBreakdown = this.calculateSentimentBreakdown(intents);

    // Generate actionable insights using LLM
    const actionableInsights = await this.generateActionableInsights(
      intents,
      intentDistribution
    );

    // Analyze trends
    const trends = this.analyzeTrends(intents, allComments);

    return {
      videoId,
      intents,
      summary: {
        totalComments: allComments.length,
        intentDistribution,
        topQuestions: questions,
        sentimentBreakdown,
        actionableInsights
      },
      trends
    };
  }

  /**
   * Calculate sentiment breakdown from intents
   */
  private calculateSentimentBreakdown(intents: CommentIntent[]): Record<string, number> {
    const sentimentMap: Record<string, 'positive' | 'negative' | 'neutral'> = {
      'praise': 'positive',
      'criticism': 'negative',
      'question': 'neutral',
      'request': 'neutral',
      'sharing': 'positive',
      'correction': 'neutral',
      'discussion': 'neutral'
    };

    const breakdown = { positive: 0, negative: 0, neutral: 0 };
    
    intents.forEach(intent => {
      const sentiment = sentimentMap[intent.intent] || 'neutral';
      breakdown[sentiment]++;
    });

    return breakdown;
  }

  /**
   * Generate actionable insights using LLM
   */
  private async generateActionableInsights(
    intents: CommentIntent[],
    intentDistribution: Record<string, number>
  ): Promise<string[]> {
    try {
      const topIntents = Object.entries(intentDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const sampleComments = intents
        .slice(0, 10)
        .map(intent => `${intent.intent}: "${intent.text.slice(0, 100)}"`)
        .join('\n');

      const prompt = `Based on this YouTube comment analysis, provide 5 actionable insights for the content creator:

Intent Distribution:
${topIntents.map(([intent, count]) => `- ${intent}: ${count} comments`).join('\n')}

Sample Comments:
${sampleComments}

Provide practical, specific recommendations that the creator can implement to:
1. Improve content quality
2. Better engage with their audience
3. Address common concerns or questions
4. Optimize their content strategy

Format as a JSON array of strings: ["insight1", "insight2", ...]`;

      const response = await this.llmService.generateWithFallback({
        prompt,
        model: 'gpt-4o-mini',
        maxTokens: 800,
        temperature: 0.2,
        responseFormat: 'json'
      });

      const insights = JSON.parse(response.content);
      return Array.isArray(insights) ? insights : [];
      
    } catch (error) {
      this.logger.warn('Failed to generate actionable insights:', error);
      
      // Fallback insights
      return [
        'Consider creating FAQ content to address common questions',
        'Engage more with commenters showing high interest',
        'Address criticisms constructively in future content',
        'Create follow-up content based on popular requests'
      ];
    }
  }

  /**
   * Analyze trends in comments
   */
  private analyzeTrends(
    intents: CommentIntent[],
    allComments: YouTubeComment[]
  ): CommentIntentAnalysis['trends'] {
    // Time-based patterns (simplified)
    const timeBasedPatterns = this.analyzeTimePatterns(allComments);
    
    // Engagement correlation
    const engagementCorrelation = this.calculateEngagementCorrelation(intents);
    
    // Audience segments
    const audienceSegments = this.identifyAudienceSegments(intents);

    return {
      timeBasedPatterns,
      engagementCorrelation,
      audienceSegments
    };
  }

  /**
   * Analyze time-based comment patterns
   */
  private analyzeTimePatterns(comments: YouTubeComment[]): Record<string, number> {
    const patterns: Record<string, number> = {};
    
    comments.forEach(comment => {
      const date = new Date(comment.publishedAt);
      const hourOfDay = date.getHours();
      
      let timeSlot: string;
      if (hourOfDay < 6) timeSlot = 'night';
      else if (hourOfDay < 12) timeSlot = 'morning';
      else if (hourOfDay < 18) timeSlot = 'afternoon';
      else timeSlot = 'evening';
      
      patterns[timeSlot] = (patterns[timeSlot] || 0) + 1;
    });

    return patterns;
  }

  /**
   * Calculate engagement correlation
   */
  private calculateEngagementCorrelation(intents: CommentIntent[]): number {
    const engagementIntents = ['question', 'request', 'discussion', 'sharing'];
    const engagementComments = intents.filter(intent => 
      engagementIntents.includes(intent.intent)
    );
    
    return intents.length > 0 ? engagementComments.length / intents.length : 0;
  }

  /**
   * Identify audience segments based on comment patterns
   */
  private identifyAudienceSegments(intents: CommentIntent[]): Array<{
    segment: string;
    characteristics: string[];
    commonIntents: string[];
  }> {
    // This is a simplified segmentation - in production, you'd use more sophisticated clustering
    const segments = [
      {
        segment: 'Learners',
        characteristics: ['Ask many questions', 'Seek clarification', 'Request tutorials'],
        commonIntents: ['question', 'request']
      },
      {
        segment: 'Supporters',
        characteristics: ['Leave positive feedback', 'Share enthusiasm', 'Promote content'],
        commonIntents: ['praise', 'sharing']
      },
      {
        segment: 'Contributors',
        characteristics: ['Share expertise', 'Provide corrections', 'Start discussions'],
        commonIntents: ['correction', 'discussion', 'sharing']
      }
    ];

    // Filter segments based on actual intent distribution
    return segments.filter(segment => 
      segment.commonIntents.some(intent => 
        intents.some(commentIntent => commentIntent.intent === intent)
      )
    );
  }
}