import { Logger } from 'winston';
import { CacheManager } from './cache.js';

export interface QuotaConfig {
  dailyLimit: number;
  reserveBuffer: number;
  prioritizeRecent: boolean;
  warningThreshold: number;
}

export interface QuotaUsage {
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  resetTime: Date;
}

export class QuotaManager {
  private usage: number = 0;
  private config: QuotaConfig;
  private logger: Logger;
  private cache: CacheManager;
  private resetTime: Date;

  constructor(config: QuotaConfig, logger: Logger, cache: CacheManager) {
    this.config = config;
    this.logger = logger;
    this.cache = cache;
    this.resetTime = this.getNextResetTime();
    
    this.loadQuotaFromCache();
    this.scheduleReset();
  }

  /**
   * Check if an operation can be performed within quota limits
   */
  canPerformOperation(cost: number): boolean {
    const availableQuota = this.config.dailyLimit - this.config.reserveBuffer;
    return this.usage + cost <= availableQuota;
  }

  /**
   * Record quota usage for an operation
   */
  async recordUsage(cost: number, operation: string): Promise<void> {
    this.usage += cost;
    
    // Save to cache for persistence
    await this.cache.set('quota:daily_usage', this.usage, 86400); // 24 hours
    
    this.logger.info(`Quota used: ${cost} for ${operation}. Total: ${this.usage}/${this.config.dailyLimit}`);
    
    // Check warning threshold
    const percentage = (this.usage / this.config.dailyLimit) * 100;
    if (percentage >= this.config.warningThreshold) {
      this.logger.warn(`Quota usage at ${percentage.toFixed(1)}% (${this.usage}/${this.config.dailyLimit})`);
    }

    // Log critical level
    if (percentage >= 90) {
      this.logger.error(`Critical quota usage: ${percentage.toFixed(1)}% - Consider reducing operations`);
    }
  }

  /**
   * Get current quota usage information
   */
  getUsage(): QuotaUsage {
    const remaining = this.config.dailyLimit - this.usage;
    const percentage = (this.usage / this.config.dailyLimit) * 100;

    return {
      used: this.usage,
      limit: this.config.dailyLimit,
      remaining: Math.max(0, remaining),
      percentage: Math.min(100, percentage),
      resetTime: this.resetTime
    };
  }

  /**
   * Get available quota (excluding reserve buffer)
   */
  getAvailableQuota(): number {
    const availableQuota = this.config.dailyLimit - this.config.reserveBuffer;
    return Math.max(0, availableQuota - this.usage);
  }

  /**
   * Get quota cost for different operations
   */
  static getOperationCost(operation: string): number {
    const costs = {
      'search': 100,
      'video_details': 1,
      'trending': 1,
      'comments': 1,
      'channel_details': 1,
      'channel_search': 100
    };
    
    return costs[operation] || 1;
  }

  /**
   * Optimize operation based on quota availability
   */
  optimizeOperation(operation: string, requestedItems: number): number {
    const cost = QuotaManager.getOperationCost(operation);
    const availableQuota = this.getAvailableQuota();
    
    if (cost > availableQuota) {
      return 0; // Cannot perform operation
    }

    // For operations that scale with number of items
    if (operation === 'video_details' || operation === 'channel_details') {
      const maxItems = Math.floor(availableQuota / cost);
      return Math.min(requestedItems, maxItems);
    }

    // For search operations, reduce results if quota is low
    if (operation === 'search' || operation === 'channel_search') {
      const percentage = (this.usage / this.config.dailyLimit) * 100;
      if (percentage > 80) {
        return Math.min(requestedItems, 5); // Reduce to 5 items when quota is low
      }
    }

    return requestedItems;
  }

  /**
   * Check if we should use cached results instead of making API calls
   */
  shouldUseCachedResults(): boolean {
    const percentage = (this.usage / this.config.dailyLimit) * 100;
    return percentage > 85; // Use cached results when over 85% quota used
  }

  /**
   * Reset daily quota usage
   */
  async resetDailyQuota(): Promise<void> {
    this.usage = 0;
    this.resetTime = this.getNextResetTime();
    
    await this.cache.del('quota:daily_usage');
    this.logger.info('Daily quota usage reset');
  }

  /**
   * Load quota usage from cache (for persistence across restarts)
   */
  private async loadQuotaFromCache(): Promise<void> {
    try {
      const cachedUsage = await this.cache.get<number>('quota:daily_usage');
      if (cachedUsage !== null) {
        this.usage = cachedUsage;
        this.logger.info(`Loaded quota usage from cache: ${this.usage}`);
      }
    } catch (error) {
      this.logger.error('Failed to load quota from cache:', error);
    }
  }

  /**
   * Get the next quota reset time (midnight PT)
   */
  private getNextResetTime(): Date {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(now.getUTCDate() + 1);
    tomorrow.setUTCHours(7, 0, 0, 0); // 7 UTC = Midnight PT (considering PST/PDT)
    return tomorrow;
  }

  /**
   * Schedule automatic quota reset
   */
  private scheduleReset(): void {
    const msUntilReset = this.resetTime.getTime() - Date.now();
    
    setTimeout(async () => {
      await this.resetDailyQuota();
      // Schedule the next reset
      this.scheduleReset();
    }, msUntilReset);

    this.logger.info(`Next quota reset scheduled for: ${this.resetTime.toISOString()}`);
  }

  /**
   * Get quota recommendations based on current usage
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const usage = this.getUsage();

    if (usage.percentage > 90) {
      recommendations.push('Critical: Consider caching more aggressively');
      recommendations.push('Critical: Reduce search operations and use cached results');
      recommendations.push('Critical: Delay non-essential operations until quota reset');
    } else if (usage.percentage > 75) {
      recommendations.push('Warning: Enable more aggressive caching');
      recommendations.push('Warning: Prioritize essential operations only');
      recommendations.push('Warning: Consider reducing max results for search operations');
    } else if (usage.percentage > 50) {
      recommendations.push('Monitor usage closely');
      recommendations.push('Consider implementing usage analytics');
    }

    if (this.config.reserveBuffer < 1000 && usage.percentage > 60) {
      recommendations.push('Consider increasing reserve buffer to 1000+ quota units');
    }

    return recommendations;
  }

  /**
   * Export usage statistics for analytics
   */
  getAnalytics(): {
    currentUsage: QuotaUsage;
    recommendations: string[];
    config: QuotaConfig;
    efficiency: number;
  } {
    const usage = this.getUsage();
    const efficiency = this.calculateEfficiency();

    return {
      currentUsage: usage,
      recommendations: this.getRecommendations(),
      config: this.config,
      efficiency
    };
  }

  /**
   * Calculate quota efficiency (operations per quota unit)
   */
  private calculateEfficiency(): number {
    // This is a placeholder - in a real implementation, you'd track
    // the number of successful operations and calculate efficiency
    return this.usage > 0 ? 1 : 0;
  }
}