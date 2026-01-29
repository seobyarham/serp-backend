import { Application } from 'express';
import { searchRoutes } from './searchRoutes';
import { healthRoutes } from './healthRoutes';
import keyManagementRoutes from './keyManagementRoutes';

export const setupRoutes = (app: Application): void => {
  // API routes
  app.use('/api/search', searchRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/keys', keyManagementRoutes);

  // Root API documentation
  app.get('/api', (req, res) => {
    res.json({
      title: 'SERP Keyword Tracker API',
      version: '2.0.0',
      description: 'Professional API for tracking keyword positions with multiple SerpApi key support and automatic failover',
      documentation: 'https://github.com/your-repo/serp-tracker',
      endpoints: {
        'POST /api/search/analyze': {
          description: 'Analyze keywords with AI insights (Primary endpoint - handles single or bulk)',
          parameters: ['keywords', 'domain', 'country', 'city?', 'state?', 'postalCode?', 'apiKey?']
        },
        'POST /api/search/track': {
          description: 'Track a single keyword position',
          parameters: ['keyword', 'domain', 'country', 'city?', 'state?', 'postalCode?']
        },
        'POST /api/search/bulk': {
          description: 'Track multiple keywords in bulk',
          parameters: ['keywords[]', 'domain', 'country', 'city?', 'state?', 'postalCode?']
        },
        'GET /api/search/history': {
          description: 'Get search history with filters',
          parameters: ['domain?', 'keyword?', 'country?', 'limit?', 'offset?']
        },
        'GET /api/search/analytics': {
          description: 'Get keyword performance analytics',
          parameters: ['domain', 'days?']
        },
        'GET /api/search/trends': {
          description: 'Get keyword trend data over time',
          parameters: ['domain', 'keyword', 'days?']
        },
        'GET /api/search/export': {
          description: 'Export results in CSV or JSON format',
          parameters: ['domain?', 'format?', 'dateFrom?', 'dateTo?']
        },
        'GET /api/health': {
          description: 'System health check and API key statistics'
        },
        'GET /api/health/keys': {
          description: 'Detailed API key usage statistics'
        },
        'GET /api/keys/stats': {
          description: 'Get all API key statistics and details'
        },
        'POST /api/keys/add': {
          description: 'Add new API key to the pool',
          parameters: ['apiKey', 'dailyLimit?', 'monthlyLimit?']
        },
        'DELETE /api/keys/remove/:keyId': {
          description: 'Remove API key from the pool'
        },
        'PUT /api/keys/update/:keyId': {
          description: 'Update API key settings',
          parameters: ['dailyLimit?', 'monthlyLimit?', 'priority?']
        },
        'POST /api/keys/test': {
          description: 'Test if an API key is valid',
          parameters: ['apiKey']
        }
      },
      limits: {
        rateLimit: '100 requests per 15 minutes',
        searchLimit: '20 searches per minute',
        bulkLimit: '100 keywords per request'
      },
      support: {
        email: 'support@example.com',
        documentation: '/api/docs'
      }
    });
  });

  // API Documentation endpoint
  app.get('/api/docs', (req, res) => {
    res.json({
      openapi: '3.0.0',
      info: {
        title: 'SERP Keyword Tracker API',
        version: '2.0.0',
        description: 'Professional SERP tracking with multiple API key support'
      },
      servers: [
        {
          url: `http://localhost:${process.env.PORT || 5000}/api`,
          description: 'Development server'
        }
      ],
      paths: {
        '/search/track': {
          post: {
            summary: 'Track single keyword',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['keyword', 'domain', 'country'],
                    properties: {
                      keyword: { type: 'string', example: 'best pizza near me' },
                      domain: { type: 'string', example: 'example.com' },
                      country: { type: 'string', example: 'US' },
                      city: { type: 'string', example: 'New York' },
                      state: { type: 'string', example: 'NY' },
                      postalCode: { type: 'string', example: '10001' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  });
};
