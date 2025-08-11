import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { encode } from 'gpt-tokenizer';
import { Logger } from 'winston';
import { CacheManager } from './cache.js';
import {
  LLMProvider,
  LLMRequest,
  LLMResponse
} from '../types.js';

export class RobustLLMService {
  private providers: LLMProvider[];
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private cache: CacheManager;
  private logger: Logger;
  private userQuotas: Map<string, { daily: number; hourly: number }> = new Map();

  constructor(cache: CacheManager, logger: Logger) {
    this.cache = cache;
    this.logger = logger;
    this.initializeProviders();
    this.initializeClients();
    this.startResetTimer();
  }

  private initializeProviders(): void {
    this.providers = [
      {
        name: 'openai',
        priority: 1,
        rateLimit: {
          rpm: 3500,
          tpm: 200000,
          currentUsage: { requests: 0, tokens: 0 }
        }
      },
      {
        name: 'anthropic',
        priority: 2,
        rateLimit: {
          rpm: 2000,
          tpm: 150000,
          currentUsage: { requests: 0, tokens: 0 }
        }
      }
    ].filter(provider => this.isProviderConfigured(provider.name));
  }

  private isProviderConfigured(providerName: string): boolean {
    switch (providerName) {
      case 'openai':
        return !!process.env.OPENAI_API_KEY;
      case 'anthropic':
        return !!process.env.ANTHROPIC_API_KEY;
      default:
        return false;
    }
  }

  private initializeClients(): void {
    if (process.env.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 60000,
        maxRetries: 3
      });
    }

    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropicClient = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: 120000,
        maxRetries: 3
      });
    }
  }

  /**
   * Generate response with fallback across providers
   */
  async generateWithFallback(
    request: LLMRequest,
    userId: string = 'default'
  ): Promise<LLMResponse> {
    const errors: Array<{ provider: string; error: any }> = [];
    const startTime = Date.now();

    // Estimate token count for quota checking
    const estimatedTokens = this.estimateTokens(request.prompt);
    
    // Check user quota
    await this.checkUserQuota(userId, estimatedTokens);

    for (const provider of this.providers.sort((a, b) => a.priority - b.priority)) {
      try {
        // Check provider quota
        if (!this.canUseProvider(provider, estimatedTokens)) {
          continue;
        }

        // Check cache first
        const cacheKey = this.createCacheKey(request, provider.name);
        const cached = await this.cache.get<LLMResponse>(cacheKey);
        if (cached) {
          this.logger.info(`Returning cached LLM response from ${provider.name}`);
          return { ...cached, provider: provider.name };
        }

        // Generate response
        const response = await this.executeRequest(request, provider);
        
        // Record usage
        this.recordUsage(provider, response.tokensUsed, userId);
        
        // Cache response
        await this.cache.set(cacheKey, response, 3600); // 1 hour cache
        
        this.logger.info(`LLM request completed via ${provider.name}: ${response.tokensUsed} tokens, $${response.cost.toFixed(4)}`);
        
        return {
          ...response,
          provider: provider.name,
          processingTime: Date.now() - startTime
        };

      } catch (error) {
        errors.push({ provider: provider.name, error });
        
        this.logger.warn(`LLM provider ${provider.name} failed:`, error);
        
        // Don't fallback on certain errors
        if (this.isNonRetryableError(error)) {
          break;
        }
        
        // Wait before trying next provider
        await this.exponentialBackoff(errors.length);
      }
    }
    
    throw new AggregateError(
      errors.map(e => e.error),
      `All LLM providers failed. Tried: ${errors.map(e => e.provider).join(', ')}`
    );
  }

  /**
   * Execute request with specific provider
   */
  private async executeRequest(
    request: LLMRequest,
    provider: LLMProvider
  ): Promise<Omit<LLMResponse, 'provider' | 'processingTime'>> {
    switch (provider.name) {
      case 'openai':
        return this.executeOpenAIRequest(request);
      case 'anthropic':
        return this.executeAnthropicRequest(request);
      default:
        throw new Error(`Unsupported provider: ${provider.name}`);
    }
  }

  /**
   * Execute OpenAI request
   */
  private async executeOpenAIRequest(request: LLMRequest): Promise<Omit<LLMResponse, 'provider' | 'processingTime'>> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    const model = request.model || 'gpt-4o-mini';
    const response = await this.openaiClient.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert YouTube content analyst. Provide accurate, structured analysis.'
        },
        {
          role: 'user',
          content: request.prompt
        }
      ],
      max_tokens: request.maxTokens || 2000,
      temperature: request.temperature || 0.1,
      response_format: request.responseFormat === 'json' ? { type: 'json_object' } : undefined
    });

    const content = response.choices[0]?.message?.content || '';
    const tokensUsed = response.usage?.total_tokens || 0;
    const cost = this.calculateOpenAICost(model, tokensUsed);

    return {
      content,
      tokensUsed,
      cost
    };
  }

  /**
   * Execute Anthropic request
   */
  private async executeAnthropicRequest(request: LLMRequest): Promise<Omit<LLMResponse, 'provider' | 'processingTime'>> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    const model = request.model || 'claude-3-haiku-20240307';
    let systemPrompt = 'You are an expert YouTube content analyst. Provide accurate, structured analysis.';
    
    if (request.responseFormat === 'json') {
      systemPrompt += ' Always respond with valid JSON format.';
    }

    const response = await this.anthropicClient.messages.create({
      model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: request.prompt
        }
      ],
      max_tokens: request.maxTokens || 2000,
      temperature: request.temperature || 0.1
    });

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');
      
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
    const cost = this.calculateAnthropicCost(model, response.usage.input_tokens, response.usage.output_tokens);

    return {
      content,
      tokensUsed,
      cost
    };
  }

  /**
   * Calculate OpenAI costs (2024-2025 pricing)
   */
  private calculateOpenAICost(model: string, totalTokens: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o-mini': { input: 0.15, output: 0.60 }, // per 1M tokens
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 }
    };

    const rates = pricing[model] || pricing['gpt-4o-mini'];
    // Approximating 70% input, 30% output tokens
    const inputTokens = Math.floor(totalTokens * 0.7);
    const outputTokens = totalTokens - inputTokens;
    
    return (inputTokens * rates.input + outputTokens * rates.output) / 1000000;
  }

  /**
   * Calculate Anthropic costs (2024-2025 pricing)
   */
  private calculateAnthropicCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 }, // per 1M tokens
      'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
      'claude-3-5-opus-20241022': { input: 15.00, output: 75.00 }
    };

    const rates = pricing[model] || pricing['claude-3-haiku-20240307'];
    
    return (inputTokens * rates.input + outputTokens * rates.output) / 1000000;
  }

  /**
   * Estimate token count using GPT tokenizer
   */
  private estimateTokens(text: string): number {
    try {
      return encode(text).length;
    } catch (error) {
      // Fallback estimation: ~4 characters per token
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Check if provider can handle request
   */
  private canUseProvider(provider: LLMProvider, estimatedTokens: number): boolean {
    const usage = provider.rateLimit.currentUsage;
    return (
      usage.tokens + estimatedTokens <= provider.rateLimit.tpm &&
      usage.requests < provider.rateLimit.rpm
    );
  }

  /**
   * Check user quota limits
   */
  private async checkUserQuota(userId: string, estimatedTokens: number): Promise<void> {
    const userUsage = this.userQuotas.get(userId) || { daily: 0, hourly: 0 };
    
    if (userUsage.daily + estimatedTokens > 50000) { // 50k tokens per user per day
      throw new Error('User daily quota exceeded');
    }
    
    if (userUsage.hourly + estimatedTokens > 10000) { // 10k tokens per user per hour
      throw new Error('User hourly quota exceeded');
    }
  }

  /**
   * Record usage for quota tracking
   */
  private recordUsage(provider: LLMProvider, tokensUsed: number, userId: string): void {
    // Update provider usage
    provider.rateLimit.currentUsage.tokens += tokensUsed;
    provider.rateLimit.currentUsage.requests += 1;
    
    // Update user usage
    const userUsage = this.userQuotas.get(userId) || { daily: 0, hourly: 0 };
    userUsage.daily += tokensUsed;
    userUsage.hourly += tokensUsed;
    this.userQuotas.set(userId, userUsage);
  }

  /**
   * Create cache key for request
   */
  private createCacheKey(request: LLMRequest, provider: string): string {
    const key = JSON.stringify({
      prompt: request.prompt,
      model: request.model,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      responseFormat: request.responseFormat,
      provider
    });
    return `llm:${Buffer.from(key).toString('base64').slice(0, 50)}`;
  }

  /**
   * Check if error is non-retryable
   */
  private isNonRetryableError(error: any): boolean {
    return (
      error?.status === 400 || // Bad request
      error?.status === 401 || // Unauthorized
      error?.status === 403 || // Forbidden
      error?.code === 'context_length_exceeded' ||
      error?.type === 'invalid_request_error'
    );
  }

  /**
   * Exponential backoff delay
   */
  private async exponentialBackoff(attempt: number): Promise<void> {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Start quota reset timer
   */
  private startResetTimer(): void {
    // Reset hourly quotas
    setInterval(() => {
      for (const provider of this.providers) {
        provider.rateLimit.currentUsage = { requests: 0, tokens: 0 };
      }
      
      // Reset user hourly quotas
      for (const [userId, usage] of this.userQuotas.entries()) {
        usage.hourly = 0;
        this.userQuotas.set(userId, usage);
      }
      
      this.logger.debug('Hourly LLM quotas reset');
    }, 60 * 60 * 1000); // Every hour

    // Reset daily quotas
    setInterval(() => {
      for (const [userId, usage] of this.userQuotas.entries()) {
        usage.daily = 0;
        this.userQuotas.set(userId, usage);
      }
      
      this.logger.info('Daily LLM quotas reset');
    }, 24 * 60 * 60 * 1000); // Every day
  }

  /**
   * Get current usage statistics
   */
  getUsageStats(): {
    providers: Array<{
      name: string;
      usage: { requests: number; tokens: number };
      limits: { rpm: number; tpm: number };
    }>;
    totalUsers: number;
    totalTokensToday: number;
  } {
    const totalTokensToday = Array.from(this.userQuotas.values())
      .reduce((sum, usage) => sum + usage.daily, 0);

    return {
      providers: this.providers.map(p => ({
        name: p.name,
        usage: p.rateLimit.currentUsage,
        limits: { rpm: p.rateLimit.rpm, tpm: p.rateLimit.tpm }
      })),
      totalUsers: this.userQuotas.size,
      totalTokensToday
    };
  }

  /**
   * Select optimal model based on complexity and cost
   */
  selectOptimalModel(contentLength: number, complexity: 'low' | 'medium' | 'high'): {
    provider: string;
    model: string;
  } {
    // For high complexity or long content, use better models
    if (complexity === 'high' || contentLength > 20000) {
      return {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022'
      };
    }
    
    // For medium complexity
    if (complexity === 'medium' || contentLength > 5000) {
      return {
        provider: 'openai',
        model: 'gpt-4o'
      };
    }
    
    // For simple tasks, use cost-effective models
    return {
      provider: 'openai',
      model: 'gpt-4o-mini'
    };
  }
}