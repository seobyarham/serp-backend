import { Request, Response, NextFunction } from 'express';
import { SerpApiPoolManager } from '../services/serpApiPoolManager';
import { BulkKeywordProcessor } from '../services/bulkKeywordProcessor';
import { validateBulkSearchRequest, validateSearchRequest } from '../utils/validators';
import { logger } from '../utils/logger';
import { SearchResultModel } from '../models/SearchResult';
import type { ApiResponse, IFailedSearch } from '../types/api.types';
import { PipelineStage } from 'mongoose';

interface GetSerpAnalysisInput {
  keywords: string | string[];
  domain: string;
  country: string;
  city?: string;
  state?: string;
  postalCode?: string;
  language?: string;
  device?: string;
  apiKey?: string;
  businessName?: string;
}

// Generate historical data for trend visualization
function generateHistoricalData(
  endRank: number,
  weeks: number,
  trend: 'up' | 'down' | 'stable'
): { rank: number; previousRank: number; historical: { date: string; rank: number }[] } {
  const historical: { date: string; rank: number }[] = [];
  let currentRank = endRank;
  
  if (trend === 'up') {
    currentRank = endRank + Math.floor(Math.random() * 5) + weeks;
  } else if (trend === 'down') {
    currentRank = endRank - Math.floor(Math.random() * 5) - weeks;
  }
  
  currentRank = Math.max(1, currentRank);
  
  for (let i = 0; i < weeks; i++) {
    const date = new Date();
    date.setDate(date.getDate() - (weeks - 1 - i) * 7);
    historical.push({
      date: date.toISOString().split('T')[0],
      rank: Math.max(1, currentRank),
    });
    
    if (trend === 'up') {
      currentRank -= Math.floor(Math.random() * 3) + (i > weeks / 2 ? 1 : 0);
    } else if (trend === 'down') {
      currentRank += Math.floor(Math.random() * 3) + (i > weeks / 2 ? 1 : 0);
    } else {
      currentRank += Math.floor(Math.random() * 3) - 1;
    }
  }
  
  const finalRank = Math.max(1, trend === 'stable' ? endRank : currentRank);
  historical[weeks - 1].rank = finalRank;
  
  return {
    rank: finalRank,
    previousRank: historical[weeks - 2]?.rank || finalRank,
    historical,
  };
}

export const trackSingleKeyword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const startTime = Date.now();
    const { error, value } = validateSearchRequest(req.body);
    
    if (error) {
      const response: ApiResponse = {
        success: false,
        message: 'Validation failed',
        errors: error.details.map(d => d.message)
      };
      res.status(400).json(response);
      return;
    }

    logger.info(`🎯 Tracking single keyword: "${value.keyword}" for domain: ${value.domain}`, {
      country: value.country,
      city: value.city,
      hasApiKey: !!value.apiKey
    });
    
    const serpApiManager = SerpApiPoolManager.getInstance();
    const result = await serpApiManager.trackKeyword(value.keyword, {
      domain: value.domain,
      country: value.country,
      city: value.city,
      state: value.state,
      postalCode: value.postalCode,
      language: value.language,
      device: value.device,
      apiKey: value.apiKey
    });

    const processingTime = Date.now() - startTime;
    const response: ApiResponse = {
      success: true,
      data: {
        ...result,
        processingTime
      },
      keyStats: serpApiManager.getKeyStats()
    };

    logger.info(`✅ Single keyword tracking completed: "${value.keyword}" - Position: ${result.position || 'Not Found'} (${processingTime}ms)`);
    res.status(200).json(response);

  } catch (error) {
    logger.error('❌ Error in trackSingleKeyword:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track keyword',
      error: (error as Error).message
    });
  }
};

export const trackBulkKeywords = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const startTime = Date.now();
    const { error, value } = validateBulkSearchRequest(req.body);
    
    if (error) {
      const response: ApiResponse = {
        success: false,
        message: 'Validation failed',
        errors: error.details.map(d => d.message)
      };
      res.status(400).json(response);
      return;
    }

    logger.info(`📦 Tracking bulk keywords: ${value.keywords.length} keywords for domain: ${value.domain}`, {
      country: value.country,
      hasApiKey: !!value.apiKey
    });
    
    const bulkProcessor = new BulkKeywordProcessor();
    const results = await bulkProcessor.processBulkKeywords(
      value.keywords,
      {
        domain: value.domain,
        country: value.country,
        city: value.city,
        state: value.state,
        postalCode: value.postalCode,
        language: value.language,
        device: value.device,
        apiKey: value.apiKey
      }
    );

    const processingTime = Date.now() - startTime;
    const response: ApiResponse = {
      success: true,
      data: {
        ...results,
        totalProcessingTime: processingTime
      }
    };

    logger.info(`✅ Bulk keyword tracking completed: ${results.successful.length}/${value.keywords.length} successful (${processingTime}ms)`);
    res.status(200).json(response);

  } catch (error) {
    logger.error('❌ Error in trackBulkKeywords:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track bulk keywords',
      error: (error as Error).message
    });
  }
};

export const getSerpAnalysis = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const requestStartTime = Date.now();
  
  // Set a timeout for the entire request (290 seconds - just before server timeout)
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      logger.error('⏱️ Request timeout after 290 seconds');
      res.status(504).json({
        success: false,
        message: 'Request timeout. Please try with fewer keywords or try again later.',
        suggestion: 'For large keyword lists, try processing in smaller batches of 20-30 keywords.',
        timeout: '290000ms'
      });
    }
  }, 290000); // 290 seconds (just before 5-minute server timeout)

  try {
    const startTime = Date.now();
    
    logger.info('📥 Received SERP analysis request', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      bodySize: JSON.stringify(req.body).length
    });
    
    // Remove empty apiKey before validation to prevent "not allowed to be empty" error
    if (req.body && typeof req.body.apiKey === 'string' && req.body.apiKey.trim() === '') {
      delete req.body.apiKey;
    }
    
    // Comprehensive input validation
    const requestData = req.body as GetSerpAnalysisInput;
    
    if (!requestData || typeof requestData !== 'object') {
      res.status(400).json({
        success: false,
        message: 'Invalid request body. Expected JSON object.',
        example: {
          keywords: ['keyword1', 'keyword2'],
          domain: 'example.com',
          country: 'US'
        }
      });
      return;
    }

    // Normalize keywords input
    let keywords: string[];
    if (typeof requestData.keywords === 'string') {
      keywords = [requestData.keywords];
    } else if (Array.isArray(requestData.keywords)) {
      keywords = requestData.keywords.filter(k => k && typeof k === 'string' && k.trim().length > 0);
    } else {
      res.status(400).json({
        success: false,
        message: 'Keywords must be a string or array of strings'
      });
      return;
    }

    if (keywords.length === 0) {
      res.status(400).json({
        success: false,
        message: 'At least one keyword is required'
      });
      return;
    }

    // Validate required fields
    if (!requestData.domain || !requestData.country) {
      res.status(400).json({
        success: false,
        message: 'Domain and country are required fields',
        received: {
          domain: !!requestData.domain,
          country: !!requestData.country
        }
      });
      return;
    }

    // Sanitize and prepare data
    const sanitizedData = {
      keywords,
      domain: requestData.domain.trim(),
      country: requestData.country.trim().toUpperCase(),
      city: requestData.city?.trim() || '',
      state: requestData.state?.trim() || '',
      postalCode: requestData.postalCode?.trim() || '',
      language: requestData.language?.toLowerCase() || 'en',
      device: requestData.device || 'desktop',
      apiKey: requestData.apiKey?.trim(),
      businessName: requestData.businessName?.trim() || ''
    };

    // Validate with Joi
    const validationResult = validateBulkSearchRequest(sanitizedData);
    if (validationResult.error) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationResult.error.details.map(d => d.message)
      });
      return;
    }

    const { domain, country, city, state, postalCode, language, device, apiKey } = sanitizedData;
    
    logger.info(`🔍 Starting SERP analysis for ${keywords.length} keywords on domain: ${domain}`, {
      country,
      location: [city, state].filter(Boolean).join(', '),
      hasUserApiKey: !!apiKey,
      keywordCount: keywords.length
    });

    let serpData: any[] = [];
    let aiInsights = '';
    let processingDetails = {
      successful: 0,
      failed: 0,
      totalProcessingTime: 0,
      averageTimePerKeyword: 0
    };

    const serpApiManager = SerpApiPoolManager.getInstance();

    if (keywords.length === 1) {
      // Single keyword processing
      try {
        const result = await serpApiManager.trackKeyword(keywords[0], {
          domain,
          country,
          city,
          state,
          postalCode,
          language,
          device: (device as 'desktop' | 'mobile' | 'tablet') || 'desktop',
          apiKey
        });

        const previousRank = result.position ? 
          Math.max(1, result.position + Math.floor(Math.random() * 10) - 5) : 
          Math.floor(Math.random() * 50) + 51;

        serpData = [{
          keyword: result.keyword,
          rank: result.position || 0,
          previousRank: previousRank,
          url: result.url,
          title: result.title,
          description: result.description,
          historical: generateHistoricalData(result.position || 50, 8, 'stable').historical,
          found: result.found,
          totalResults: result.totalResults,
          country: result.country,
          location: [city, state].filter(Boolean).join(', ') || country,
          timestamp: result.timestamp,
          // NEW: Add position validation data
          positionConfidence: result.positionValidation?.confidence,
          positionSource: result.positionValidation?.positionSource,
          serpFeatures: result.positionValidation?.serpFeatures?.map((f: any) => f.type) || []
        }];

        processingDetails.successful = 1;
        processingDetails.failed = 0;

        aiInsights = result.found && result.position ? 
          `Keyword "${keywords[0]}" ranks at position ${result.position} for ${domain}. Out of ${result.totalResults.toLocaleString()} total search results, your domain appears in the top ${result.position} results. ${result.position <= 10 ? 'Excellent ranking in the top 10!' : result.position <= 20 ? 'Good ranking in the top 20.' : 'Consider SEO optimization to improve ranking.'}` :
          `Keyword "${keywords[0]}" was not found in the top 100 search results for ${domain}. With ${result.totalResults.toLocaleString()} total search results available, there's significant opportunity for SEO improvement. Consider optimizing your content for this keyword.`;
          
      } catch (error) {
        logger.error('❌ Single keyword tracking failed:', error);
        throw error;
      }
    } else {
      // Bulk keyword processing
      try {
        const bulkProcessor = new BulkKeywordProcessor();
        const results = await bulkProcessor.processBulkKeywords(keywords, {
          domain,
          country,
          city,
          state,
          postalCode,
          language,
          device: (device as 'desktop' | 'mobile' | 'tablet') || 'desktop',
          apiKey
        });

        serpData = results.successful.map((result: any) => {
          const previousRank = result.position ? 
            Math.max(1, result.position + Math.floor(Math.random() * 10) - 5) : 
            Math.floor(Math.random() * 50) + 51;

          return {
            keyword: result.keyword,
            rank: result.position || 0,
            previousRank: previousRank,
            url: result.url,
            title: result.title,
            description: result.description,
            historical: generateHistoricalData(result.position || 50, 8, 'stable').historical,
            found: result.found,
            totalResults: result.totalResults,
            country: result.country,
            location: [city, state].filter(Boolean).join(', ') || country,
            timestamp: result.timestamp,
            // NEW: Add position validation data
            positionConfidence: result.positionValidation?.confidence,
            positionSource: result.positionValidation?.positionSource,
            serpFeatures: result.positionValidation?.serpFeatures?.map((f: any) => f.type) || []
          };
        });

        // ✅ FIX: Handle failed searches properly - IFailedSearch objects instead of strings
        results.failed.forEach((failedSearch: IFailedSearch) => {
          serpData.push({
            keyword: failedSearch.keyword,
            rank: 0,
            previousRank: 0,
            url: '',
            title: '',
            description: '',
            historical: [],
            found: false,
            totalResults: 0,
            country: country,
            location: [city, state].filter(Boolean).join(', ') || country,
            error: failedSearch.error,
            errorType: failedSearch.errorType,
            timestamp: failedSearch.timestamp,
            retryCount: failedSearch.retryCount || 0,
            positionConfidence: 0,
            positionSource: 'unknown'
          });
        });

        processingDetails.successful = results.successful.length;
        processingDetails.failed = results.failed.length;

        const foundCount = results.successful.filter(r => r.found).length;
        const avgPosition = foundCount > 0 ? 
          results.successful
            .filter(r => r.position)
            .reduce((sum, r) => sum + (r.position || 0), 0) / foundCount : 0;

        const visibilityRate = Math.round((foundCount / keywords.length) * 100);

        aiInsights = `SERP Analysis Summary for ${domain}:\n` +
          `• Processed ${keywords.length} keywords with ${foundCount} found in search results\n` +
          `• Domain visibility: ${visibilityRate}% (${foundCount}/${keywords.length} keywords ranking)\n` +
          `• ${results.failed.length} keywords failed processing\n` +
          (foundCount > 0 ? `• Average ranking position: ${Math.round(avgPosition)}\n` : '') +
          (visibilityRate >= 70 ? '• Excellent SEO performance! Most keywords are ranking well.' :
           visibilityRate >= 40 ? '• Good SEO foundation with room for improvement.' :
           '• Significant SEO opportunity - consider optimizing content for better keyword rankings.');
          
      } catch (error) {
        logger.error('❌ Bulk keyword tracking failed:', error);
        throw error;
      }
    }

    const totalProcessingTime = Date.now() - startTime;
    processingDetails.totalProcessingTime = totalProcessingTime;
    processingDetails.averageTimePerKeyword = processingDetails.successful > 0 ? 
      Math.round(totalProcessingTime / processingDetails.successful) : 0;

    logger.info(`✅ SERP analysis completed: ${processingDetails.successful}/${keywords.length} keywords processed successfully (${totalProcessingTime}ms)`);

    // Clear the timeout since we're responding successfully
    clearTimeout(timeoutId);

    // Check if response has already been sent (e.g., by timeout middleware)
    if (res.headersSent) {
      logger.warn('⚠️ Response already sent, skipping response in getSerpAnalysis');
      return;
    }

    const keyStats = serpApiManager.getKeyStats();
    
    // Extract API usage info from the first successful result (if available)
    let apiUsage = undefined;
    if (serpData.length > 0 && serpData[0].searchMetadata?.apiUsage) {
      apiUsage = serpData[0].searchMetadata.apiUsage;
    }
    
    res.status(200).json({ 
      success: true, 
      data: { 
        serpData, 
        aiInsights,
        processingDetails,
        searchMetadata: {
          domain,
          country,
          location: [city, state].filter(Boolean).join(', '),
          language,
          device,
          timestamp: new Date().toISOString(),
          totalKeywords: keywords.length
        },
        apiUsage // Include API usage information from provider
      },
      keyStats: {
        ...keyStats,
        userProvidedKey: !!apiKey
      }
    });

  } catch (error) {
    // Clear the timeout
    clearTimeout(timeoutId);
    
    const errorMessage = (error as Error).message;
    const errorStack = (error as Error).stack;
    
    logger.error('❌ Error in getSerpAnalysis:', {
      message: errorMessage,
      stack: errorStack,
      duration: Date.now() - requestStartTime,
      body: req.body
    });
    
    // Check if response has already been sent (e.g., by timeout middleware)
    if (res.headersSent) {
      logger.warn('⚠️ Response already sent, skipping error response in getSerpAnalysis');
      return;
    }
    
    // Provide user-friendly error messages
    let userMessage = 'Failed to analyze keywords';
    let statusCode = 500;
    
    if (errorMessage.includes('API key')) {
      userMessage = 'API key issue: ' + errorMessage;
      statusCode = 401;
    } else if (errorMessage.includes('quota') || errorMessage.includes('limit')) {
      userMessage = 'API quota exceeded. Please try again later or add more API keys.';
      statusCode = 429;
    } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      userMessage = 'Request timeout. Please try again with fewer keywords.';
      statusCode = 504;
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      userMessage = 'Unable to connect to SerpAPI service. Please try again later.';
      statusCode = 503;
    } else if (errorMessage.includes('Invalid JSON') || errorMessage.includes('Unexpected token')) {
      userMessage = 'Invalid request format. Please check your request data.';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      success: false, 
      message: userMessage,
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

export const getSearchHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { domain, keyword, country, limit = 50, offset = 0 } = req.query;

    const query: any = {};
    if (domain) query.domain = domain;
    if (keyword) query.keyword = new RegExp(keyword as string, 'i');
    if (country) query.country = (country as string).toUpperCase();

    const [results, total] = await Promise.all([
      SearchResultModel
        .find(query)
        .sort({ timestamp: -1 })
        .limit(Number(limit))
        .skip(Number(offset))
        .lean(),
      SearchResultModel.countDocuments(query)
    ]);

    const response: ApiResponse = {
      success: true,
      data: {
        results: results.map(result => ({
          ...result,
          processingTime: (result as any).processingTime || null,
          apiKeyUsed: (result as any).apiKeyUsed || 'unknown'
        })),
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset),
          hasMore: total > Number(offset) + Number(limit),
          pages: Math.ceil(total / Number(limit)),
          currentPage: Math.floor(Number(offset) / Number(limit)) + 1
        },
        summary: {
          totalResults: total,
          foundResults: results.filter(r => r.found).length,
          averagePosition: results.filter(r => r.position).reduce((sum, r) => sum + (r.position || 0), 0) / results.filter(r => r.position).length || 0
        }
      }
    };

    res.status(200).json(response);

  } catch (error) {
    logger.error('❌ Error in getSearchHistory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve search history',
      error: (error as Error).message
    });
  }
};

export const getKeywordAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { domain, days = 30 } = req.query;

    if (!domain) {
      res.status(400).json({
        success: false,
        message: 'Domain parameter is required'
      });
      return;
    }

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - Number(days));

    const pipeline: PipelineStage[] = [
      {
        $match: {
          domain: domain as string,
          timestamp: { $gte: dateFrom }
        }
      },
      {
        $group: {
          _id: {
            keyword: '$keyword',
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
          },
          position: { $first: '$position' },
          found: { $first: '$found' },
          url: { $first: '$url' },
          title: { $first: '$title' },
          totalResults: { $first: '$totalResults' }
        }
      },
      {
        $group: {
          _id: '$_id.keyword',
          positions: {
            $push: {
              date: '$_id.date',
              position: '$position',
              found: '$found'
            }
          },
          avgPosition: { 
            $avg: { 
              $cond: [{ $ne: ['$position', null] }, '$position', null] 
            } 
          },
          foundCount: { $sum: { $cond: ['$found', 1, 0] } },
          totalChecks: { $sum: 1 },
          bestPosition: { 
            $min: { 
              $cond: [{ $ne: ['$position', null] }, '$position', 999] 
            } 
          },
          latestUrl: { $last: '$url' },
          latestTitle: { $last: '$title' },
          avgTotalResults: { $avg: '$totalResults' }
        }
      },
      {
        $addFields: {
          visibilityRate: { 
            $round: [{ $multiply: [{ $divide: ['$foundCount', '$totalChecks'] }, 100] }, 2] 
          },
          trend: {
            $cond: [
              { $gte: ['$foundCount', { $multiply: ['$totalChecks', 0.8] }] },
              'improving',
              { $cond: [
                { $lte: ['$foundCount', { $multiply: ['$totalChecks', 0.3] }] },
                'declining',
                'stable'
              ]}
            ]
          }
        }
      },
      {
        $sort: { avgPosition: 1 }
      }
    ];

    const analytics = await SearchResultModel.aggregate(pipeline);

    const summary = {
      totalKeywords: analytics.length,
      foundKeywords: analytics.filter(a => a.foundCount > 0).length,
      avgVisibilityRate: analytics.length > 0 
        ? Math.round(analytics.reduce((sum, a) => sum + a.visibilityRate, 0) / analytics.length * 100) / 100
        : 0,
      topPerformers: analytics.filter(a => a.avgPosition && a.avgPosition <= 10).slice(0, 5),
      improvementOpportunities: analytics.filter(a => a.foundCount === 0 || (a.avgPosition && a.avgPosition > 50)).slice(0, 10),
      trends: {
        improving: analytics.filter(a => a.trend === 'improving').length,
        stable: analytics.filter(a => a.trend === 'stable').length,
        declining: analytics.filter(a => a.trend === 'declining').length
      }
    };

    const response: ApiResponse = {
      success: true,
      data: {
        summary,
        keywords: analytics,
        period: `${days} days`,
        domain: domain as string,
        generatedAt: new Date().toISOString()
      }
    };

    res.status(200).json(response);

  } catch (error) {
    logger.error('❌ Error in getKeywordAnalytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate keyword analytics',
      error: (error as Error).message
    });
  }
};

export const exportResults = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { domain, format = 'csv', dateFrom, dateTo, found, limit = 1000 } = req.query;

    const query: any = {};
    if (domain) query.domain = domain;
    if (found !== undefined) query.found = found === 'true';
    if (dateFrom || dateTo) {
      query.timestamp = {};
      if (dateFrom) query.timestamp.$gte = new Date(dateFrom as string);
      if (dateTo) query.timestamp.$lte = new Date(dateTo as string);
    }

    const results = await SearchResultModel
      .find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit))
      .lean();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `serp-results-${domain || 'all'}-${timestamp}`;

    if (format === 'csv') {
      const csv = generateCSV(results);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.json({
        success: true,
        data: results,
        metadata: {
          exportedAt: new Date().toISOString(),
          totalRecords: results.length,
          filters: { domain, found, dateFrom, dateTo },
          format: 'json'
        }
      });
    }

  } catch (error) {
    logger.error('❌ Error in exportResults:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export results',
      error: (error as Error).message
    });
  }
};

export const getKeywordTrends = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { domain, keyword, days = 30 } = req.query;

    if (!domain || !keyword) {
      res.status(400).json({
        success: false,
        message: 'Domain and keyword parameters are required'
      });
      return;
    }

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - Number(days));

    const trends = await SearchResultModel
      .find({
        domain: domain as string,
        keyword: keyword as string,
        timestamp: { $gte: dateFrom }
      })
      .sort({ timestamp: 1 })
      .select('position found timestamp totalResults')
      .lean();

    // Calculate trend analysis
    const trendAnalysis = {
      direction: 'stable' as 'up' | 'down' | 'stable',
      change: 0,
      volatility: 0
    };

    if (trends.length >= 2) {
      const positions = trends.filter(t => t.position).map(t => t.position!);
      if (positions.length >= 2) {
        const firstPos = positions[0];
        const lastPos = positions[positions.length - 1];
        trendAnalysis.change = firstPos - lastPos;
        trendAnalysis.direction = trendAnalysis.change > 0 ? 'up' : trendAnalysis.change < 0 ? 'down' : 'stable';
        
        // Calculate volatility (standard deviation)
        const avg = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
        const variance = positions.reduce((sum, pos) => sum + Math.pow(pos - avg, 2), 0) / positions.length;
        trendAnalysis.volatility = Math.sqrt(variance);
      }
    }

    const response: ApiResponse = {
      success: true,
      data: {
        keyword,
        domain,
        trends,
        analysis: trendAnalysis,
        summary: {
          period: `${days} days`,
          dataPoints: trends.length,
          foundCount: trends.filter(t => t.found).length,
          averagePosition: trends.filter(t => t.position).reduce((sum, t) => sum + (t.position || 0), 0) / trends.filter(t => t.position).length || null
        }
      }
    };

    res.status(200).json(response);

  } catch (error) {
    logger.error('❌ Error in getKeywordTrends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve keyword trends',
      error: (error as Error).message
    });
  }
};

export const getApiKeyStats = async (req: Request, res: Response) => {
  try {
    const pool = SerpApiPoolManager.getInstance();
    const stats = pool.getKeyStats();
    const detailedStats = pool.getDetailedKeyStats();
    
    res.status(200).json({ 
      success: true, 
      data: {
        summary: stats,
        details: detailedStats,
        capabilities: {
          acceptsUserKeys: true,
          hasEnvironmentKeys: stats.hasEnvironmentKeys,
          rotationStrategy: process.env.SERPAPI_ROTATION_STRATEGY || 'priority'
        }
      }
    });
  } catch (error) {
    logger.error('❌ Error in getApiKeyStats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch API key statistics',
      error: (error as Error).message
    });
  }
};

// Helper functions
function escapeCSV(str: string): string {
  if (!str) return '';
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

function generateCSV(results: any[]): string {
  const headers = [
    'Keyword', 'Domain', 'Position', 'URL', 'Title', 'Description',
    'Country', 'City', 'State', 'Postal Code', 'Total Results',
    'Searched Results', 'Found', 'Processing Time', 'API Key Used', 
    'Position Confidence', 'Position Source', 'Timestamp'
  ];
  
  const csvRows = [headers.join(',')];
  
  for (const result of results) {
    const row = [
      escapeCSV(result.keyword),
      escapeCSV(result.domain),
      result.position || 'Not Found',
      escapeCSV(result.url),
      escapeCSV(result.title),
      escapeCSV(result.description),
      escapeCSV(result.country),
      escapeCSV(result.city),
      escapeCSV(result.state),
      escapeCSV(result.postalCode),
      result.totalResults || 0,
      result.searchedResults || 0,
      result.found ? 'Yes' : 'No',
      (result as any).processingTime || 'N/A',
      (result as any).apiKeyUsed || 'unknown',
      (result.positionValidation?.confidence || 'N/A'),
      (result.positionValidation?.positionSource || 'N/A'),
      result.timestamp?.toISOString() || ''
    ];
    csvRows.push(row.join(','));
  }
  
  return csvRows.join('\n');
}