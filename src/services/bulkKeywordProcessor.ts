// src/services/bulkKeywordProcessor.ts
import { SerpApiPoolManager } from './serpApiPoolManager';
import { ISearchOptions, ISearchResult, IBulkSearchResult, IProcessingProgress, IFailedSearch } from '../types/api.types';
import { logger } from '../utils/logger';
import { delay } from '../utils/helpers';

interface BulkProcessingConfig {
  batchSize: number;
  delayBetweenBatches: number;
  maxConcurrentRequests: number;
  retryFailedKeywords: boolean;
  maxRetries: number;
  adaptiveDelay: boolean;
}

export class BulkKeywordProcessor {
  private serpApiManager = SerpApiPoolManager.getInstance();
  private config: BulkProcessingConfig;
  private processedCount = 0;
  private failedKeywords: IFailedSearch[] = [];
  private successfulResults: ISearchResult[] = [];
  private startTime = 0;
  private currentBatchDelay = 0;

  constructor() {
    this.config = {
      batchSize: parseInt(process.env.BULK_PROCESSING_BATCH_SIZE || '5'),
      delayBetweenBatches: parseInt(process.env.BULK_PROCESSING_DELAY || '2000'),
      maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '2'), // Reduced for better stability
      retryFailedKeywords: process.env.RETRY_FAILED_KEYWORDS !== 'false',
      maxRetries: parseInt(process.env.BULK_MAX_RETRIES || '2'),
      adaptiveDelay: process.env.ADAPTIVE_DELAY !== 'false'
    };
    this.currentBatchDelay = this.config.delayBetweenBatches;
  }

  async processBulkKeywords(
    keywords: string[], 
    options: ISearchOptions,
    onProgress?: (progress: IProcessingProgress) => void
  ): Promise<IBulkSearchResult> {
    
    this.startTime = Date.now();
    this.processedCount = 0;
    this.failedKeywords = [];
    this.successfulResults = [];
    this.currentBatchDelay = this.config.delayBetweenBatches;

    const totalKeywords = keywords.length;
    logger.info(`🚀 Starting bulk processing of ${totalKeywords} keywords for domain: ${options.domain}`);
    logger.info(`📊 Configuration: batchSize=${this.config.batchSize}, maxConcurrent=${this.config.maxConcurrentRequests}, delay=${this.currentBatchDelay}ms`);
    
    // Validate keywords
    const validKeywords = keywords.filter(k => k && k.trim().length > 0).map(k => k.trim());
    if (validKeywords.length !== keywords.length) {
      logger.warn(`Filtered ${keywords.length - validKeywords.length} invalid keywords`);
    }
    
    // Split keywords into batches
    const batches = this.createBatches(validKeywords, this.config.batchSize);
    logger.info(`📦 Created ${batches.length} batches for processing`);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();
      
      logger.info(`🔄 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} keywords)`);
      
      try {
        // Process batch with concurrent requests
        const batchResults = await this.processBatch(batch, options, batchIndex + 1, batches.length);
        this.successfulResults.push(...batchResults);
        this.processedCount += batch.length;
        
        const batchTime = Date.now() - batchStartTime;
        const avgTimePerKeyword = batchTime / batch.length;
        
        logger.info(`✅ Batch ${batchIndex + 1} completed in ${batchTime}ms (avg ${Math.round(avgTimePerKeyword)}ms/keyword)`);
        
        // Update progress
        if (onProgress) {
          onProgress({
            total: totalKeywords,
            processed: this.processedCount,
            successful: this.successfulResults.length,
            failed: this.failedKeywords.length,
            currentBatch: batchIndex + 1,
            totalBatches: batches.length,
            keyStats: this.serpApiManager.getKeyStats()
          });
        }
        
        // Adaptive delay between batches
        if (batchIndex < batches.length - 1) {
          if (this.config.adaptiveDelay) {
            const keyStats = this.serpApiManager.getKeyStats();
            const usageRate = keyStats.totalUsageToday / keyStats.totalCapacity;
            
            // Increase delay if usage is high or there were errors in this batch
            if (usageRate > 0.8 || batchResults.length < batch.length * 0.8) {
              this.currentBatchDelay = Math.min(this.currentBatchDelay * 1.5, 10000);
              logger.info(`📈 Increased batch delay to ${this.currentBatchDelay}ms (usage: ${Math.round(usageRate * 100)}%)`);
            } else if (batchResults.length === batch.length && this.currentBatchDelay > this.config.delayBetweenBatches) {
              this.currentBatchDelay = Math.max(this.currentBatchDelay * 0.8, this.config.delayBetweenBatches);
              logger.info(`📉 Decreased batch delay to ${this.currentBatchDelay}ms`);
            }
          }
          
          logger.debug(`⏳ Waiting ${this.currentBatchDelay}ms before next batch...`);
          await delay(this.currentBatchDelay);
        }
        
      } catch (error) {
        logger.error(`❌ Batch ${batchIndex + 1} failed:`, error);
        
        // Add failed keywords to retry queue
        if (this.config.retryFailedKeywords) {
          batch.forEach(keyword => {
            const errorMessage = (error as Error).message;
            let errorType: IFailedSearch['errorType'] = 'unknown';
            
            if (errorMessage.includes('quota') || errorMessage.includes('limit exceeded')) {
              errorType = 'quota_exceeded';
            } else if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
              errorType = 'rate_limited';
            } else if (errorMessage.includes('timeout')) {
              errorType = 'timeout';
            } else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
              errorType = 'network_error';
            } else if (errorMessage.includes('parse') || errorMessage.includes('invalid response')) {
              errorType = 'parse_error';
            } else if (errorMessage.includes('400') || errorMessage.includes('invalid')) {
              errorType = 'invalid_request';
            }
            
            this.failedKeywords.push({
              keyword,
              error: errorMessage,
              errorType,
              timestamp: new Date(),
              retryCount: 0
            });
          });
          logger.warn(`Added ${batch.length} keywords to retry queue`);
        }
        continue;
      }
    }
    
    // Retry failed keywords if enabled
    if (this.config.retryFailedKeywords && this.failedKeywords.length > 0) {
      logger.info(`🔄 Retrying ${this.failedKeywords.length} failed keywords...`);
      await this.retryFailedKeywords(options, onProgress);
    }
    
    const processingTime = Date.now() - this.startTime;
    const successRate = (this.successfulResults.length / totalKeywords) * 100;
    
    logger.info(`🏁 Bulk processing completed:`);
    logger.info(`   ✅ Successful: ${this.successfulResults.length}/${totalKeywords} (${Math.round(successRate)}%)`);
    logger.info(`   ❌ Failed: ${this.failedKeywords.length}`);
    logger.info(`   ⏱️ Total time: ${Math.round(processingTime / 1000)}s`);
    logger.info(`   📊 Average: ${Math.round(processingTime / this.successfulResults.length)}ms per successful keyword`);
    
    return {
      totalProcessed: this.processedCount,
      successful: this.successfulResults,
      failed: this.failedKeywords,
      processingTime,
      keyUsageStats: this.serpApiManager.getKeyStats()
    };
  }

  private async processBatch(
    keywords: string[], 
    options: ISearchOptions,
    batchNumber: number,
    totalBatches: number
  ): Promise<ISearchResult[]> {
    const results: ISearchResult[] = [];
    const semaphore = new Semaphore(this.config.maxConcurrentRequests);
    
    const promises = keywords.map(async (keyword, index) => {
      return semaphore.acquire(async () => {
        const keywordStartTime = Date.now();
        try {
          logger.debug(`[${batchNumber}/${totalBatches}] Processing: "${keyword}" (${index + 1}/${keywords.length})`);
          
          const result = await this.serpApiManager.trackKeyword(keyword, options);
          
          const keywordTime = Date.now() - keywordStartTime;
          logger.debug(`[${batchNumber}/${totalBatches}] ✅ "${keyword}" completed in ${keywordTime}ms - Position: ${result.position || 'Not Found'}`);
          
          return result;
        } catch (error) {
          const keywordTime = Date.now() - keywordStartTime;
          logger.error(`[${batchNumber}/${totalBatches}] ❌ "${keyword}" failed in ${keywordTime}ms: ${(error as Error).message}`);
          throw error;
        }
      });
    });
    
    // Wait for all promises with individual error handling
    const settledResults = await Promise.allSettled(promises);
    
    settledResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const keyword = keywords[index];
        const error = result.reason as Error;
        logger.error(`Keyword "${keyword}" processing failed:`, error);
        
        // Add to failed list if not already there
        const alreadyFailed = this.failedKeywords.some(f => f.keyword === keyword);
        if (!alreadyFailed) {
          const errorMessage = error.message;
          let errorType: IFailedSearch['errorType'] = 'unknown';
          
          if (errorMessage.includes('quota') || errorMessage.includes('limit exceeded')) {
            errorType = 'quota_exceeded';
          } else if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
            errorType = 'rate_limited';
          } else if (errorMessage.includes('timeout')) {
            errorType = 'timeout';
          } else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
            errorType = 'network_error';
          } else if (errorMessage.includes('parse') || errorMessage.includes('invalid response')) {
            errorType = 'parse_error';
          } else if (errorMessage.includes('400') || errorMessage.includes('invalid')) {
            errorType = 'invalid_request';
          }
          
          this.failedKeywords.push({
            keyword,
            error: errorMessage,
            errorType,
            timestamp: new Date(),
            retryCount: 0
          });
        }
      }
    });
    
    return results;
  }

  private async retryFailedKeywords(
    options: ISearchOptions, 
    onProgress?: (progress: IProcessingProgress) => void
  ): Promise<void> {
    let retryAttempt = 1;
    let keywordsToRetry = [...this.failedKeywords];
    
    while (keywordsToRetry.length > 0 && retryAttempt <= this.config.maxRetries) {
      logger.info(`🔄 Retry attempt ${retryAttempt}/${this.config.maxRetries} for ${keywordsToRetry.length} keywords`);
      
      const retryResults: IFailedSearch[] = [];
      const retryDelay = Math.min(this.config.delayBetweenBatches * retryAttempt, 5000);
      
      for (const failedSearch of keywordsToRetry) {
        try {
          await delay(retryDelay); // Longer delay for retries
          
          logger.debug(`Retrying: "${failedSearch.keyword}"`);
          const result = await this.serpApiManager.trackKeyword(failedSearch.keyword, options);
          this.successfulResults.push(result);
          
          // Remove from failed list
          this.failedKeywords = this.failedKeywords.filter(f => f.keyword !== failedSearch.keyword);
          
          logger.info(`✅ Retry successful: "${failedSearch.keyword}" - Position: ${result.position || 'Not Found'}`);
          
        } catch (error) {
          logger.error(`❌ Retry failed: "${failedSearch.keyword}" - ${(error as Error).message}`);
          failedSearch.retryCount = (failedSearch.retryCount || 0) + 1;
          retryResults.push(failedSearch);
        }
        
        // Update progress during retries
        if (onProgress) {
          onProgress({
            total: this.processedCount,
            processed: this.processedCount,
            successful: this.successfulResults.length,
            failed: this.failedKeywords.length,
            currentBatch: -1,
            totalBatches: -1,
            keyStats: this.serpApiManager.getKeyStats(),
            retryAttempt
          });
        }
      }
      
      keywordsToRetry = retryResults;
      retryAttempt++;
      
      // Increase delay between retry attempts
      if (keywordsToRetry.length > 0 && retryAttempt <= this.config.maxRetries) {
        const retryPauseTime = retryDelay * 2;
        logger.info(`⏳ Pausing ${retryPauseTime}ms before next retry attempt...`);
        await delay(retryPauseTime);
      }
    }
    
    if (this.failedKeywords.length > 0) {
      logger.warn(`⚠️ ${this.failedKeywords.length} keywords still failed after all retry attempts`);
    }
  }

  private createBatches(keywords: string[], batchSize: number): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < keywords.length; i += batchSize) {
      batches.push(keywords.slice(i, i + batchSize));
    }
    return batches;
  }

  // Get processing statistics
  public getProcessingStats() {
    const currentTime = Date.now();
    const elapsedTime = this.startTime ? currentTime - this.startTime : 0;
    
    return {
      processed: this.processedCount,
      successful: this.successfulResults.length,
      failed: this.failedKeywords.length,
      elapsedTime,
      averageTimePerKeyword: this.successfulResults.length > 0 ? 
        Math.round(elapsedTime / this.successfulResults.length) : 0,
      successRate: this.processedCount > 0 ? 
        Math.round((this.successfulResults.length / this.processedCount) * 100) : 0
    };
  }
}

// Semaphore for concurrent request limiting with better error handling
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire<T>(task: () => Promise<T>): Promise<T> {
    await this.waitForPermit();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async waitForPermit(): Promise<void> {
    return new Promise((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve();
      } else {
        this.waiting.push(resolve);
      }
    });
  }

  private release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.permits--;
      next();
    }
  }

  // Get current state for debugging
  public getState() {
    return {
      availablePermits: this.permits,
      waitingTasks: this.waiting.length
    };
  }
}