import { Router } from 'express';
import {
  trackSingleKeyword,
  trackBulkKeywords,
  getSerpAnalysis,
  getSearchHistory,
  getKeywordAnalytics,
  exportResults,
  getKeywordTrends,
  getApiKeyStats
} from '../controllers/searchController';
import { searchRateLimiter } from '../middleware/rateLimiter';
import { 
  validateApiKey, 
  validateSearchEndpoint, 
  validateRequestSize,
  validateSerpApiKey,
  addSecurityHeaders,
  sanitizeInputs,
  requestTimeout
} from '../middleware/validation';

const router = Router();

// Apply middleware to all routes
router.use(addSecurityHeaders);
router.use(sanitizeInputs);
router.use(requestTimeout(300000)); // 300 second timeout for search operations (5 minutes)
router.use(searchRateLimiter);

// API key validation is now optional - middleware will skip if not configured
router.use(validateApiKey);
router.use(validateSearchEndpoint);
router.use(validateRequestSize('10mb'));
router.use(validateSerpApiKey);

// Middleware for JSON body validation on POST routes
const validateJsonBody = (req: any, res: any, next: any) => {
  if (req.method === 'POST') {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is required and cannot be empty',
        expectedFields: req.path.includes('bulk') ? 
          ['keywords', 'domain', 'country'] : 
          ['keyword', 'domain', 'country']
      });
    }
  }
  next();
};

router.use(validateJsonBody);

// SERP Analysis Routes (Primary endpoints for frontend)

// Main SERP analysis endpoint - handles both single and bulk keywords
router.post('/analyze', getSerpAnalysis);

// Legacy/specific endpoints for backward compatibility
router.post('/track', trackSingleKeyword);
router.post('/bulk', trackBulkKeywords);

// Data retrieval endpoints

// Get search history with advanced filtering
router.get('/history', getSearchHistory);

// Get keyword analytics and performance metrics
router.get('/analytics', getKeywordAnalytics);

// Get keyword trends over time
router.get('/trends', getKeywordTrends);

// Export results in various formats (CSV, JSON, Excel)
router.get('/export', exportResults);

// API management endpoints

// Get current API key statistics and usage
router.get('/keys/stats', getApiKeyStats);

// In-memory rate limiter for API key testing to prevent SerpAPI 429 errors
const keyTestRateLimiter = new Map<string, number>();
const KEY_TEST_COOLDOWN = 10000; // 10 seconds between tests from same IP

// Test endpoint for API connectivity
router.post('/keys/test', async (req, res): Promise<void> => {
  try {
    const { apiKey } = req.body;
    const clientIp = req.ip || 'unknown';
    
    // Check rate limit
    const lastTest = keyTestRateLimiter.get(clientIp);
    const now = Date.now();
    
    if (lastTest && now - lastTest < KEY_TEST_COOLDOWN) {
      const waitTime = Math.ceil((KEY_TEST_COOLDOWN - (now - lastTest)) / 1000);
      res.status(429).json({
        success: false,
        message: `Please wait ${waitTime} seconds before testing another API key`,
        error: 'RATE_LIMITED',
        retryAfter: waitTime,
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    if (!apiKey) {
      res.status(400).json({
        success: false,
        message: 'API key is required for testing',
        example: {
          apiKey: 'your_serpapi_key_here'
        }
      });
      return;
    }

    // Update rate limiter
    keyTestRateLimiter.set(clientIp, now);
    
    // Clean old entries (older than 1 minute)
    for (const [ip, timestamp] of keyTestRateLimiter.entries()) {
      if (now - timestamp > 60000) {
        keyTestRateLimiter.delete(ip);
      }
    }

    // Use the SerpApiPoolManager to test the API key directly
    const { SerpApiPoolManager } = await import('../services/serpApiPoolManager');
    const poolManager = SerpApiPoolManager.getInstance();
    
    const testResult = await poolManager.testUserApiKey(apiKey);

    if (testResult.valid) {
      res.json({
        success: true,
        message: testResult.message,
        details: testResult.details,
        timestamp: new Date().toISOString()
      });
    } else {
      // Check if it's a rate limit error from SerpAPI
      const isRateLimitError = testResult.message && (
        testResult.message.toLowerCase().includes('too many requests') ||
        testResult.message.toLowerCase().includes('rate limit') ||
        testResult.details?.error === 'rate_limited'
      );
      
      if (isRateLimitError) {
        res.status(429).json({
          success: false,
          message: 'SerpAPI rate limit reached. Please wait a few minutes and try again.',
          suggestion: 'To avoid this, add the API key directly to the backend .env file instead of testing it from the UI.',
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(400).json({
          success: false,
          message: testResult.message,
          timestamp: new Date().toISOString()
        });
      }
    }

  } catch (error) {
    const errorMessage = (error as Error).message;
    const isRateLimitError = errorMessage && (
      errorMessage.toLowerCase().includes('too many requests') ||
      errorMessage.toLowerCase().includes('rate limit') ||
      errorMessage.toLowerCase().includes('429')
    );
    
    if (isRateLimitError) {
      res.status(429).json({
        success: false,
        message: 'SerpAPI rate limit reached. Please wait a few minutes and try again.',
        suggestion: 'To avoid this, add the API key directly to the backend .env file instead of testing it from the UI.',
        error: 'SERPAPI_RATE_LIMITED',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'API key test failed',
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// Health check endpoint specific to search services
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'SERP Search API',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    endpoints: {
      analyze: 'POST /api/search/analyze',
      history: 'GET /api/search/history',
      analytics: 'GET /api/search/analytics',
      trends: 'GET /api/search/trends',
      export: 'GET /api/search/export',
      test: 'POST /api/search/test'
    }
  });
});

// Options endpoint for CORS preflight
router.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-SerpAPI-Key');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.sendStatus(200);
});

export { router as searchRoutes };