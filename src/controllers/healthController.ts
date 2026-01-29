import { Request, Response } from 'express';
import { SerpApiPoolManager } from '../services/serpApiPoolManager';
import { checkDatabaseHealth } from '../config/database';
import { SearchResultModel } from '../models/SearchResult';
import { ApiKeyModel } from '../models/ApiKey';
import { logger } from '../utils/logger';
import { formatBytes, formatDuration } from '../utils/helpers';

export class HealthController {
  public checkHealth = async (req: Request, res: Response): Promise<void> => {
    try {
      const startTime = Date.now();
      
      // Get API key statistics
      const keyStats = SerpApiPoolManager.getInstance().getKeyStats();
      const detailedKeyStats = SerpApiPoolManager.getInstance().getDetailedKeyStats();
      
      // Check database health
      const dbHealth = await checkDatabaseHealth();
      
      // Get search statistics
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const [totalSearches, todaySearches, successfulSearches] = await Promise.all([
        SearchResultModel.countDocuments(),
        SearchResultModel.countDocuments({
          timestamp: { $gte: today, $lt: tomorrow }
        }),
        SearchResultModel.countDocuments({ found: true })
      ]);

      // Calculate success rate
      const successRate = totalSearches > 0 ? Math.round((successfulSearches / totalSearches) * 100) : 0;
      
      // Memory usage
      const memoryUsage = process.memoryUsage();
      
      // System uptime
      const uptime = process.uptime();
      
      // Response time
      const responseTime = Date.now() - startTime;

      // Determine overall health status
      const isHealthy = dbHealth.status === 'connected' && 
                       keyStats.active > 0 && 
                       memoryUsage.heapUsed < (memoryUsage.heapTotal * 0.9);

      const healthData = {
        status: isHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        uptimeFormatted: formatDuration(uptime * 1000),
        responseTime: `${responseTime}ms`,
        
        // System resources
        system: {
          memory: {
            used: formatBytes(memoryUsage.heapUsed),
            total: formatBytes(memoryUsage.heapTotal),
            external: formatBytes(memoryUsage.external),
            usagePercentage: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100)
          },
          process: {
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            architecture: process.arch
          }
        },
        
        // Database health
        database: {
          ...dbHealth,
          collections: {
            searchResults: totalSearches,
            apiKeys: keyStats.total
          }
        },
        
        // API Keys status
        apiKeys: {
          ...keyStats,
          usagePercentage: keyStats.totalCapacity > 0 ? 
            Math.round((keyStats.totalUsageToday / keyStats.totalCapacity) * 100) : 0,
          details: detailedKeyStats,
          healthStatus: this.getApiKeysHealthStatus(keyStats, detailedKeyStats)
        },
        
        // Search statistics
        statistics: {
          total: {
            searches: totalSearches,
            successful: successfulSearches,
            successRate: `${successRate}%`
          },
          today: {
            searches: todaySearches,
            remaining: Math.max(0, keyStats.totalCapacity - keyStats.totalUsageToday),
            capacity: keyStats.totalCapacity
          }
        },
        
        // Application info
        application: {
          name: 'SERP Tracker API',
          version: process.env.npm_package_version || '2.0.0',
          environment: process.env.NODE_ENV || 'development',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        },

        // Warnings and alerts
        alerts: this.generateHealthAlerts(keyStats, memoryUsage, dbHealth, detailedKeyStats)
      };

      // Log health check if there are issues
      if (!isHealthy || healthData.alerts.length > 0) {
        logger.warn('Health check detected issues:', {
          status: healthData.status,
          alerts: healthData.alerts,
          keyStats,
          memoryUsage: healthData.system.memory.usagePercentage
        });
      }

      res.status(isHealthy ? 200 : 503).json(healthData);

    } catch (error) {
      logger.error('Health check failed:', error);
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        uptime: Math.floor(process.uptime())
      });
    }
  };

  public getApiKeyStats = async (req: Request, res: Response): Promise<void> => {
    try {
      const keyStats = SerpApiPoolManager.getInstance().getKeyStats();
      const detailedStats = SerpApiPoolManager.getInstance().getDetailedKeyStats();
      
      // Get usage from database
      const keyUsageFromDb = await ApiKeyModel.find({}).lean();
      
      // Calculate trends and insights
      const insights = this.generateApiKeyInsights(keyStats, detailedStats);
      
      res.status(200).json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        apiKeys: {
          summary: {
            ...keyStats,
            usagePercentage: keyStats.totalCapacity > 0 ? 
              Math.round((keyStats.totalUsageToday / keyStats.totalCapacity) * 100) : 0,
            estimatedDepleteTime: this.calculateDepleteTime(keyStats),
            healthStatus: this.getApiKeysHealthStatus(keyStats, detailedStats)
          },
          details: detailedStats.map(key => ({
            ...key,
            recommendations: this.getKeyRecommendations(key)
          })),
          historical: keyUsageFromDb,
          insights
        }
      });
    } catch (error) {
      logger.error('Failed to get API key stats:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get API key stats',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  public testApiKeys = async (req: Request, res: Response): Promise<void> => {
    try {
      logger.info('Manual API key test initiated');
      
      const poolManager = SerpApiPoolManager.getInstance();
      const keyStats = poolManager.getKeyStats();
      
      if (keyStats.total === 0) {
        res.status(400).json({
          success: false,
          message: 'No API keys configured'
        });
        return;
      }

      // Test with a simple query
      const testResult = await poolManager.trackKeyword('test query', {
        domain: 'example.com',
        country: 'US'
      });

      res.status(200).json({
        success: true,
        message: 'API key test completed successfully',
        testResult: {
          keyword: testResult.keyword,
          found: testResult.found,
          totalResults: testResult.totalResults,
          processingTime: (testResult as any).processingTime,
          apiKeyUsed: (testResult as any).apiKeyUsed
        },
        keyStats: poolManager.getKeyStats()
      });

    } catch (error) {
      logger.error('API key test failed:', error);
      res.status(500).json({
        success: false,
        message: 'API key test failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  private getApiKeysHealthStatus(keyStats: any, detailedStats: any[]): string {
    if (keyStats.active === 0) return 'critical';
    if (keyStats.exhausted > keyStats.active) return 'degraded';
    if (keyStats.totalUsageToday / keyStats.totalCapacity > 0.9) return 'warning';
    return 'healthy';
  }

  private generateHealthAlerts(
    keyStats: any, 
    memoryUsage: any, 
    dbHealth: any,
    detailedStats: any[]
  ): string[] {
    const alerts: string[] = [];

    // Database alerts
    if (dbHealth.status !== 'connected') {
      alerts.push('Database connection is not healthy');
    }

    // Memory alerts
    const memoryUsagePercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
    if (memoryUsagePercent > 90) {
      alerts.push(`High memory usage: ${Math.round(memoryUsagePercent)}%`);
    } else if (memoryUsagePercent > 80) {
      alerts.push(`Elevated memory usage: ${Math.round(memoryUsagePercent)}%`);
    }

    // API key alerts
    if (keyStats.active === 0) {
      alerts.push('No active API keys available');
    } else if (keyStats.active === 1 && keyStats.total > 1) {
      alerts.push('Only 1 API key active - reduced redundancy');
    }

    const usagePercentage = keyStats.totalCapacity > 0 ? 
      (keyStats.totalUsageToday / keyStats.totalCapacity) * 100 : 0;
    
    if (usagePercentage > 95) {
      alerts.push('API usage nearly exhausted for today');
    } else if (usagePercentage > 80) {
      alerts.push(`High API usage: ${Math.round(usagePercentage)}%`);
    }

    // Individual key alerts
    detailedStats.forEach(key => {
      if (key.status === 'error') {
        alerts.push(`API key ${key.id} is in error state`);
      } else if (key.successRate < 50) {
        alerts.push(`API key ${key.id} has low success rate: ${key.successRate}%`);
      }
    });

    return alerts;
  }

  private generateApiKeyInsights(keyStats: any, detailedStats: any[]): string[] {
    const insights: string[] = [];
    
    const totalCapacity = keyStats.totalCapacity;
    const totalUsed = keyStats.totalUsageToday;
    const usageRate = totalCapacity > 0 ? (totalUsed / totalCapacity) * 100 : 0;
    
    // Usage insights
    if (usageRate < 10) {
      insights.push('API usage is very low - consider optimizing key allocation');
    } else if (usageRate > 80) {
      insights.push('High API usage detected - consider adding more keys or optimizing queries');
    }
    
    // Key distribution insights
    const activeKeys = detailedStats.filter(k => k.status === 'active');
    if (activeKeys.length > 0) {
      const avgUsage = activeKeys.reduce((sum, key) => sum + key.usedToday, 0) / activeKeys.length;
      const maxUsage = Math.max(...activeKeys.map(k => k.usedToday));
      
      if (maxUsage > avgUsage * 2) {
        insights.push('Uneven key usage detected - check rotation strategy');
      }
    }
    
    // Success rate insights
    const avgSuccessRate = detailedStats.reduce((sum, key) => sum + key.successRate, 0) / detailedStats.length;
    if (avgSuccessRate < 80) {
      insights.push('Low average success rate - check API key validity and query parameters');
    }
    
    return insights;
  }

  private getKeyRecommendations(key: any): string[] {
    const recommendations: string[] = [];
    
    if (key.status === 'exhausted') {
      recommendations.push('Key has reached daily limit - will reset at midnight');
    } else if (key.usagePercentage > 90) {
      recommendations.push('Key approaching daily limit');
    }
    
    if (key.successRate < 70) {
      recommendations.push('Low success rate - verify key validity');
    } else if (key.successRate < 90) {
      recommendations.push('Monitor key performance');
    }
    
    if (key.errorCount > 10) {
      recommendations.push('High error count - check for API issues');
    }
    
    return recommendations;
  }

  private calculateDepleteTime(keyStats: any): string | null {
    if (keyStats.totalUsageToday === 0 || keyStats.totalCapacity === 0) return null;
    
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const hoursElapsed = (now.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
    
    if (hoursElapsed === 0) return null;
    
    const usageRate = keyStats.totalUsageToday / hoursElapsed;
    const remaining = keyStats.totalCapacity - keyStats.totalUsageToday;
    const hoursRemaining = remaining / usageRate;
    
    if (hoursRemaining > 24) return 'More than 24 hours';
    if (hoursRemaining < 1) return 'Less than 1 hour';
    
    return `${Math.round(hoursRemaining)} hours`;
  }
}