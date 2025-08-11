import { z } from 'zod';

// YouTube API Types
export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnails: {
    default?: { url: string; width: number; height: number };
    medium?: { url: string; width: number; height: number };
    high?: { url: string; width: number; height: number };
    standard?: { url: string; width: number; height: number };
    maxres?: { url: string; width: number; height: number };
  };
  duration?: string;
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
  tags?: string[];
  categoryId?: string;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  description: string;
  subscriberCount?: string;
  videoCount?: string;
  viewCount?: string;
  publishedAt: string;
  thumbnails: {
    default?: { url: string; width: number; height: number };
    medium?: { url: string; width: number; height: number };
    high?: { url: string; width: number; height: number };
  };
  country?: string;
}

export interface YouTubeComment {
  id: string;
  authorDisplayName: string;
  authorChannelId?: string;
  textDisplay: string;
  textOriginal: string;
  likeCount: number;
  publishedAt: string;
  updatedAt: string;
  parentId?: string;
}

export interface YouTubeTranscript {
  text: string;
  start: number;
  duration: number;
}

// MCP Tool Schemas
export const YouTubeSearchSchema = z.object({
  query: z.string().describe('Search query for YouTube videos'),
  maxResults: z.number().min(1).max(50).default(10).describe('Maximum number of results to return'),
  publishedAfter: z.string().optional().describe('Filter videos published after this date (ISO 8601)'),
  publishedBefore: z.string().optional().describe('Filter videos published before this date (ISO 8601)'),
  order: z.enum(['relevance', 'date', 'rating', 'viewCount', 'title']).default('relevance').describe('Sort order for results'),
  videoDuration: z.enum(['any', 'short', 'medium', 'long']).default('any').describe('Filter by video duration'),
  videoDefinition: z.enum(['any', 'high', 'standard']).default('any').describe('Filter by video quality'),
  regionCode: z.string().optional().describe('Region code for localized results (e.g., "US", "GB")'),
});

export const GetVideoDetailsSchema = z.object({
  videoId: z.string().describe('YouTube video ID'),
  includeTranscript: z.boolean().default(true).describe('Whether to include video transcript'),
  includeComments: z.boolean().default(true).describe('Whether to include video comments'),
  maxComments: z.number().min(1).max(100).default(50).describe('Maximum number of comments to retrieve'),
  commentsOrder: z.enum(['relevance', 'time']).default('relevance').describe('Sort order for comments'),
});

export const GetTrendingVideosSchema = z.object({
  category: z.string().optional().describe('Category ID or name (e.g., "Technology", "Education")'),
  region: z.string().default('US').describe('Region code for trending videos'),
  maxResults: z.number().min(1).max(50).default(25).describe('Maximum number of trending videos to return'),
});

export const AnalyzeVideoContentSchema = z.object({
  videoId: z.string().describe('YouTube video ID to analyze'),
  analysisType: z.array(z.enum(['topics', 'sentiment', 'questions', 'summary', 'keywords'])).default(['summary']).describe('Types of analysis to perform'),
  includeComments: z.boolean().default(false).describe('Include comments in the analysis'),
});

export const SearchChannelsSchema = z.object({
  query: z.string().describe('Search query for YouTube channels'),
  maxResults: z.number().min(1).max(50).default(10).describe('Maximum number of channels to return'),
  includeStats: z.boolean().default(true).describe('Whether to include channel statistics'),
  order: z.enum(['relevance', 'date', 'viewCount', 'videoCount']).default('relevance').describe('Sort order for channels'),
});

// Type inference from schemas
export type YouTubeSearchParams = z.infer<typeof YouTubeSearchSchema>;
export type GetVideoDetailsParams = z.infer<typeof GetVideoDetailsSchema>;
export type GetTrendingVideosParams = z.infer<typeof GetTrendingVideosSchema>;
export type AnalyzeVideoContentParams = z.infer<typeof AnalyzeVideoContentSchema>;
export type SearchChannelsParams = z.infer<typeof SearchChannelsSchema>;

// API Response Types
export interface YouTubeSearchResult {
  videos: YouTubeVideo[];
  totalResults: number;
  nextPageToken?: string;
  prevPageToken?: string;
}

export interface VideoDetailsResult {
  video: YouTubeVideo;
  transcript?: YouTubeTranscript[];
  comments?: YouTubeComment[];
  analysis?: {
    topics?: string[];
    sentiment?: 'positive' | 'negative' | 'neutral';
    keywords?: string[];
    summary?: string;
    questions?: string[];
  };
}

export interface TrendingVideosResult {
  videos: YouTubeVideo[];
  category?: string;
  region: string;
}

export interface ChannelSearchResult {
  channels: YouTubeChannel[];
  totalResults: number;
  nextPageToken?: string;
  prevPageToken?: string;
}

// Configuration Types
export interface YouTubeMCPConfig {
  caching: {
    transcripts: number;
    videoDetails: number;
    searchResults: number;
    comments: number;
  };
  quotaManagement: {
    dailyLimit: number;
    reserveBuffer: number;
    prioritizeRecent: boolean;
  };
  features: {
    enableCommentAnalysis: boolean;
    enableTranscriptExtraction: boolean;
    enableTrendingDiscovery: boolean;
  };
}

// Cache Types
export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  ttl: number;
}

// Error Types
export class YouTubeAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public quotaExceeded?: boolean
  ) {
    super(message);
    this.name = 'YouTubeAPIError';
  }
}

export class QuotaExceededError extends YouTubeAPIError {
  constructor(message: string = 'YouTube API quota exceeded') {
    super(message, 403, true);
    this.name = 'QuotaExceededError';
  }
}

// Logger configuration
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  level: LogLevel;
  enableAnalytics: boolean;
}

// Analytics Types
export interface UsageAnalytics {
  toolCalls: Record<string, number>;
  quotaUsage: number;
  cacheHits: number;
  cacheMisses: number;
  errors: Record<string, number>;
}

// Phase 2 Types - AI-Powered Features

// LLM Service Types
export interface LLMProvider {
  name: 'openai' | 'anthropic' | 'azure';
  priority: number;
  rateLimit: {
    rpm: number;
    tpm: number;
    currentUsage: { requests: number; tokens: number };
  };
}

export interface LLMRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
}

export interface LLMResponse {
  content: string;
  provider: string;
  tokensUsed: number;
  cost: number;
  processingTime: number;
}

// Phase 2 Tool Schemas
export const GenerateLearningPathSchema = z.object({
  query: z.string().describe('Topic or subject for the learning path'),
  targetLevel: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner').describe('Target difficulty level'),
  maxVideos: z.number().min(5).max(50).default(20).describe('Maximum number of videos in the path'),
  duration: z.string().optional().describe('Preferred total duration (e.g., "2 hours", "30 minutes")'),
  includeQuizzes: z.boolean().default(false).describe('Whether to generate quiz questions'),
});

export const GenerateKnowledgeGraphSchema = z.object({
  videoIds: z.array(z.string()).min(2).max(20).describe('Array of YouTube video IDs to analyze'),
  focusTopics: z.array(z.string()).optional().describe('Specific topics to focus on'),
  includeTranscripts: z.boolean().default(true).describe('Whether to analyze video transcripts'),
  graphDepth: z.enum(['shallow', 'medium', 'deep']).default('medium').describe('Depth of knowledge graph analysis'),
});

export const AnalyzeCommentIntentsSchema = z.object({
  videoId: z.string().describe('YouTube video ID'),
  maxComments: z.number().min(10).max(500).default(100).describe('Maximum comments to analyze'),
  intentCategories: z.array(z.string()).optional().describe('Custom intent categories to detect'),
  includeReplies: z.boolean().default(false).describe('Whether to include comment replies'),
});

export const SimplifyVideoTranscriptSchema = z.object({
  videoId: z.string().describe('YouTube video ID'),
  targetAge: z.number().min(5).max(18).default(12).describe('Target age for simplification'),
  includeDefinitions: z.boolean().default(true).describe('Include definitions for complex terms'),
  outputFormat: z.enum(['paragraph', 'bullet_points', 'qa']).default('paragraph').describe('Output format'),
});

export const GenerateVideoChaptersSchema = z.object({
  videoId: z.string().describe('YouTube video ID'),
  minChapterLength: z.number().min(30).max(600).default(120).describe('Minimum chapter length in seconds'),
  maxChapters: z.number().min(3).max(20).default(10).describe('Maximum number of chapters'),
  includeDescriptions: z.boolean().default(true).describe('Include chapter descriptions'),
});

// Phase 2 Response Types
export interface LearningPath {
  topic: string;
  level: string;
  videos: Array<{
    videoId: string;
    title: string;
    order: number;
    difficulty: string;
    duration: string;
    prerequisites: string[];
    learningObjectives: string[];
    keyTopics: string[];
    quizQuestions?: Array<{
      question: string;
      options: string[];
      correctAnswer: number;
      explanation: string;
    }>;
  }>;
  totalDuration: string;
  completionCriteria: string[];
  recommendations: string[];
}

export interface KnowledgeGraph {
  nodes: Array<{
    id: string;
    label: string;
    type: 'concept' | 'video' | 'topic' | 'person' | 'tool';
    weight: number;
    properties: Record<string, any>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relationship: string;
    weight: number;
    evidence: string[];
  }>;
  clusters: Array<{
    id: string;
    name: string;
    nodes: string[];
    description: string;
  }>;
  metadata: {
    totalConcepts: number;
    connectionDensity: number;
    primaryTopics: string[];
    confidenceScore: number;
  };
}

export interface CommentIntent {
  intent: 'question' | 'praise' | 'criticism' | 'request' | 'sharing' | 'correction' | 'discussion';
  confidence: number;
  text: string;
  author: string;
  timestamp: string;
  context?: string;
  suggestedResponse?: string;
}

export interface CommentIntentAnalysis {
  videoId: string;
  intents: CommentIntent[];
  summary: {
    totalComments: number;
    intentDistribution: Record<string, number>;
    topQuestions: string[];
    sentimentBreakdown: Record<string, number>;
    actionableInsights: string[];
  };
  trends: {
    timeBasedPatterns: Record<string, number>;
    engagementCorrelation: number;
    audienceSegments: Array<{
      segment: string;
      characteristics: string[];
      commonIntents: string[];
    }>;
  };
}

export interface SimplifiedTranscript {
  videoId: string;
  originalLength: number;
  simplifiedLength: number;
  targetAge: number;
  content: {
    title: string;
    summary: string;
    mainPoints: string[];
    keyTerms: Array<{
      term: string;
      definition: string;
      examples: string[];
    }>;
    sections: Array<{
      heading: string;
      content: string;
      timestamp?: number;
    }>;
  };
  readabilityScore: {
    original: number;
    simplified: number;
    improvement: number;
  };
}

export interface VideoChapter {
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  description: string;
  keyPoints: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  importance: number;
}

export interface ChapterAnalysis {
  videoId: string;
  chapters: VideoChapter[];
  metadata: {
    totalChapters: number;
    avgChapterLength: number;
    contentFlow: string;
    difficultyProgression: string[];
    recommendedBreakpoints: number[];
  };
  navigation: {
    quickAccess: Array<{
      topic: string;
      chapters: number[];
    }>;
    learningPath: string[];
    skipSuggestions: number[];
  };
}

// Type inference for Phase 2 schemas
export type GenerateLearningPathParams = z.infer<typeof GenerateLearningPathSchema>;
export type GenerateKnowledgeGraphParams = z.infer<typeof GenerateKnowledgeGraphSchema>;
export type AnalyzeCommentIntentsParams = z.infer<typeof AnalyzeCommentIntentsSchema>;
export type SimplifyVideoTranscriptParams = z.infer<typeof SimplifyVideoTranscriptSchema>;
export type GenerateVideoChaptersParams = z.infer<typeof GenerateVideoChaptersSchema>;

// Sentiment-Topic Fusion Types
export interface TopicSentiment {
  topic: string;
  sentiment: {
    positive: number;
    negative: number;
    neutral: number;
  };
  emotions: Array<{
    emotion: string;
    intensity: number;
  }>;
  context: string[];
  evidence: string[];
}

export interface SentimentTopicFusion {
  videoId: string;
  topicSentiments: TopicSentiment[];
  overallSentiment: {
    dominant: string;
    distribution: Record<string, number>;
    confidence: number;
  };
  insights: {
    polarizingTopics: string[];
    universallyPositive: string[];
    concernAreas: string[];
    opportunityAreas: string[];
  };
  recommendations: string[];
}

// Real-time Monitoring Types
export interface MonitoringRule {
  id: string;
  name: string;
  query: string;
  keywords: string[];
  channels?: string[];
  categories?: string[];
  enabled: boolean;
  notifications: {
    email?: string;
    webhook?: string;
    slack?: string;
  };
  filters: {
    minViews?: number;
    maxAge?: string;
    language?: string;
  };
}

export interface TrendingAlert {
  ruleId: string;
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number;
  trendingScore: number;
  matchedKeywords: string[];
  reason: string;
  urgency: 'low' | 'medium' | 'high';
}