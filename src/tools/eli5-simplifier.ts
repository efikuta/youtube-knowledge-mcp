import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { RobustLLMService } from '../utils/llm-service.js';
import { TranscriptProcessor } from '../utils/transcript.js';
import { 
  SimplifyVideoTranscriptParams, 
  SimplifyVideoTranscriptSchema,
  SimplifiedTranscript
} from '../types.js';

export class ELI5Simplifier {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private llmService: RobustLLMService,
    private transcriptProcessor: TranscriptProcessor,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<SimplifiedTranscript> {
    const params = SimplifyVideoTranscriptSchema.parse(args);
    
    this.logger.info(`Simplifying transcript for video ${params.videoId} (target age: ${params.targetAge})`);

    // Generate cache key
    const cacheKey = `eli5:${params.videoId}:${params.targetAge}:${params.outputFormat}:${params.includeDefinitions}`;

    // Check cache first
    const cached = await this.cache.get<SimplifiedTranscript>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached ELI5 transcript for: ${params.videoId}`);
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

      // Step 2: Process and prepare transcript
      const processedTranscript = this.transcriptProcessor.processTranscript(videoDetails.transcript);
      
      // Step 3: Simplify using LLM
      const simplifiedContent = await this.simplifyTranscript(
        processedTranscript.fullText,
        videoDetails.video,
        params
      );

      // Step 4: Calculate readability improvement
      const readabilityScores = this.calculateReadabilityScores(
        processedTranscript.fullText,
        simplifiedContent.content.sections.map(s => s.content).join(' ')
      );

      const result: SimplifiedTranscript = {
        videoId: params.videoId,
        originalLength: processedTranscript.fullText.length,
        simplifiedLength: simplifiedContent.content.sections.map(s => s.content).join(' ').length,
        targetAge: params.targetAge,
        content: simplifiedContent.content,
        readabilityScore: readabilityScores
      };

      // Cache the result
      await this.cache.set(cacheKey, result, 7200); // 2 hours cache
      
      this.logger.info(`ELI5 simplification completed for ${params.videoId}. Readability improved by ${readabilityScores.improvement}%`);
      
      return result;

    } catch (error) {
      this.logger.error(`Failed to simplify transcript for ${params.videoId}:`, error);
      throw error;
    }
  }

  /**
   * Simplify transcript using LLM with age-appropriate language
   */
  private async simplifyTranscript(
    originalText: string,
    videoMetadata: any,
    params: SimplifyVideoTranscriptParams
  ): Promise<{ content: SimplifiedTranscript['content'] }> {
    // Split long text into chunks to manage token limits
    const chunks = this.splitIntoChunks(originalText, 8000); // ~8k characters per chunk
    const simplifiedSections: Array<{ heading: string; content: string }> = [];
    const allKeyTerms: Array<{ term: string; definition: string; examples: string[] }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      try {
        const prompt = this.buildSimplificationPrompt(chunk, videoMetadata, params, i + 1);
        
        const response = await this.llmService.generateWithFallback({
          prompt,
          model: this.selectModelForComplexity(chunk.length),
          maxTokens: 2000,
          temperature: 0.2,
          responseFormat: 'json'
        });

        const chunkResult = JSON.parse(response.content);
        
        // Add section
        if (chunkResult.section) {
          simplifiedSections.push(chunkResult.section);
        }
        
        // Collect key terms
        if (chunkResult.keyTerms && Array.isArray(chunkResult.keyTerms)) {
          allKeyTerms.push(...chunkResult.keyTerms);
        }

        // Small delay between chunks to manage rate limits
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

      } catch (error) {
        this.logger.warn(`Failed to simplify chunk ${i + 1}:`, error);
        
        // Fallback to rule-based simplification
        const fallbackSection = this.ruleBasedSimplification(chunk, i + 1, params.targetAge);
        simplifiedSections.push(fallbackSection);
      }
    }

    // Generate overall summary
    const summary = await this.generateOverallSummary(
      simplifiedSections,
      videoMetadata,
      params.targetAge
    );

    // Generate main points
    const mainPoints = this.extractMainPoints(simplifiedSections);

    // Remove duplicate key terms
    const uniqueKeyTerms = this.removeDuplicateTerms(allKeyTerms);

    return {
      content: {
        title: this.simplifyTitle(videoMetadata.title, params.targetAge),
        summary,
        mainPoints,
        keyTerms: uniqueKeyTerms,
        sections: simplifiedSections
      }
    };
  }

  /**
   * Build simplification prompt for LLM
   */
  private buildSimplificationPrompt(
    text: string,
    videoMetadata: any,
    params: SimplifyVideoTranscriptParams,
    sectionNumber: number
  ): string {
    const ageGuidelines = this.getAgeAppropriateGuidelines(params.targetAge);
    
    return `You are an expert educator who specializes in explaining complex topics to ${params.targetAge}-year-olds. 

Video Context:
- Title: ${videoMetadata.title}
- Topic: Educational content about ${videoMetadata.categoryId}

Your task: Simplify this text section for a ${params.targetAge}-year-old audience.

Guidelines for age ${params.targetAge}:
${ageGuidelines}

Original Text Section ${sectionNumber}:
${text}

Requirements:
1. Use vocabulary appropriate for age ${params.targetAge}
2. Break complex ideas into simple steps
3. Use analogies and examples they can relate to
4. ${params.includeDefinitions ? 'Define any technical terms clearly' : 'Avoid technical terms or explain them simply'}
5. Make it engaging and easy to follow
6. ${this.getOutputFormatGuideline(params.outputFormat)}

Respond with JSON:
{
  "section": {
    "heading": "Simple, engaging section title",
    "content": "Age-appropriate simplified content"
  },
  "keyTerms": [
    {
      "term": "technical term",
      "definition": "simple explanation",
      "examples": ["relatable example 1", "example 2"]
    }
  ]
}`;
  }

  /**
   * Get age-appropriate writing guidelines
   */
  private getAgeAppropriateGuidelines(targetAge: number): string {
    if (targetAge <= 8) {
      return `- Use very simple words (1-2 syllables when possible)
- Short sentences (5-10 words)
- Concrete examples from daily life
- Avoid abstract concepts
- Use "you" to make it personal`;
    } else if (targetAge <= 12) {
      return `- Use common vocabulary, explain harder words
- Sentences of 10-15 words
- Use familiar comparisons and analogies
- Break complex ideas into steps
- Include questions to keep them engaged`;
    } else if (targetAge <= 16) {
      return `- Age-appropriate vocabulary with some challenge words explained
- Varied sentence length but clear structure
- Real-world applications and examples
- Encourage critical thinking
- Connect to their interests and experiences`;
    } else {
      return `- High school level vocabulary
- Clear, structured explanations
- Connect to future goals or current interests
- Include practical applications
- Encourage deeper understanding`;
    }
  }

  /**
   * Get output format guideline
   */
  private getOutputFormatGuideline(format: 'paragraph' | 'bullet_points' | 'qa'): string {
    switch (format) {
      case 'bullet_points':
        return 'Format as clear bullet points with simple, actionable statements';
      case 'qa':
        return 'Format as questions and answers that a curious learner might ask';
      default:
        return 'Format as clear, flowing paragraphs that tell a story';
    }
  }

  /**
   * Select appropriate model based on content complexity
   */
  private selectModelForComplexity(textLength: number): string {
    // For simplification tasks, we need good reasoning abilities
    if (textLength > 5000) {
      return 'gpt-4o'; // Better for complex simplification
    }
    return 'gpt-4o-mini'; // Cost-effective for shorter content
  }

  /**
   * Split text into manageable chunks
   */
  private splitIntoChunks(text: string, maxChunkSize: number): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += (currentChunk ? '. ' : '') + sentence;
      }
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  /**
   * Generate overall summary using LLM
   */
  private async generateOverallSummary(
    sections: Array<{ heading: string; content: string }>,
    videoMetadata: any,
    targetAge: number
  ): Promise<string> {
    try {
      const sectionsText = sections
        .map(section => `${section.heading}: ${section.content.slice(0, 200)}...`)
        .join('\n\n');

      const prompt = `Create a simple, engaging summary of this educational video for a ${targetAge}-year-old.

Video: "${videoMetadata.title}"

Key sections covered:
${sectionsText}

Write a 2-3 sentence summary that:
1. Explains what the video teaches in simple terms
2. Mentions why it's interesting or useful
3. Uses language appropriate for age ${targetAge}

Just return the summary text, no JSON needed.`;

      const response = await this.llmService.generateWithFallback({
        prompt,
        model: 'gpt-4o-mini',
        maxTokens: 200,
        temperature: 0.3
      });

      return response.content.trim();
      
    } catch (error) {
      this.logger.warn('Failed to generate summary, using fallback:', error);
      return `This video teaches about ${videoMetadata.title}. It covers important topics that are explained in a simple way.`;
    }
  }

  /**
   * Extract main points from sections
   */
  private extractMainPoints(sections: Array<{ heading: string; content: string }>): string[] {
    return sections.map(section => {
      // Extract first sentence as main point
      const firstSentence = section.content.split(/[.!?]/)[0];
      return firstSentence.trim() || section.heading;
    });
  }

  /**
   * Rule-based simplification fallback
   */
  private ruleBasedSimplification(
    text: string, 
    sectionNumber: number,
    targetAge: number
  ): { heading: string; content: string } {
    // Simple word replacement for common complex terms
    const simplifications: Record<string, string> = {
      'utilize': 'use',
      'demonstrate': 'show',
      'construct': 'build',
      'implement': 'do',
      'facilitate': 'help',
      'acquire': 'get',
      'comprehensive': 'complete',
      'fundamental': 'basic',
      'significant': 'important',
      'analyze': 'look at'
    };

    let simplified = text;
    
    // Replace complex words
    Object.entries(simplifications).forEach(([complex, simple]) => {
      const regex = new RegExp(`\\b${complex}\\b`, 'gi');
      simplified = simplified.replace(regex, simple);
    });

    // Shorten sentences
    const sentences = simplified.split(/[.!?]+/);
    const shortenedSentences = sentences
      .filter(s => s.trim().length > 0)
      .map(sentence => {
        if (sentence.length > 100) {
          // Split long sentences at conjunctions
          return sentence.split(/\b(and|but|or|because)\b/)[0].trim();
        }
        return sentence.trim();
      });

    return {
      heading: `Part ${sectionNumber}`,
      content: shortenedSentences.join('. ') + '.'
    };
  }

  /**
   * Simplify video title for target age
   */
  private simplifyTitle(title: string, targetAge: number): string {
    // Remove technical jargon and make more appealing
    let simplified = title
      .replace(/\b(Advanced|Professional|Expert|Master)\b/gi, '')
      .replace(/\b(Tutorial|Guide|Course)\b/gi, 'Learn About')
      .replace(/\b(Complete|Comprehensive|Ultimate)\b/gi, 'Fun');

    if (targetAge <= 12) {
      simplified = `Fun Way to ${simplified}`;
    }

    return simplified.trim();
  }

  /**
   * Remove duplicate key terms
   */
  private removeDuplicateTerms(
    terms: Array<{ term: string; definition: string; examples: string[] }>
  ): Array<{ term: string; definition: string; examples: string[] }> {
    const seen = new Set<string>();
    return terms.filter(term => {
      const normalizedTerm = term.term.toLowerCase();
      if (seen.has(normalizedTerm)) {
        return false;
      }
      seen.add(normalizedTerm);
      return true;
    });
  }

  /**
   * Calculate readability scores (simplified implementation)
   */
  private calculateReadabilityScores(originalText: string, simplifiedText: string): {
    original: number;
    simplified: number;
    improvement: number;
  } {
    const calculateScore = (text: string): number => {
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      const words = text.split(/\s+/).filter(w => w.length > 0);
      
      if (sentences.length === 0 || words.length === 0) return 0;
      
      const avgSentenceLength = words.length / sentences.length;
      const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / words.length;
      
      // Simple readability approximation (higher = more readable)
      return Math.max(0, 100 - (avgSentenceLength * 2) - (avgWordLength * 3));
    };

    const originalScore = calculateScore(originalText);
    const simplifiedScore = calculateScore(simplifiedText);
    const improvement = simplifiedScore > originalScore 
      ? ((simplifiedScore - originalScore) / originalScore) * 100 
      : 0;

    return {
      original: Math.round(originalScore),
      simplified: Math.round(simplifiedScore),
      improvement: Math.round(improvement)
    };
  }
}