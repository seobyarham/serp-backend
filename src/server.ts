import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { config } from 'dotenv';
import { connectDatabase } from './config/database';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter, speedLimiter } from './middleware/rateLimiter';
import { corsMiddleware } from './middleware/cors';
import { setupRoutes } from './routes';
import { SerpApiPoolManager } from './services/serpApiPoolManager';
import { scheduleCleanupJobs } from './services/scheduler';

// Load environment variables
config();

class Server {
  private app: express.Application;
  private port: number;
  private server: any;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || '5000');
    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private initializeMiddleware(): void {
    // Trust proxy for accurate IP addresses in production
    this.app.set('trust proxy', 1);

    // Security middleware
    this.app.use(helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https:"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // CORS configuration - must be before other middleware
    this.app.use(corsMiddleware);

    // Content-Type charset handling middleware
    this.app.use((req, res, next) => {
      // Normalize content-type header to avoid charset issues
      if (req.headers['content-type']) {
        const contentType = req.headers['content-type'];
        // Replace charset=UTF-8 with charset=utf-8 (lowercase) for consistency
        req.headers['content-type'] = contentType
          .replace(/charset=UTF-8/gi, 'charset=utf-8')
          .replace(/;\s*charset=utf-8/gi, ''); // Remove charset entirely to avoid parsing issues
      }
      next();
    });

    // Compression for better performance
    this.app.use(compression({
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
      level: 6
    }));

    // Enhanced body parsing with proper charset handling
    this.app.use(express.json({ 
      limit: '10mb',
      type: (req) => {
        // Accept JSON with any charset
        const contentType = req.headers['content-type'];
        return !!(contentType && contentType.includes('application/json'));
      },
      strict: false, // Allow non-strict JSON parsing
      verify: (req, res, buf) => {
        try {
          JSON.parse(buf.toString('utf8'));
        } catch (e) {
          logger.error('Invalid JSON in request body:', {
            error: (e instanceof Error ? e.message : String(e)),
            url: req.url,
            ip: req.socket.remoteAddress
          });
          throw new Error('Invalid JSON format');
        }
      }
    }));

    this.app.use(express.urlencoded({ 
      extended: true, 
      limit: '10mb',
      parameterLimit: 100,
      type: (req) => {
        // Accept URL-encoded with any charset
        const contentType = req.headers['content-type'];
        return !!(contentType && contentType.includes('application/x-www-form-urlencoded'));
      }
    }));

    // JSON parsing error handler
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (error instanceof SyntaxError && 'body' in error) {
        logger.error('JSON parsing error:', { 
          error: error.message, 
          url: req.url,
          ip: req.socket.remoteAddress,
          userAgent: req.get('User-Agent')
        });
        res.status(400).json({
          success: false,
          message: 'Invalid JSON format in request body'
        });
        return;
      }
      next(error);
    });

    // Request logging middleware
    this.app.use((req, res, next) => {
      const startTime = Date.now();
      
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logData = {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${duration}ms`,
          ip: req.socket.remoteAddress,
          userAgent: req.get('User-Agent'),
          contentLength: res.get('content-length')
        };
        
        if (res.statusCode >= 400) {
          logger.warn('Request completed with error:', logData);
        } else {
          logger.info('Request completed:', logData);
        }
      });
      
      next();
    });

    // HTTP request logging (only in development)
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      this.app.use(morgan('combined', {
        stream: { write: (message) => logger.debug(message.trim()) },
        skip: (req) => req.path === '/health' || req.path === '/api/health'
      }));
    }

    // Rate limiting middleware
    this.app.use('/api', rateLimiter);
    this.app.use('/api', speedLimiter);

    // Health check endpoint (for load balancers)
    this.app.get('/health', (req, res) => {
      const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          usage: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)
        },
        environment: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '2.0.0'
      };

      res.status(200).json(healthData);
    });

    // Root endpoint with API information
    this.app.get('/', (req, res) => {
      res.json({
        name: 'SERP Keyword Tracker API',
        version: '2.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        documentation: '/api',
        health: '/health',
        endpoints: {
          health: '/health',
          api: '/api',
          search: '/api/search',
          analytics: '/api/search/analytics'
        }
      });
    });
  }

  private initializeRoutes(): void {
    setupRoutes(this.app);
  }

  private initializeErrorHandling(): void {
    // 404 handler for API routes
    this.app.use('/api/*', (req, res) => {
      res.status(404).json({
        success: false,
        message: 'API endpoint not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
        suggestion: 'Check the API documentation at /api'
      });
    });

    // 404 handler for all other routes
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
        suggestion: 'Visit /api for API documentation'
      });
    });

    // Global error handler
    this.app.use(errorHandler);
  }

  private async tryPort(port: number, maxRetries: number = 10): Promise<number> {
    return new Promise((resolve, reject) => {
      const testServer = this.app.listen(port, '0.0.0.0', () => {
        testServer.close(() => {
          resolve(port);
        });
      });

      testServer.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          if (port < this.port + maxRetries) {
            resolve(this.tryPort(port + 1, maxRetries));
          } else {
            reject(new Error(`No available ports found between ${this.port} and ${this.port + maxRetries}`));
          }
        } else {
          reject(err);
        }
      });
    });
  }

  public async start(): Promise<void> {
    try {
      // Connect to database first
      logger.info('🔄 Connecting to database...');
      await connectDatabase();
      logger.info('✅ Database connected successfully');

      // Initialize SerpApi Pool Manager (this handles API keys)
      logger.info('🔄 Initializing SerpApi Pool Manager...');
      const serpApiManager = SerpApiPoolManager.getInstance();
      await serpApiManager.initialize();
      
      // Check API key status
      const keyStats = serpApiManager.getKeyStats();
      if (keyStats.total === 0) {
        logger.warn('⚠️  No SerpAPI keys found in environment variables.');
        logger.info('🔧 API keys can be provided by users through the frontend.');
      } else {
        logger.info(`✅ SerpApi Pool Manager initialized with ${keyStats.total} keys`);
        logger.info(`🔑 Active keys: ${keyStats.active}/${keyStats.total}`);
      }

      // Schedule cleanup jobs
      logger.info('🔄 Initializing scheduled jobs...');
      scheduleCleanupJobs();
      logger.info('✅ Scheduled jobs initialized');

      // Find available port
      const availablePort = await this.tryPort(this.port);
      this.port = availablePort;

      // Start server - listen on all interfaces (0.0.0.0) to accept both IPv4 and IPv6
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        logger.info('🚀 SERP Tracker Server started successfully!');
        logger.info(`📍 Server running on port: ${this.port}`);
        logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`🔗 Local: http://localhost:${this.port}`);
        logger.info(`🔗 Network: http://0.0.0.0:${this.port}`);
        logger.info(`📋 API Documentation: http://localhost:${this.port}/api`);
        logger.info(`🏥 Health Check: http://localhost:${this.port}/health`);
        
        if (process.env.CORS_ORIGIN) {
          logger.info(`🌐 CORS Origins: ${process.env.CORS_ORIGIN}`);
        }
        
        // Log API key status
        const currentKeyStats = serpApiManager.getKeyStats();
        if (currentKeyStats.total > 0) {
          logger.info(`🔑 API Keys Status: ${currentKeyStats.active} active, ${currentKeyStats.exhausted} exhausted`);
          logger.info(`📊 Daily Usage: ${currentKeyStats.totalUsageToday}/${currentKeyStats.totalCapacity}`);
        }
      });

      // Set server timeout - increase for bulk operations (5 minutes)
      this.server.timeout = 300000; // 300 seconds (5 minutes)
      this.server.keepAliveTimeout = 305000; // 305 seconds
      this.server.headersTimeout = 310000; // 310 seconds
      
      // Handle server errors
      this.server.on('error', (error: any) => {
        logger.error('❌ Server error:', error);
      });
      
      this.server.on('clientError', (err: any, socket: any) => {
        logger.error('❌ Client error:', err);
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
      });

      // Setup graceful shutdown
      this.setupGracefulShutdown();
      
    } catch (error) {
      logger.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const gracefulShutdown = async (signal: string) => {
      logger.info(`📴 Received ${signal}. Starting graceful shutdown...`);
      
      const shutdownTimeout = setTimeout(() => {
        logger.error('💥 Forced shutdown due to timeout');
        process.exit(1);
      }, 10000); // 10 second timeout

      try {
        // Stop accepting new connections
        if (this.server) {
          this.server.close((err: any) => {
            if (err) {
              logger.error('❌ Error closing HTTP server:', err);
            } else {
              logger.info('🔌 HTTP server closed');
            }
          });
        }

        // Close database connection
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState !== 0) {
          await mongoose.connection.close();
          logger.info('🗄️  Database connection closed');
        }
        
        clearTimeout(shutdownTimeout);
        logger.info('✅ Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        clearTimeout(shutdownTimeout);
        logger.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    // Handle shutdown signals
    ['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach(signal => {
      process.on(signal, () => gracefulShutdown(signal));
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('💥 Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('🚫 Unhandled Promise Rejection:', { reason, promise });
      gracefulShutdown('unhandledRejection');
    });

    // Handle warnings
    process.on('warning', (warning) => {
      logger.warn('⚠️  Process Warning:', warning);
    });
  }

  public async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('🛑 Server stopped');
          resolve();
        });
      });
    }
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new Server();
  server.start().catch(error => {
    logger.error('💥 Failed to start application:', error);
    process.exit(1);
  });
}

export default Server;