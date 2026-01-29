import { Router, Request, Response } from 'express';
import { SerpApiPoolManager } from '../services/serpApiPoolManager';
import { logger } from '../utils/logger';
import { validateApiKey, validateKeyUpdate } from '../utils/validators';

const router = Router();
const poolManager = SerpApiPoolManager.getInstance();

// In-memory rate limiter for API key operations
const keyOperationRateLimiter = new Map<string, { count: number; resetTime: number }>();
const KEY_OPERATION_WINDOW = 60000; // 1 minute window
const MAX_KEY_OPERATIONS = 5; // Max 5 operations per minute per IP

// Rate limiting middleware for key operations
const rateLimitKeyOperations = (req: Request, res: Response, next: any): void => {
  const clientIp = req.ip || 'unknown';
  const now = Date.now();
  
  let limiter = keyOperationRateLimiter.get(clientIp);
  
  if (!limiter || now > limiter.resetTime) {
    // Reset or create new limiter
    limiter = { count: 1, resetTime: now + KEY_OPERATION_WINDOW };
    keyOperationRateLimiter.set(clientIp, limiter);
  } else {
    limiter.count++;
    
    if (limiter.count > MAX_KEY_OPERATIONS) {
      const waitTime = Math.ceil((limiter.resetTime - now) / 1000);
      res.status(429).json({
        success: false,
        message: `Too many API key operations. Please wait ${waitTime} seconds.`,
        error: 'RATE_LIMITED',
        retryAfter: waitTime
      });
      return;
    }
  }
  
  // Clean old entries
  for (const [ip, data] of keyOperationRateLimiter.entries()) {
    if (now > data.resetTime) {
      keyOperationRateLimiter.delete(ip);
    }
  }
  
  next();
};

// Get all API key stats and details
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Set cache control headers to prevent caching
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    const stats = poolManager.getKeyStats();
    const detailedStats = poolManager.getDetailedKeyStats();
    
    return res.json({
      success: true,
      data: {
        summary: stats,
        keys: detailedStats
      }
    });
  } catch (error) {
    logger.error('Failed to get API key stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve API key statistics',
      error: (error as Error).message
    });
  }
});

// Add new API key
router.post('/add', rateLimitKeyOperations, validateApiKey, async (req: Request, res: Response) => {
  try {
    const { apiKey, dailyLimit, monthlyLimit } = req.body;
    
    const result = await poolManager.addApiKey(apiKey, dailyLimit, monthlyLimit);
    
    if (result.success) {
      // Return updated stats
      const stats = poolManager.getKeyStats();
      const detailedStats = poolManager.getDetailedKeyStats();
      
      return res.json({
        success: true,
        message: result.message,
        keyId: result.keyId,
        data: {
          summary: stats,
          keys: detailedStats
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message
      });
    }
  } catch (error) {
    logger.error('Failed to add API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to add API key',
      error: (error as Error).message
    });
  }
});

// Remove API key
router.delete('/remove/:keyId', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    
    const result = await poolManager.removeApiKey(keyId);
    
    if (result.success) {
      // Return updated stats
      const stats = poolManager.getKeyStats();
      const detailedStats = poolManager.getDetailedKeyStats();
      
      return res.json({
        success: true,
        message: result.message,
        data: {
          summary: stats,
          keys: detailedStats
        }
      });
    } else {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }
  } catch (error) {
    logger.error('Failed to remove API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to remove API key',
      error: (error as Error).message
    });
  }
});

// Update API key settings
router.put('/update/:keyId', validateKeyUpdate, async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const updates = req.body;
    
    const result = await poolManager.updateApiKey(keyId, updates);
    
    if (result.success) {
      // Return updated stats
      const stats = poolManager.getKeyStats();
      const detailedStats = poolManager.getDetailedKeyStats();
      
      return res.json({
        success: true,
        message: result.message,
        data: {
          summary: stats,
          keys: detailedStats
        }
      });
    } else {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }
  } catch (error) {
    logger.error('Failed to update API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update API key',
      error: (error as Error).message
    });
  }
});

// Test specific API key
router.post('/test', rateLimitKeyOperations, async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        message: 'API key is required'
      });
    }
    
    const result = await poolManager.testUserApiKey(apiKey);
    
    // Check for rate limit errors from SerpAPI
    const isRateLimitError = !result.valid && (
      result.message.toLowerCase().includes('too many requests') ||
      result.message.toLowerCase().includes('rate limit') ||
      result.details?.error === 'rate_limited'
    );
    
    if (isRateLimitError) {
      return res.status(429).json({
        success: false,
        message: 'SerpAPI rate limit reached. Please wait a few minutes before testing keys.',
        suggestion: 'Add API keys directly to backend .env file to skip validation, or wait 5-10 minutes.',
        error: 'SERPAPI_RATE_LIMITED'
      });
    }
    
    return res.json({
      success: result.valid,
      message: result.message,
      details: result.details
    });
  } catch (error) {
    const errorMessage = (error as Error).message;
    const isRateLimitError = errorMessage && (
      errorMessage.toLowerCase().includes('too many requests') ||
      errorMessage.toLowerCase().includes('rate limit') ||
      errorMessage.toLowerCase().includes('429')
    );
    
    if (isRateLimitError) {
      return res.status(429).json({
        success: false,
        message: 'SerpAPI rate limit reached. Please wait a few minutes before testing keys.',
        suggestion: 'Add API keys directly to backend .env file to skip validation, or wait 5-10 minutes.',
        error: 'SERPAPI_RATE_LIMITED'
      });
    }
    
    logger.error('Failed to test API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to test API key',
      error: errorMessage
    });
  }
});

export default router;