import cron from 'node-cron';
import { SerpApiPoolManager } from './serpApiPoolManager';
import { SearchResultModel } from '../models/SearchResult';
import { logger } from '../utils/logger';

export const scheduleCleanupJobs = (): void => {
  // Reset daily API key usage at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await SerpApiPoolManager.getInstance().resetDailyUsage();
      logger.info('Daily API key usage reset completed');
    } catch (error) {
      logger.error('Failed to reset daily API key usage:', error);
    }
  });

  // Reset monthly API key usage on the first day of each month at midnight
  cron.schedule('0 0 1 * *', async () => {
    try {
      await SerpApiPoolManager.getInstance().resetMonthlyUsage();
      logger.info('Monthly API key usage reset completed - SerpAPI limits refreshed');
    } catch (error) {
      logger.error('Failed to reset monthly API key usage:', error);
    }
  });

  // Check for monthly reset every hour (in case server was down during monthly reset)
  cron.schedule('0 * * * *', async () => {
    try {
      await SerpApiPoolManager.getInstance().checkAndResetMonthlyUsage();
    } catch (error) {
      logger.error('Failed to check monthly reset:', error);
    }
  });

  // Clean old search results (keep last 90 days)
  cron.schedule('0 2 * * 0', async () => { // Every Sunday at 2 AM
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const result = await SearchResultModel.deleteMany({
        timestamp: { $lt: ninetyDaysAgo }
      });

      logger.info(`Cleaned up ${result.deletedCount} old search results`);
    } catch (error) {
      logger.error('Failed to cleanup old search results:', error);
    }
  });

  // Log system stats every hour
  cron.schedule('0 * * * *', () => {
    const memUsage = process.memoryUsage();
    const keyStats = SerpApiPoolManager.getInstance().getKeyStats();
    
    logger.info('System stats:', {
      uptime: process.uptime(),
      memory: {
        used: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      },
      apiKeys: keyStats
    });
  });

  logger.info('Scheduled jobs initialized');
};