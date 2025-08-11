import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { QuotaManager } from '../utils/quota.js';
import { RobustLLMService } from '../utils/llm-service.js';
import { 
  GenerateLearningPathParams, 
  GenerateLearningPathSchema,
  LearningPath,
  YouTubeVideo
} from '../types.js';

export class LearningPathGenerator {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private quotaManager: QuotaManager,
    private llmService: RobustLLMService,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<LearningPath> {
    const params = GenerateLearningPathSchema.parse(args);
    
    this.logger.info(`Generating learning path for: "${params.query}" (${params.targetLevel} level)`);

    // Generate cache key
    const cacheKey = `learning_path:${Buffer.from(JSON.stringify(params)).toString('base64')}`;

    // Check cache first
    const cached = await this.cache.get<LearningPath>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached learning path for: "${params.query}"`);
      return cached;
    }

    try {
      // Step 1: Search for relevant videos
      const searchResults = await this.searchRelevantVideos(params);
      
      // Step 2: Analyze and rank videos
      const rankedVideos = await this.analyzeAndRankVideos(searchResults, params);
      
      // Step 3: Generate learning sequence using LLM
      const learningPath = await this.generateLearningSequence(rankedVideos, params);
      
      // Step 4: Enhance with additional metadata
      const enhancedPath = await this.enhanceLearningPath(learningPath, params);
      
      // Cache the result
      await this.cache.set(cacheKey, enhancedPath, 7200); // 2 hours cache
      
      this.logger.info(`Learning path generated for "${params.query}": ${enhancedPath.videos.length} videos`);
      
      return enhancedPath;

    } catch (error) {
      this.logger.error(`Failed to generate learning path for "${params.query}":`, error);
      throw error;
    }
  }

  /**
   * Search for videos relevant to the learning topic
   */
  private async searchRelevantVideos(params: GenerateLearningPathParams): Promise<YouTubeVideo[]> {
    const searchQueries = this.generateSearchQueries(params.query, params.targetLevel);
    const allVideos: YouTubeVideo[] = [];

    for (const query of searchQueries) {
      try {
        const searchResult = await this.youtubeClient.searchVideos({
          query,
          maxResults: Math.ceil(params.maxVideos / searchQueries.length),
          order: 'relevance',
          videoDuration: 'medium' // Prefer medium-length educational content
        });

        allVideos.push(...searchResult.videos);
      } catch (error) {
        this.logger.warn(`Failed to search for "${query}":`, error);
      }
    }

    // Remove duplicates and limit results
    const uniqueVideos = this.removeDuplicates(allVideos);
    return uniqueVideos.slice(0, params.maxVideos * 2); // Get extra for filtering
  }

  /**
   * Generate diverse search queries for comprehensive coverage
   */
  private generateSearchQueries(topic: string, level: string): string[] {
    const baseQueries = [
      `${topic} tutorial`,
      `learn ${topic}`,
      `${topic} explained`,
      `${topic} course`
    ];

    const levelModifiers = {
      beginner: ['beginner', 'basics', 'introduction', 'getting started', 'fundamentals'],
      intermediate: ['intermediate', 'advanced tutorial', 'in-depth', 'comprehensive'],
      advanced: ['advanced', 'expert', 'professional', 'mastery', 'deep dive']
    };

    const modifiers = levelModifiers[level] || levelModifiers.beginner;
    const queries: string[] = [];

    // Combine base queries with level modifiers
    baseQueries.forEach(base => {
      queries.push(base);
      modifiers.forEach(modifier => {
        queries.push(`${modifier} ${base}`);
        queries.push(`${base} ${modifier}`);
      });
    });

    return queries.slice(0, 8); // Limit to 8 queries to manage API quota
  }

  /**
   * Analyze and rank videos for educational value
   */
  private async analyzeAndRankVideos(
    videos: YouTubeVideo[], 
    params: GenerateLearningPathParams
  ): Promise<Array<YouTubeVideo & { educationalScore: number; difficultyLevel: string }>> {
    const analyzedVideos = await Promise.all(
      videos.map(async (video) => {
        try {
          // Get basic educational metrics
          const educationalScore = this.calculateEducationalScore(video);
          const difficultyLevel = this.assessDifficultyLevel(video, params.targetLevel);
          
          return {
            ...video,
            educationalScore,
            difficultyLevel
          };
        } catch (error) {
          this.logger.warn(`Failed to analyze video ${video.id}:`, error);
          return {
            ...video,
            educationalScore: 0.5,
            difficultyLevel: params.targetLevel
          };
        }
      })
    );

    // Filter and sort by educational value
    return analyzedVideos
      .filter(video => video.educationalScore > 0.3) // Filter out low-quality content
      .sort((a, b) => b.educationalScore - a.educationalScore)
      .slice(0, params.maxVideos);
  }

  /**
   * Calculate educational score based on video metadata
   */
  private calculateEducationalScore(video: YouTubeVideo): number {
    let score = 0.5; // Base score

    // Duration scoring (prefer 10-30 minute videos for education)
    const duration = this.parseDuration(video.duration || 'PT0S');
    if (duration >= 600 && duration <= 1800) { // 10-30 minutes
      score += 0.2;
    } else if (duration < 300) { // Too short
      score -= 0.1;
    }

    // View to like ratio (engagement quality)
    const views = parseInt(video.viewCount || '0');
    const likes = parseInt(video.likeCount || '0');
    if (views > 0 && likes > 0) {
      const likeRatio = likes / views;
      if (likeRatio > 0.02) score += 0.15; // Good engagement
    }

    // Title analysis for educational keywords
    const educationalKeywords = [
      'tutorial', 'learn', 'explained', 'guide', 'how to', 'course',
      'lesson', 'teach', 'education', 'training', 'instruction'
    ];
    const titleLower = video.title.toLowerCase();
    const keywordMatches = educationalKeywords.filter(keyword => 
      titleLower.includes(keyword)
    ).length;
    score += Math.min(keywordMatches * 0.05, 0.15);

    // Channel credibility (simplified)
    if (video.channelTitle && video.channelTitle.toLowerCase().includes('university')) {
      score += 0.1;
    }

    // Comments indicate engagement
    const commentCount = parseInt(video.commentCount || '0');
    if (commentCount > 50) score += 0.05;

    return Math.min(Math.max(score, 0), 1); // Clamp between 0 and 1
  }

  /**
   * Assess difficulty level of content
   */
  private assessDifficultyLevel(video: YouTubeVideo, targetLevel: string): string {
    const title = video.title.toLowerCase();
    const description = video.description.toLowerCase();
    const content = `${title} ${description}`;

    const beginnerKeywords = ['beginner', 'basic', 'introduction', 'getting started', 'fundamentals', 'basics'];
    const intermediateKeywords = ['intermediate', 'advanced tutorial', 'in-depth', 'comprehensive'];
    const advancedKeywords = ['advanced', 'expert', 'professional', 'mastery', 'complex'];

    const beginnerScore = beginnerKeywords.filter(k => content.includes(k)).length;
    const intermediateScore = intermediateKeywords.filter(k => content.includes(k)).length;
    const advancedScore = advancedKeywords.filter(k => content.includes(k)).length;

    if (advancedScore > beginnerScore && advancedScore > intermediateScore) {
      return 'advanced';
    } else if (intermediateScore > beginnerScore) {
      return 'intermediate';
    } else if (beginnerScore > 0) {
      return 'beginner';
    }

    // Default to target level if unclear
    return targetLevel;
  }

  /**
   * Generate learning sequence using LLM analysis
   */
  private async generateLearningSequence(
    videos: Array<YouTubeVideo & { educationalScore: number; difficultyLevel: string }>,
    params: GenerateLearningPathParams
  ): Promise<LearningPath> {
    const prompt = this.buildLearningPathPrompt(videos, params);
    
    try {
      const response = await this.llmService.generateWithFallback({
        prompt,
        model: 'gpt-4o-mini', // Cost-effective for structured tasks
        maxTokens: 2000,
        temperature: 0.1,
        responseFormat: 'json'
      });

      const parsedResponse = JSON.parse(response.content);
      return this.structureLearningPath(parsedResponse, videos, params);
      
    } catch (error) {
      this.logger.warn('LLM generation failed, falling back to rule-based sequencing:', error);
      return this.generateRuleBasedSequence(videos, params);
    }
  }

  /**
   * Build prompt for LLM learning path generation
   */
  private buildLearningPathPrompt(
    videos: Array<YouTubeVideo & { educationalScore: number; difficultyLevel: string }>,
    params: GenerateLearningPathParams
  ): string {
    const videoDescriptions = videos.map((video, index) => 
      `${index + 1}. "${video.title}" (${video.difficultyLevel}) - ${video.duration} - ${video.description.slice(0, 100)}...`
    ).join('\n');

    return `You are an expert educational content curator. Create a structured learning path for "${params.query}" at ${params.targetLevel} level.

Available videos:
${videoDescriptions}

Requirements:
- Target level: ${params.targetLevel}
- Maximum videos: ${params.maxVideos}
- ${params.duration ? `Total duration target: ${params.duration}` : 'No duration constraint'}
- ${params.includeQuizzes ? 'Include quiz questions for each video' : 'No quizzes needed'}

Create a logical progression from basic concepts to more advanced topics. Consider:
1. Prerequisites and dependencies between topics
2. Optimal learning sequence
3. Difficulty progression
4. Learning objectives for each video
5. Key topics covered

Respond with JSON in this format:
{
  "topic": "${params.query}",
  "level": "${params.targetLevel}",
  "videos": [
    {
      "order": 1,
      "videoIndex": 0,
      "prerequisites": ["concept1", "concept2"],
      "learningObjectives": ["objective1", "objective2"],
      "keyTopics": ["topic1", "topic2"],
      "estimatedStudyTime": "45 minutes"
    }
  ],
  "totalDuration": "estimated total time",
  "completionCriteria": ["criteria1", "criteria2"],
  "recommendations": ["tip1", "tip2"]
}`;
  }

  /**
   * Structure the LLM response into a proper LearningPath
   */
  private structureLearningPath(
    llmResponse: any,
    videos: Array<YouTubeVideo & { educationalScore: number; difficultyLevel: string }>,
    params: GenerateLearningPathParams
  ): LearningPath {
    const pathVideos = llmResponse.videos.map((videoData: any) => {
      const video = videos[videoData.videoIndex];
      if (!video) {
        throw new Error(`Invalid video index: ${videoData.videoIndex}`);
      }

      return {
        videoId: video.id,
        title: video.title,
        order: videoData.order,
        difficulty: video.difficultyLevel,
        duration: video.duration || 'Unknown',
        prerequisites: videoData.prerequisites || [],
        learningObjectives: videoData.learningObjectives || [],
        keyTopics: videoData.keyTopics || []
      };
    });

    return {
      topic: params.query,
      level: params.targetLevel,
      videos: pathVideos,
      totalDuration: llmResponse.totalDuration || 'Unknown',
      completionCriteria: llmResponse.completionCriteria || [],
      recommendations: llmResponse.recommendations || []
    };
  }

  /**
   * Fallback rule-based sequence generation
   */
  private generateRuleBasedSequence(
    videos: Array<YouTubeVideo & { educationalScore: number; difficultyLevel: string }>,
    params: GenerateLearningPathParams
  ): LearningPath {
    // Sort videos by difficulty and educational score
    const sortedVideos = videos.sort((a, b) => {
      const difficultyOrder = { beginner: 1, intermediate: 2, advanced: 3 };
      const aDiff = difficultyOrder[a.difficultyLevel] || 2;
      const bDiff = difficultyOrder[b.difficultyLevel] || 2;
      
      if (aDiff !== bDiff) {
        return aDiff - bDiff; // Sort by difficulty first
      }
      return b.educationalScore - a.educationalScore; // Then by quality
    });

    const pathVideos = sortedVideos.slice(0, params.maxVideos).map((video, index) => ({
      videoId: video.id,
      title: video.title,
      order: index + 1,
      difficulty: video.difficultyLevel,
      duration: video.duration || 'Unknown',
      prerequisites: index > 0 ? [`Video ${index}`] : [],
      learningObjectives: [`Learn ${params.query} concepts from this video`],
      keyTopics: [params.query]
    }));

    return {
      topic: params.query,
      level: params.targetLevel,
      videos: pathVideos,
      totalDuration: this.calculateTotalDuration(pathVideos),
      completionCriteria: [
        'Complete all videos in sequence',
        'Take notes on key concepts',
        'Practice examples where applicable'
      ],
      recommendations: [
        'Follow the suggested order for optimal learning',
        'Take breaks between videos to process information',
        'Revisit earlier videos if concepts become unclear'
      ]
    };
  }

  /**
   * Enhance learning path with additional features
   */
  private async enhanceLearningPath(
    path: LearningPath, 
    params: GenerateLearningPathParams
  ): Promise<LearningPath> {
    if (!params.includeQuizzes) {
      return path;
    }

    // Generate quiz questions for each video using LLM
    try {
      const enhancedVideos = await Promise.all(
        path.videos.map(async (video) => {
          try {
            const quizPrompt = `Generate 3 multiple choice quiz questions for a video titled "${video.title}" about ${path.topic}. 

Make questions at ${path.level} level covering these topics: ${video.keyTopics.join(', ')}.

Respond with JSON:
{
  "questions": [
    {
      "question": "question text",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": 0,
      "explanation": "explanation"
    }
  ]
}`;

            const response = await this.llmService.generateWithFallback({
              prompt: quizPrompt,
              model: 'gpt-4o-mini',
              maxTokens: 1000,
              temperature: 0.2,
              responseFormat: 'json'
            });

            const quizData = JSON.parse(response.content);
            
            return {
              ...video,
              quizQuestions: quizData.questions
            };
          } catch (error) {
            this.logger.warn(`Failed to generate quiz for video ${video.videoId}:`, error);
            return video; // Return without quiz
          }
        })
      );

      return {
        ...path,
        videos: enhancedVideos
      };
    } catch (error) {
      this.logger.warn('Failed to enhance learning path with quizzes:', error);
      return path;
    }
  }

  // Helper methods
  private removeDuplicates(videos: YouTubeVideo[]): YouTubeVideo[] {
    const seen = new Set();
    return videos.filter(video => {
      if (seen.has(video.id)) {
        return false;
      }
      seen.add(video.id);
      return true;
    });
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    
    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');
    
    return hours * 3600 + minutes * 60 + seconds;
  }

  private calculateTotalDuration(videos: Array<{ duration: string }>): string {
    const totalSeconds = videos.reduce((sum, video) => {
      return sum + this.parseDuration(video.duration || 'PT0S');
    }, 0);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }
}