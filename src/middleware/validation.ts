import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export const validateApiKey = (req: Request, res: Response, next: NextFunction): void => {
  // Skip API key validation if disabled in environment
  if (process.env.ENABLE_API_KEY_AUTH !== 'true') {
    logger.debug('API key authentication disabled, skipping validation');
    return next();
  }

  const apiKey = req.headers['x-api-key'] || 
                 req.headers['authorization']?.replace('Bearer ', '') ||
                 req.body?.apiKey;
  
  // ✅ FIX: Allow requests without API key when ENABLE_API_KEY_AUTH=false
  // The backend will use environment keys or user-provided keys from the request body
  if (!apiKey) {
    logger.debug(`No API key provided from IP: ${req.ip}, proceeding with environment keys`);
    return next(); // Allow the request to proceed
  }

  // ✅ FIX: Only validate against VALID_API_KEYS if they are configured
  // This allows user-provided API keys in the request body to pass through
  const validApiKeys = process.env.VALID_API_KEYS?.split(',').filter(k => k.trim()) || [];
  
  if (validApiKeys.length > 0 && !validApiKeys.includes(apiKey as string)) {
    logger.warn(`Invalid API key attempt from IP: ${req.ip}`, {
      providedKey: (apiKey as string).substring(0, 8) + '...',
      userAgent: req.get('User-Agent')
    });
    res.status(401).json({
      success: false,
      message: 'Invalid API key provided',
      code: 'INVALID_API_KEY'
    });
    return;
  }

  // Store the API key in request for later use
  (req as any).apiKey = apiKey;
  logger.debug(`API key validated and stored for IP: ${req.ip}`);
  next();
};

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  const originalSend = res.send;
  
  // Override send to capture response
  res.send = function(data) {
    const duration = Date.now() - start;
    const responseSize = Buffer.byteLength(data || '', 'utf8');
    
    const logData = {
      method: req.method,
      url: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      responseSize: `${responseSize} bytes`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    };

    if (res.statusCode >= 400) {
      logger.warn('Request failed:', logData);
    } else if (duration > 5000) {
      logger.warn('Slow request detected:', logData);
    } else {
      logger.debug('Request completed:', logData);
    }

    return originalSend.call(this, data);
  };
  
  next();
};

// Validate request body size
export const validateRequestSize = (maxSize: string = '10mb') => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.get('content-length');
    
    if (contentLength) {
      const sizeInBytes = parseInt(contentLength);
      const maxSizeInBytes = parseSize(maxSize);
      
      if (sizeInBytes > maxSizeInBytes) {
        logger.warn(`Request payload too large: ${sizeInBytes} bytes from IP: ${req.ip}`);
        res.status(413).json({
          success: false,
          message: `Request payload too large. Maximum size allowed: ${maxSize}`,
          maxSize: maxSize,
          receivedSize: `${Math.round(sizeInBytes / 1024)}KB`
        });
        return;
      }
    }
    
    next();
  };
};

// Helper function to parse size strings like '10mb'
const parseSize = (size: string): number => {
  const units: { [key: string]: number } = {
    'b': 1,
    'kb': 1024,
    'mb': 1024 * 1024,
    'gb': 1024 * 1024 * 1024
  };
  
  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
  if (!match) return 10 * 1024 * 1024; // Default 10MB
  
  const num = parseFloat(match[1]);
  const unit = match[2] || 'b';
  
  return Math.floor(num * (units[unit] || 1));
};

// Validate specific search endpoints
export const validateSearchEndpoint = (req: Request, res: Response, next: NextFunction): void => {
  const { method, path } = req;
  
  // Log the request for debugging
  logger.debug(`Validating ${method} ${path}`, {
    hasBody: !!req.body && Object.keys(req.body).length > 0,
    contentType: req.get('content-type'),
    userAgent: req.get('user-agent')
  });
  
  // Validate content type for POST requests
  if (method === 'POST') {
    const contentType = req.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      res.status(400).json({
        success: false,
        message: 'Content-Type must be application/json for POST requests',
        received: contentType || 'none'
      });
      return;
    }

    // Validate that we have a request body
    if (!req.body || (typeof req.body === 'object' && Object.keys(req.body).length === 0)) {
      res.status(400).json({
        success: false,
        message: 'Request body is required for POST requests'
      });
      return;
    }
  }
  
  next();
};

// Rate limiting validation and monitoring
export const validateRateLimit = (req: Request, res: Response, next: NextFunction): void => {
  // Get client identifier (API key, IP, or combination)
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey;
  const clientId = apiKey ? `key:${(apiKey as string).substring(0, 8)}...` : `ip:${req.ip}`;
  const userAgent = req.get('user-agent') || 'unknown';
  
  // Log the request for monitoring
  logger.debug(`Rate limit check for client: ${clientId}`, {
    method: req.method,
    path: req.path,
    userAgent,
    timestamp: new Date().toISOString()
  });
  
  // Store client info for potential rate limiting decisions
  (req as any).clientId = clientId;
  
  next();
};

// CORS validation middleware
export const validateCors = (req: Request, res: Response, next: NextFunction): void => {
  const origin = req.get('origin');
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:9002'
  ];
  
  // Log CORS requests for debugging
  if (origin) {
    const isAllowed = allowedOrigins.includes(origin);
    logger.debug(`CORS request from origin: ${origin}`, {
      allowed: isAllowed,
      method: req.method,
      path: req.path
    });

    if (!isAllowed && process.env.NODE_ENV === 'production') {
      logger.warn(`CORS request from unauthorized origin: ${origin}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
    }
  }
  
  next();
};

// Validate SerpAPI key format
export const validateSerpApiKey = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.body?.apiKey || req.headers['x-serpapi-key'];
  
  if (apiKey) {
    // Basic validation for SerpAPI key format
    if (typeof apiKey !== 'string' || apiKey.length < 32) {
      res.status(400).json({
        success: false,
        message: 'Invalid SerpAPI key format. Key must be at least 32 characters long.',
        code: 'INVALID_SERPAPI_KEY_FORMAT'
      });
      return;
    }

    // Store validated API key
    (req as any).serpApiKey = apiKey;
    logger.debug('Valid SerpAPI key provided in request');
  }
  
  next();
};

// Security headers middleware
export const addSecurityHeaders = (req: Request, res: Response, next: NextFunction): void => {
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Add API-specific headers
  res.setHeader('X-API-Version', '2.0.0');
  res.setHeader('X-Response-Time', Date.now().toString());
  
  next();
};

// Input sanitization middleware
export const sanitizeInputs = (req: Request, res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query);
  }
  
  next();
};

// Helper function to sanitize object values
const sanitizeObject = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  if (obj && typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = value.trim().slice(0, 1000); // Limit string length
      } else {
        sanitized[key] = sanitizeObject(value);
      }
    }
    return sanitized;
  }
  
  return obj;
};

// Request timeout middleware
export const requestTimeout = (timeout: number = 30000) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn(`Request timeout after ${timeout}ms`, {
          method: req.method,
          url: req.url,
          ip: req.ip
        });
        
        res.status(408).json({
          success: false,
          message: 'Request timeout',
          timeout: `${timeout}ms`
        });
      }
    }, timeout);

    res.on('finish', () => {
      clearTimeout(timer);
    });

    res.on('close', () => {
      clearTimeout(timer);
    });

    next();
  };
};