#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger, format, transports, Logger } from 'winston';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { YouTubeClient } from './youtube-client.js';
import { CacheManager } from './utils/cache.js';
import { QuotaManager } from './utils/quota.js';
import { TranscriptProcessor } from './utils/transcript.js';
import { RobustLLMService } from './utils/llm-service.js';
import type { YouTubeMCPConfig } from './types.js';

// Import Phase 1 tool handlers
import { YouTubeSearchTool } from './tools/search.js';
import { VideoDetailsTool } from './tools/video-details.js';
import { TrendingVideosTool } from './tools/trending.js';
import { AnalyzeContentTool } from './tools/analyze.js';
import { ChannelSearchTool } from './tools/channels.js';

// Import Phase 2 tool handlers
import { LearningPathGenerator } from './tools/learning-path.js';
import { CommentIntentAnalyzer } from './tools/comment-intent.js';
import { ELI5Simplifier } from './tools/eli5-simplifier.js';
import { ChapterGenerator } from './tools/chapter-generator.js';
import { KnowledgeGraphGenerator } from './tools/knowledge-graph.js';

// Load environment variables
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class YouTubeKnowledgeMCP {
  private server!: Server;
  private logger!: Logger;
  private youtubeClient!: YouTubeClient;
  private cache!: CacheManager;
  private quotaManager!: QuotaManager;
  private transcriptProcessor!: TranscriptProcessor;
  private llmService!: RobustLLMService;
  private config!: YouTubeMCPConfig;

  // Phase 1 tool handlers
  private searchTool!: YouTubeSearchTool;
  private videoDetailsTool!: VideoDetailsTool;
  private trendingTool!: TrendingVideosTool;
  private analyzeTool!: AnalyzeContentTool;
  private channelTool!: ChannelSearchTool;

  // Phase 2 tool handlers
  private learningPathTool!: LearningPathGenerator;
  private commentIntentTool!: CommentIntentAnalyzer;
  private eli5Tool!: ELI5Simplifier;
  private chapterTool!: ChapterGenerator;
  private knowledgeGraphTool!: KnowledgeGraphGenerator;

  constructor() {
    this.initializeLogger();
    this.loadConfiguration();
    this.initializeComponents();
    this.setupServer();
  }

  private initializeLogger(): void {
    const logLevel = (process.env.LOG_LEVEL as any) || 'info';
    
    // For MCP servers, we need to log to stderr to avoid interfering with stdio communication
    this.logger = createLogger({
      level: logLevel,
      format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
      ),
      transports: [
        new transports.Console({
          stderrLevels: ['error', 'warn', 'info', 'debug'],
          format: format.combine(
            format.colorize(),
            format.simple()
          )
        })
      ]
    });

    this.logger.info('YouTube Knowledge MCP Server initializing...');
  }

  private loadConfiguration(): void {
    try {
      const configPath = join(__dirname, '../config/youtube-mcp.json');
      const configFile = readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(configFile);
      this.logger.info('Configuration loaded successfully');
    } catch (error) {
      this.logger.warn('Failed to load config file, using defaults:', error);
      this.config = {
        caching: {
          transcripts: 86400,
          videoDetails: 3600,
          searchResults: 1800,
          comments: 7200
        },
        quotaManagement: {
          dailyLimit: parseInt(process.env.MAX_DAILY_QUOTA || '8000'),
          reserveBuffer: 1000,
          prioritizeRecent: true
        },
        features: {
          enableCommentAnalysis: true,
          enableTranscriptExtraction: true,
          enableTrendingDiscovery: true
        }
      };
    }
  }

  private initializeComponents(): void {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      throw new Error('YOUTUBE_API_KEY environment variable is required');
    }

    // Initialize cache
    const cacheConfig = {
      ttl: this.config.caching,
      redis: process.env.REDIS_URL ? {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD
      } : undefined
    };
    
    this.cache = new CacheManager(cacheConfig, this.logger);
    
    // Initialize quota manager
    this.quotaManager = new QuotaManager(
      {
        ...this.config.quotaManagement,
        warningThreshold: 75
      },
      this.logger,
      this.cache
    );

    // Initialize YouTube client
    this.youtubeClient = new YouTubeClient(
      apiKey,
      this.logger,
      this.config.quotaManagement.dailyLimit
    );

    // Initialize transcript processor
    this.transcriptProcessor = new TranscriptProcessor(this.logger);

    // Initialize LLM service for Phase 2 features
    this.llmService = new RobustLLMService(this.cache, this.logger);

    // Initialize Phase 1 tool handlers
    this.searchTool = new YouTubeSearchTool(this.youtubeClient, this.cache, this.quotaManager, this.logger);
    this.videoDetailsTool = new VideoDetailsTool(this.youtubeClient, this.cache, this.quotaManager, this.transcriptProcessor, this.logger);
    this.trendingTool = new TrendingVideosTool(this.youtubeClient, this.cache, this.quotaManager, this.logger);
    this.analyzeTool = new AnalyzeContentTool(this.youtubeClient, this.cache, this.transcriptProcessor, this.logger);
    this.channelTool = new ChannelSearchTool(this.youtubeClient, this.cache, this.quotaManager, this.logger);

    // Initialize Phase 2 tool handlers
    this.learningPathTool = new LearningPathGenerator(this.youtubeClient, this.cache, this.quotaManager, this.llmService, this.logger);
    this.commentIntentTool = new CommentIntentAnalyzer(this.youtubeClient, this.cache, this.llmService, this.logger);
    this.eli5Tool = new ELI5Simplifier(this.youtubeClient, this.cache, this.llmService, this.transcriptProcessor, this.logger);
    this.chapterTool = new ChapterGenerator(this.youtubeClient, this.cache, this.llmService, this.transcriptProcessor, this.logger);
    this.knowledgeGraphTool = new KnowledgeGraphGenerator(this.youtubeClient, this.cache, this.llmService, this.transcriptProcessor, this.logger);

    this.logger.info('All Phase 1 and Phase 2 components initialized successfully');
  }

  private setupServer(): void {
    this.server = new Server(
      {
        name: 'youtube-knowledge-mcp',
        version: '2.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupToolHandlers();
    this.logger.info('MCP server setup completed');
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        {
          name: 'youtube_search',
          description: 'Search for videos on YouTube with advanced filtering options',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for YouTube videos'
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results (1-50)',
                minimum: 1,
                maximum: 50,
                default: 10
              },
              publishedAfter: {
                type: 'string',
                description: 'Filter videos published after this date (ISO 8601 format)'
              },
              publishedBefore: {
                type: 'string',
                description: 'Filter videos published before this date (ISO 8601 format)'
              },
              order: {
                type: 'string',
                enum: ['relevance', 'date', 'rating', 'viewCount', 'title'],
                default: 'relevance',
                description: 'Sort order for results'
              },
              videoDuration: {
                type: 'string',
                enum: ['any', 'short', 'medium', 'long'],
                default: 'any',
                description: 'Filter by video duration'
              },
              videoDefinition: {
                type: 'string',
                enum: ['any', 'high', 'standard'],
                default: 'any',
                description: 'Filter by video quality'
              },
              regionCode: {
                type: 'string',
                description: 'Region code for localized results (e.g., "US", "GB")'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'get_video_details',
          description: 'Get comprehensive information about a specific YouTube video',
          inputSchema: {
            type: 'object',
            properties: {
              videoId: {
                type: 'string',
                description: 'YouTube video ID'
              },
              includeTranscript: {
                type: 'boolean',
                default: true,
                description: 'Whether to include video transcript'
              },
              includeComments: {
                type: 'boolean',
                default: true,
                description: 'Whether to include video comments'
              },
              maxComments: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                default: 50,
                description: 'Maximum number of comments to retrieve'
              },
              commentsOrder: {
                type: 'string',
                enum: ['relevance', 'time'],
                default: 'relevance',
                description: 'Sort order for comments'
              }
            },
            required: ['videoId']
          }
        },
        {
          name: 'get_trending_videos',
          description: 'Discover trending videos in different categories and regions',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Category ID or name (e.g., "Technology", "Education")'
              },
              region: {
                type: 'string',
                default: 'US',
                description: 'Region code for trending videos'
              },
              maxResults: {
                type: 'number',
                minimum: 1,
                maximum: 50,
                default: 25,
                description: 'Maximum number of trending videos to return'
              }
            }
          }
        },
        {
          name: 'analyze_video_content',
          description: 'Get AI-powered analysis and insights from video content',
          inputSchema: {
            type: 'object',
            properties: {
              videoId: {
                type: 'string',
                description: 'YouTube video ID to analyze'
              },
              analysisType: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['topics', 'sentiment', 'questions', 'summary', 'keywords']
                },
                default: ['summary'],
                description: 'Types of analysis to perform'
              },
              includeComments: {
                type: 'boolean',
                default: false,
                description: 'Include comments in the analysis'
              }
            },
            required: ['videoId']
          }
        },
        {
          name: 'search_channels',
          description: 'Find and analyze YouTube channels',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for YouTube channels'
              },
              maxResults: {
                type: 'number',
                minimum: 1,
                maximum: 50,
                default: 10,
                description: 'Maximum number of channels to return'
              },
              includeStats: {
                type: 'boolean',
                default: true,
                description: 'Whether to include channel statistics'
              },
              order: {
                type: 'string',
                enum: ['relevance', 'date', 'viewCount', 'videoCount'],
                default: 'relevance',
                description: 'Sort order for channels'
              }
            },
            required: ['query']
          }
        },
        // Phase 2 AI-powered tools
        {
          name: 'generate_learning_path',
          description: 'Generate AI-powered learning paths from YouTube content with difficulty assessment',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Topic or subject for the learning path'
              },
              targetLevel: {
                type: 'string',
                enum: ['beginner', 'intermediate', 'advanced'],
                default: 'beginner',
                description: 'Target skill level for the learning path'
              },
              maxVideos: {
                type: 'number',
                minimum: 5,
                maximum: 50,
                default: 20,
                description: 'Maximum number of videos to include'
              },
              includeQuizzes: {
                type: 'boolean',
                default: false,
                description: 'Whether to generate quiz questions'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'analyze_comment_intents',
          description: 'Analyze YouTube comments to extract user intents and actionable insights',
          inputSchema: {
            type: 'object',
            properties: {
              videoId: {
                type: 'string',
                description: 'YouTube video ID to analyze comments from'
              },
              maxComments: {
                type: 'number',
                minimum: 10,
                maximum: 200,
                default: 100,
                description: 'Maximum number of comments to analyze'
              },
              intentCategories: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Custom intent categories to focus on (optional)'
              }
            },
            required: ['videoId']
          }
        },
        {
          name: 'simplify_video_transcript',
          description: 'Create age-appropriate simplified versions of video transcripts (ELI5 mode)',
          inputSchema: {
            type: 'object',
            properties: {
              videoId: {
                type: 'string',
                description: 'YouTube video ID to simplify'
              },
              targetAge: {
                type: 'number',
                minimum: 5,
                maximum: 18,
                default: 12,
                description: 'Target age for simplification'
              },
              outputFormat: {
                type: 'string',
                enum: ['paragraph', 'bullet_points', 'qa'],
                default: 'paragraph',
                description: 'Preferred output format'
              },
              includeDefinitions: {
                type: 'boolean',
                default: true,
                description: 'Include definitions for key terms'
              }
            },
            required: ['videoId']
          }
        },
        {
          name: 'generate_video_chapters',
          description: 'Generate AI-powered video chapters with timestamps and descriptions',
          inputSchema: {
            type: 'object',
            properties: {
              videoId: {
                type: 'string',
                description: 'YouTube video ID to generate chapters for'
              },
              maxChapters: {
                type: 'number',
                minimum: 3,
                maximum: 20,
                default: 10,
                description: 'Maximum number of chapters to generate'
              },
              minChapterLength: {
                type: 'number',
                minimum: 30,
                maximum: 600,
                default: 60,
                description: 'Minimum chapter length in seconds'
              },
              includeDescriptions: {
                type: 'boolean',
                default: true,
                description: 'Include detailed chapter descriptions'
              }
            },
            required: ['videoId']
          }
        },
        {
          name: 'generate_knowledge_graph',
          description: 'Create cross-video knowledge graphs showing concept relationships',
          inputSchema: {
            type: 'object',
            properties: {
              videoIds: {
                type: 'array',
                items: {
                  type: 'string'
                },
                minItems: 2,
                maxItems: 10,
                description: 'YouTube video IDs to create knowledge graph from'
              },
              graphDepth: {
                type: 'string',
                enum: ['shallow', 'medium', 'deep'],
                default: 'medium',
                description: 'Depth of concept extraction and analysis'
              },
              focusTopics: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Specific topics to focus on (optional)'
              },
              includeTranscripts: {
                type: 'boolean',
                default: true,
                description: 'Include transcript content in analysis'
              }
            },
            required: ['videoIds']
          }
        }
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        this.logger.info(`Tool called: ${name}`, args);

        let result;
        
        switch (name) {
          case 'youtube_search':
            result = await this.searchTool.execute(args);
            break;
          
          case 'get_video_details':
            result = await this.videoDetailsTool.execute(args);
            break;
          
          case 'get_trending_videos':
            result = await this.trendingTool.execute(args);
            break;
          
          case 'analyze_video_content':
            result = await this.analyzeTool.execute(args);
            break;
          
          case 'search_channels':
            result = await this.channelTool.execute(args);
            break;
          
          // Phase 2 tools
          case 'generate_learning_path':
            result = await this.learningPathTool.execute(args);
            break;
          
          case 'analyze_comment_intents':
            result = await this.commentIntentTool.execute(args);
            break;
          
          case 'simplify_video_transcript':
            result = await this.eli5Tool.execute(args);
            break;
          
          case 'generate_video_chapters':
            result = await this.chapterTool.execute(args);
            break;
          
          case 'generate_knowledge_graph':
            result = await this.knowledgeGraphTool.execute(args);
            break;
          
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };

      } catch (error) {
        this.logger.error(`Tool execution failed for ${name}:`, error as any);
        
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    this.logger.info('YouTube Knowledge MCP Server started successfully');
    this.logger.info('Server is ready to handle requests');
    
    // Log quota status
    const quotaUsage = this.quotaManager.getUsage();
    this.logger.info(`Current quota usage: ${quotaUsage.used}/${quotaUsage.limit} (${quotaUsage.percentage.toFixed(1)}%)`);
  }

  public async stop(): Promise<void> {
    await this.cache.close();
    this.logger.info('YouTube Knowledge MCP Server stopped');
  }
}

// Handle process signals
process.on('SIGINT', async () => {
  process.stderr.write('\\nReceived SIGINT, shutting down gracefully...\\n');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  process.stderr.write('\\nReceived SIGTERM, shutting down gracefully...\\n');
  process.exit(0);
});

// Start the server
const mcpServer = new YouTubeKnowledgeMCP();

mcpServer.start().catch((error) => {
  process.stderr.write(`Failed to start YouTube Knowledge MCP Server: ${error}\\n`);
  process.exit(1);
});