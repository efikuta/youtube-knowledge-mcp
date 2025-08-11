import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { RobustLLMService } from '../utils/llm-service.js';
import { TranscriptProcessor } from '../utils/transcript.js';
import { 
  GenerateVideoChaptersParams, 
  GenerateVideoChaptersSchema,
  ChapterAnalysis,
  VideoChapter,
  YouTubeTranscript
} from '../types.js';

export class ChapterGenerator {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private llmService: RobustLLMService,
    private transcriptProcessor: TranscriptProcessor,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<ChapterAnalysis> {
    const params = GenerateVideoChaptersSchema.parse(args);
    
    this.logger.info(`Generating chapters for video ${params.videoId}`);

    // Generate cache key
    const cacheKey = `chapters:${params.videoId}:${params.minChapterLength}:${params.maxChapters}`;

    // Check cache first
    const cached = await this.cache.get<ChapterAnalysis>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached chapters for: ${params.videoId}`);
      return cached;
    }

    try {
      // Step 1: Get video details with transcript
      const videoDetails = await this.youtubeClient.getVideoDetails({
        videoId: params.videoId,
        includeTranscript: true,
        includeComments: false
      });

      if (!videoDetails.transcript || videoDetails.transcript.length === 0) {
        throw new Error(`No transcript available for video ${params.videoId}`);
      }

      // Step 2: Process transcript for structure analysis
      const processedTranscript = this.transcriptProcessor.processTranscript(videoDetails.transcript);

      // Step 3: Identify chapter boundaries using AI
      const chapters = await this.generateChapters(
        videoDetails.transcript,
        processedTranscript,
        videoDetails.video,
        params
      );

      // Step 4: Enhance chapters with additional analysis
      const enhancedChapters = await this.enhanceChapters(chapters, videoDetails.transcript);

      // Step 5: Generate navigation and metadata
      const analysis = this.generateChapterAnalysis(
        params.videoId,
        enhancedChapters,
        videoDetails.video
      );

      // Cache the result
      await this.cache.set(cacheKey, analysis, 3600); // 1 hour cache
      
      this.logger.info(`Chapter generation completed for ${params.videoId}: ${chapters.length} chapters created`);
      
      return analysis;

    } catch (error) {
      this.logger.error(`Failed to generate chapters for ${params.videoId}:`, error);
      throw error;
    }
  }

  /**
   * Generate chapters using AI analysis of transcript
   */
  private async generateChapters(
    transcript: YouTubeTranscript[],
    processedTranscript: any,
    videoMetadata: any,
    params: GenerateVideoChaptersParams
  ): Promise<VideoChapter[]> {
    // For very long videos, analyze in segments
    const maxAnalysisLength = 15000; // ~15k characters
    
    if (processedTranscript.fullText.length > maxAnalysisLength) {
      return this.generateChaptersForLongVideo(transcript, videoMetadata, params);
    } else {
      return this.generateChaptersWithLLM(transcript, processedTranscript, videoMetadata, params);
    }
  }

  /**
   * Generate chapters using LLM for shorter videos
   */
  private async generateChaptersWithLLM(
    transcript: YouTubeTranscript[],
    processedTranscript: any,
    videoMetadata: any,
    params: GenerateVideoChaptersParams
  ): Promise<VideoChapter[]> {
    const prompt = this.buildChapterGenerationPrompt(
      processedTranscript.fullText,
      videoMetadata,
      params
    );

    try {
      const response = await this.llmService.generateWithFallback({
        prompt,
        model: 'gpt-4o', // Use better model for complex structural analysis
        maxTokens: 1500,
        temperature: 0.1,
        responseFormat: 'json'
      });

      const chapterData = JSON.parse(response.content);
      return this.processLLMChapterResponse(chapterData, transcript, params);

    } catch (error) {
      this.logger.warn('LLM chapter generation failed, using rule-based approach:', error);
      return this.generateChaptersRuleBased(transcript, params);
    }
  }

  /**
   * Generate chapters for long videos by analyzing segments
   */
  private async generateChaptersForLongVideo(
    transcript: YouTubeTranscript[],
    videoMetadata: any,
    params: GenerateVideoChaptersParams
  ): Promise<VideoChapter[]> {
    const segmentDuration = 600; // 10-minute segments
    const segments = this.segmentTranscript(transcript, segmentDuration);
    const allChapters: VideoChapter[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      try {
        const segmentText = segment.map(t => t.text).join(' ');
        const prompt = this.buildSegmentAnalysisPrompt(segmentText, i + 1, segments.length);

        const response = await this.llmService.generateWithFallback({
          prompt,
          model: 'gpt-4o-mini',
          maxTokens: 800,
          temperature: 0.1,
          responseFormat: 'json'
        });

        const segmentChapters = JSON.parse(response.content);
        if (segmentChapters.chapters && Array.isArray(segmentChapters.chapters)) {
          const processedChapters = segmentChapters.chapters.map((chapter: any) => ({
            title: chapter.title,
            startTime: segment[0].start + (chapter.relativeStart || 0),
            endTime: segment[0].start + (chapter.relativeEnd || segment[segment.length - 1].start),
            duration: chapter.relativeEnd - chapter.relativeStart || 60,
            description: chapter.description,
            keyPoints: chapter.keyPoints || [],
            difficulty: chapter.difficulty || 'medium',
            importance: chapter.importance || 0.5
          }));

          allChapters.push(...processedChapters);
        }

        // Small delay between segments
        if (i < segments.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

      } catch (error) {
        this.logger.warn(`Failed to analyze segment ${i + 1}:`, error);
        
        // Add basic chapter for this segment
        allChapters.push({
          title: `Part ${i + 1}`,
          startTime: segment[0].start,
          endTime: segment[segment.length - 1].start + segment[segment.length - 1].duration,
          duration: segmentDuration,
          description: `Content from part ${i + 1} of the video`,
          keyPoints: [],
          difficulty: 'medium',
          importance: 0.5
        });
      }
    }

    // Merge and optimize chapters
    return this.optimizeChapters(allChapters, params);
  }

  /**
   * Build chapter generation prompt for LLM
   */
  private buildChapterGenerationPrompt(
    transcriptText: string,
    videoMetadata: any,
    params: GenerateVideoChaptersParams
  ): string {
    return `You are an expert video editor who creates logical chapter breakdowns for educational content.

Video Information:
- Title: ${videoMetadata.title}
- Duration: ${videoMetadata.duration}
- Category: ${videoMetadata.categoryId}

Requirements:
- Create ${params.maxChapters} or fewer chapters
- Each chapter should be at least ${params.minChapterLength} seconds
- ${params.includeDescriptions ? 'Include detailed descriptions' : 'Brief descriptions only'}

Transcript:
${transcriptText}

Analyze the content flow and create logical chapter divisions. Look for:
1. Topic transitions
2. Natural pauses or transitions
3. Introduction/conclusion sections
4. Distinct concepts or lessons
5. Changes in speaking pace or tone

Respond with JSON:
{
  "chapters": [
    {
      "title": "Clear, descriptive chapter title",
      "startTime": 0,
      "endTime": 120,
      "description": "What this chapter covers",
      "keyPoints": ["key point 1", "key point 2"],
      "difficulty": "easy|medium|hard",
      "importance": 0.8
    }
  ]
}

Important: Base timing on content analysis, not arbitrary divisions.`;
  }

  /**
   * Build segment analysis prompt for long videos
   */
  private buildSegmentAnalysisPrompt(
    segmentText: string,
    segmentNumber: number,
    totalSegments: number
  ): string {
    return `Analyze this segment (${segmentNumber}/${totalSegments}) of a video transcript and identify 1-3 logical chapters within it.

Segment Content:
${segmentText}

Focus on natural topic transitions and content changes. Each chapter should represent a distinct concept or discussion point.

Respond with JSON:
{
  "chapters": [
    {
      "title": "Chapter title",
      "relativeStart": 0,
      "relativeEnd": 180,
      "description": "Brief description",
      "keyPoints": ["point 1", "point 2"],
      "difficulty": "medium",
      "importance": 0.7
    }
  ]
}

Note: Use relative timestamps within this segment (0 = segment start).`;
  }

  /**
   * Process LLM chapter response into VideoChapter objects
   */
  private processLLMChapterResponse(
    chapterData: any,
    transcript: YouTubeTranscript[],
    params: GenerateVideoChaptersParams
  ): VideoChapter[] {
    if (!chapterData.chapters || !Array.isArray(chapterData.chapters)) {
      throw new Error('Invalid chapter response format');
    }

    const videoDuration = transcript[transcript.length - 1]?.start + transcript[transcript.length - 1]?.duration || 0;

    return chapterData.chapters
      .filter((chapter: any) => 
        chapter.endTime - chapter.startTime >= params.minChapterLength
      )
      .map((chapter: any) => ({
        title: chapter.title || 'Untitled Chapter',
        startTime: Math.max(0, chapter.startTime || 0),
        endTime: Math.min(videoDuration, chapter.endTime || chapter.startTime + params.minChapterLength),
        duration: (chapter.endTime || 0) - (chapter.startTime || 0),
        description: chapter.description || '',
        keyPoints: Array.isArray(chapter.keyPoints) ? chapter.keyPoints : [],
        difficulty: ['easy', 'medium', 'hard'].includes(chapter.difficulty) ? chapter.difficulty : 'medium',
        importance: Math.max(0, Math.min(1, chapter.importance || 0.5))
      }))
      .slice(0, params.maxChapters);
  }

  /**
   * Rule-based chapter generation fallback
   */
  private generateChaptersRuleBased(
    transcript: YouTubeTranscript[],
    params: GenerateVideoChaptersParams
  ): VideoChapter[] {
    const videoDuration = transcript[transcript.length - 1]?.start + transcript[transcript.length - 1]?.duration || 0;
    const idealChapterLength = Math.max(params.minChapterLength, videoDuration / params.maxChapters);
    
    const chapters: VideoChapter[] = [];
    let currentStart = 0;
    let chapterIndex = 1;

    while (currentStart < videoDuration && chapters.length < params.maxChapters) {
      const endTime = Math.min(currentStart + idealChapterLength, videoDuration);
      
      // Find natural break points (silence or topic changes)
      const adjustedEndTime = this.findNaturalBreakPoint(transcript, currentStart, endTime);

      // Get content for this chapter
      const chapterTranscript = transcript.filter(t => 
        t.start >= currentStart && t.start < adjustedEndTime
      );
      
      const chapterText = chapterTranscript.map(t => t.text).join(' ');
      const keyPoints = this.extractKeyPointsRuleBased(chapterText);

      chapters.push({
        title: `Chapter ${chapterIndex}`,
        startTime: Math.round(currentStart),
        endTime: Math.round(adjustedEndTime),
        duration: Math.round(adjustedEndTime - currentStart),
        description: `Content from ${this.formatTime(currentStart)} to ${this.formatTime(adjustedEndTime)}`,
        keyPoints,
        difficulty: 'medium',
        importance: 0.6
      });

      currentStart = adjustedEndTime;
      chapterIndex++;
    }

    return chapters;
  }

  /**
   * Find natural break points in transcript
   */
  private findNaturalBreakPoint(
    transcript: YouTubeTranscript[],
    startTime: number,
    idealEndTime: number
  ): number {
    const searchWindow = 30; // Look within 30 seconds of ideal end time
    const candidates = transcript.filter(t => 
      t.start >= idealEndTime - searchWindow && 
      t.start <= idealEndTime + searchWindow
    );

    // Look for natural pause indicators
    const breakIndicators = ['.', '!', '?', 'so', 'now', 'next', 'alright', 'okay'];
    
    for (const candidate of candidates) {
      const text = candidate.text.toLowerCase();
      if (breakIndicators.some(indicator => text.includes(indicator))) {
        return candidate.start;
      }
    }

    return idealEndTime; // Fallback to ideal time
  }

  /**
   * Extract key points using rule-based approach
   */
  private extractKeyPointsRuleBased(text: string): string[] {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    
    // Look for sentences with important indicators
    const importantSentences = sentences.filter(sentence => {
      const lower = sentence.toLowerCase();
      return (
        lower.includes('important') ||
        lower.includes('key') ||
        lower.includes('remember') ||
        lower.includes('main') ||
        lower.includes('first') ||
        lower.includes('second') ||
        lower.includes('finally')
      );
    });

    return importantSentences.slice(0, 3).map(s => s.trim());
  }

  /**
   * Enhance chapters with additional analysis
   */
  private async enhanceChapters(
    chapters: VideoChapter[],
    transcript: YouTubeTranscript[]
  ): Promise<VideoChapter[]> {
    return Promise.all(
      chapters.map(async (chapter) => {
        try {
          // Get transcript for this chapter
          const chapterTranscript = transcript.filter(t => 
            t.start >= chapter.startTime && t.start < chapter.endTime
          );

          // Enhance with better descriptions if possible
          if (chapterTranscript.length > 0) {
            const enhanced = await this.enhanceChapterDescription(chapter, chapterTranscript);
            return enhanced;
          }

          return chapter;
        } catch (error) {
          this.logger.warn(`Failed to enhance chapter "${chapter.title}":`, error);
          return chapter;
        }
      })
    );
  }

  /**
   * Enhance individual chapter description using LLM
   */
  private async enhanceChapterDescription(
    chapter: VideoChapter,
    chapterTranscript: YouTubeTranscript[]
  ): Promise<VideoChapter> {
    try {
      const chapterText = chapterTranscript.map(t => t.text).join(' ');
      
      if (chapterText.length < 50) return chapter; // Skip very short chapters

      const prompt = `Analyze this chapter content and create a better title and description.

Chapter Title: ${chapter.title}
Duration: ${this.formatTime(chapter.duration)}
Content: ${chapterText.slice(0, 1000)}...

Create:
1. A more descriptive title (max 6 words)
2. A brief description of what's covered
3. 2-3 key takeaways

Respond with JSON:
{
  "title": "Better chapter title",
  "description": "What this chapter covers",
  "keyPoints": ["takeaway 1", "takeaway 2"]
}`;

      const response = await this.llmService.generateWithFallback({
        prompt,
        model: 'gpt-4o-mini',
        maxTokens: 300,
        temperature: 0.2,
        responseFormat: 'json'
      });

      const enhancement = JSON.parse(response.content);
      
      return {
        ...chapter,
        title: enhancement.title || chapter.title,
        description: enhancement.description || chapter.description,
        keyPoints: enhancement.keyPoints || chapter.keyPoints
      };

    } catch (error) {
      this.logger.warn(`Failed to enhance chapter description:`, error);
      return chapter;
    }
  }

  /**
   * Generate comprehensive chapter analysis
   */
  private generateChapterAnalysis(
    videoId: string,
    chapters: VideoChapter[],
    videoMetadata: any
  ): ChapterAnalysis {
    const avgChapterLength = chapters.length > 0 
      ? chapters.reduce((sum, ch) => sum + ch.duration, 0) / chapters.length 
      : 0;

    // Analyze content flow
    const contentFlow = this.analyzeContentFlow(chapters);
    
    // Analyze difficulty progression
    const difficultyProgression = chapters.map(ch => ch.difficulty);
    
    // Find recommended break points (chapters with high importance)
    const recommendedBreakpoints = chapters
      .filter(ch => ch.importance > 0.7)
      .map(ch => ch.startTime);

    // Create quick access navigation
    const quickAccess = this.createQuickAccessNavigation(chapters);

    // Generate learning path suggestions
    const learningPath = this.generateLearningPath(chapters);

    // Identify skippable sections
    const skipSuggestions = chapters
      .filter(ch => ch.difficulty === 'easy' && ch.importance < 0.4)
      .map(ch => chapters.indexOf(ch));

    return {
      videoId,
      chapters,
      metadata: {
        totalChapters: chapters.length,
        avgChapterLength: Math.round(avgChapterLength),
        contentFlow,
        difficultyProgression,
        recommendedBreakpoints
      },
      navigation: {
        quickAccess,
        learningPath,
        skipSuggestions
      }
    };
  }

  // Helper methods
  private segmentTranscript(transcript: YouTubeTranscript[], segmentDuration: number): YouTubeTranscript[][] {
    const segments: YouTubeTranscript[][] = [];
    let currentSegment: YouTubeTranscript[] = [];
    let segmentStartTime = 0;

    for (const item of transcript) {
      if (item.start - segmentStartTime >= segmentDuration && currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [item];
        segmentStartTime = item.start;
      } else {
        currentSegment.push(item);
      }
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
  }

  private optimizeChapters(chapters: VideoChapter[], params: GenerateVideoChaptersParams): VideoChapter[] {
    // Remove very short chapters and merge if necessary
    let optimized = chapters.filter(ch => ch.duration >= params.minChapterLength);
    
    // If too many chapters, merge similar adjacent ones
    if (optimized.length > params.maxChapters) {
      optimized = this.mergeChapters(optimized, params.maxChapters);
    }

    return optimized;
  }

  private mergeChapters(chapters: VideoChapter[], maxChapters: number): VideoChapter[] {
    if (chapters.length <= maxChapters) return chapters;

    // Simple merging strategy: combine adjacent chapters with similar difficulty
    const merged: VideoChapter[] = [];
    
    for (let i = 0; i < chapters.length; i++) {
      if (merged.length >= maxChapters) break;
      
      const current = chapters[i];
      const next = chapters[i + 1];
      
      if (next && merged.length < maxChapters - 1 && current.difficulty === next.difficulty) {
        // Merge current and next
        merged.push({
          title: `${current.title} & ${next.title}`,
          startTime: current.startTime,
          endTime: next.endTime,
          duration: next.endTime - current.startTime,
          description: `${current.description} ${next.description}`,
          keyPoints: [...current.keyPoints, ...next.keyPoints],
          difficulty: current.difficulty,
          importance: Math.max(current.importance, next.importance)
        });
        i++; // Skip next chapter as it's been merged
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  private analyzeContentFlow(chapters: VideoChapter[]): string {
    const difficulties = chapters.map(ch => ch.difficulty);
    
    if (difficulties.every(d => d === 'easy')) return 'Consistently easy throughout';
    if (difficulties.every(d => d === 'hard')) return 'Consistently challenging';
    
    // Check for logical progression
    const progression = difficulties.join(' -> ');
    if (progression.includes('easy') && progression.includes('hard')) {
      return 'Progresses from easy to complex topics';
    }
    
    return 'Mixed difficulty levels';
  }

  private createQuickAccessNavigation(chapters: VideoChapter[]): Array<{ topic: string; chapters: number[] }> {
    // Group chapters by common keywords in titles
    const topicGroups: Record<string, number[]> = {};
    
    chapters.forEach((chapter, index) => {
      const words = chapter.title.toLowerCase().split(' ');
      const significantWords = words.filter(word => 
        word.length > 3 && !['the', 'and', 'for', 'with'].includes(word)
      );
      
      significantWords.forEach(word => {
        if (!topicGroups[word]) topicGroups[word] = [];
        topicGroups[word].push(index);
      });
    });

    return Object.entries(topicGroups)
      .filter(([_, chapters]) => chapters.length > 1)
      .slice(0, 5) // Top 5 topics
      .map(([topic, chapterIndices]) => ({ topic, chapters: chapterIndices }));
  }

  private generateLearningPath(chapters: VideoChapter[]): string[] {
    return chapters
      .sort((a, b) => {
        // Sort by difficulty, then by importance
        const diffOrder = { easy: 1, medium: 2, hard: 3 };
        const aDiff = diffOrder[a.difficulty] || 2;
        const bDiff = diffOrder[b.difficulty] || 2;
        
        if (aDiff !== bDiff) return aDiff - bDiff;
        return b.importance - a.importance;
      })
      .map(ch => ch.title);
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}