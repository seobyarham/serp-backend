// src/config/database.ts
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

interface DatabaseConfig {
  uri: string;
  options: mongoose.ConnectOptions;
}

export const connectDatabase = async (): Promise<void> => {
  try {
    const config = getDatabaseConfig();
    
    // Set up connection event listeners before connecting
    setupConnectionEventListeners();
    
    logger.info('🔄 Connecting to MongoDB...');
    await mongoose.connect(config.uri, config.options);
    
    logger.info('✅ MongoDB connected successfully');
    logger.info(`📊 Database: ${mongoose.connection.name}`);
    logger.info(`🌐 Host: ${mongoose.connection.host}:${mongoose.connection.port}`);
    
    // Setup graceful shutdown
    setupGracefulShutdown();

  } catch (error) {
    logger.error('❌ Database connection failed:', error);
    
    // Provide helpful error messages
    if ((error as any).code === 'ENOTFOUND') {
      logger.error('💡 DNS resolution failed. Check your MongoDB URI and network connection.');
    } else if ((error as any).code === 'ECONNREFUSED') {
      logger.error('💡 Connection refused. Ensure MongoDB is running and accessible.');
    } else if ((error as Error).message.includes('authentication')) {
      logger.error('💡 Authentication failed. Check your MongoDB credentials.');
    }
    
    throw error;
  }
};

function getDatabaseConfig(): DatabaseConfig {
  const mongoUri = process.env.MONGODB_URI || 
                   process.env.DATABASE_URL || 
                   'mongodb://localhost:27017/serp_tracker';

  // Enhanced connection options for production
  const options: mongoose.ConnectOptions = {
    // Connection pool settings
    maxPoolSize: parseInt(process.env.DB_MAX_POOL_SIZE || '10'),
    minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '2'),
    
    // Timeout settings
    serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT || '5000'),
    socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT || '45000'),
    connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT || '10000'),
    
    // Retry and reconnection settings
    maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME || '30000'),
    retryWrites: true,
    retryReads: true,
    
    // Write concern for data durability
    writeConcern: {
      w: process.env.NODE_ENV === 'production' ? 'majority' : 1,
      j: true, // Request acknowledgment that write operations are written to the journal
      wtimeout: 5000
    },
    
    // Read preferences
    readPreference: 'primaryPreferred',
    
    // Disable deprecated options
    bufferCommands: false,
    
    // Application name for debugging
    appName: 'SERP-Tracker-API',
    
    // Compression
    compressors: ['zlib'],
    
    // Authentication (if needed)
    ...(process.env.DB_AUTH_SOURCE && {
      authSource: process.env.DB_AUTH_SOURCE
    })
  };

  return { uri: mongoUri, options };
}

function setupConnectionEventListeners(): void {
  // Connection successful
  mongoose.connection.on('connected', () => {
    logger.info('🔗 Mongoose connected to MongoDB');
  });

  // Connection error
  mongoose.connection.on('error', (error) => {
    logger.error('❌ MongoDB connection error:', error);
    
    // Don't exit on connection errors in production, let mongoose handle reconnection
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('🔄 In development mode, attempting to continue...');
    }
  });

  // Connection disconnected
  mongoose.connection.on('disconnected', () => {
    logger.warn('⚠️ MongoDB disconnected. Mongoose will attempt to reconnect...');
  });

  // Connection reconnected
  mongoose.connection.on('reconnected', () => {
    logger.info('🔄 MongoDB reconnected successfully');
  });

  // Connection close
  mongoose.connection.on('close', () => {
    logger.info('🔐 MongoDB connection closed');
  });

  // Full driver reconnect
  mongoose.connection.on('fullsetup', () => {
    logger.info('🎯 MongoDB replica set connection established');
  });

  // All servers disconnected
  mongoose.connection.on('all', () => {
    logger.info('🌐 MongoDB all servers connected');
  });

  // Mongoose buffer timeout
  mongoose.connection.on('timeout', () => {
    logger.warn('⏰ MongoDB connection timeout');
  });
}

function setupGracefulShutdown(): void {
  // Handle application termination signals
  const gracefulShutdown = async (signal: string) => {
    logger.info(`📴 Received ${signal}. Closing MongoDB connection...`);
    
    try {
      await mongoose.connection.close();
      logger.info('✅ MongoDB connection closed gracefully');
    } catch (error) {
      logger.error('❌ Error closing MongoDB connection:', error);
    }
  };

  // Listen for termination signals
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
}

// Database health check function with enhanced diagnostics
export const checkDatabaseHealth = async (): Promise<{
  status: string; 
  details?: any; 
  performance?: any;
}> => {
  try {
    const connection = mongoose.connection;
    
    if (connection.readyState === 1) {
      const db = connection.db;
      
      if (db) {
        // Perform health checks
        const healthCheckStart = Date.now();
        
        // 1. Basic ping test
        await db.admin().ping();
        const pingTime = Date.now() - healthCheckStart;
        
        // 2. Get database stats
        const stats = await db.stats();
        
        // 3. Get connection pool stats
        const poolStats = {
          maxPoolSize: (connection as any).client?.options?.maxPoolSize || 'unknown',
          minPoolSize: (connection as any).client?.options?.minPoolSize || 'unknown',
          currentConnections: (connection as any).client?.topology?.s?.cmap?.connections || 'unknown'
        };

        // 4. Get server status (if admin access available)
        let serverStatus = null;
        try {
          serverStatus = await db.admin().serverStatus();
        } catch (error) {
          logger.debug('Cannot access server status (admin privileges required)');
        }

        return { 
          status: 'connected', 
          details: {
            readyState: connection.readyState,
            host: connection.host,
            port: connection.port,
            name: connection.name,
            poolStats,
            databaseStats: {
              collections: stats.collections,
              dataSize: stats.dataSize,
              storageSize: stats.storageSize,
              indexes: stats.indexes,
              indexSize: stats.indexSize
            }
          },
          performance: {
            pingTime: `${pingTime}ms`,
            uptime: serverStatus?.uptime ? `${Math.floor(serverStatus.uptime / 60)} minutes` : 'unknown',
            version: serverStatus?.version || 'unknown'
          }
        };
      } else {
        return { 
          status: 'disconnected', 
          details: { 
            readyState: connection.readyState,
            reason: 'Database object not available'
          } 
        };
      }
    } else {
      const readyStateMap = {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting'
      };

      return { 
        status: 'disconnected', 
        details: { 
          readyState: connection.readyState,
          readyStateDescription: readyStateMap[connection.readyState as keyof typeof readyStateMap] || 'unknown'
        } 
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Database health check failed:', error);
    
    return { 
      status: 'error', 
      details: { 
        error: errorMessage,
        timestamp: new Date().toISOString()
      } 
    };
  }
};

// Advanced database operations
export const getDatabaseInfo = async (): Promise<any> => {
  try {
    const connection = mongoose.connection;
    
    if (connection.readyState !== 1) {
      throw new Error('Database not connected');
    }

    const db = connection.db!;
    
    // Get list of collections
    const collections = await db.listCollections().toArray();
    
    // Get database stats
    const dbStats = await db.stats();
    
    // Get collection stats for main collections
    const collectionStats = {};
    for (const collection of ['searchresults', 'apikeys']) {
      try {
        const stats = await (db.collection(collection) as any).stats();
        (collectionStats as any)[collection] = {
          count: stats.count,
          avgObjSize: stats.avgObjSize,
          storageSize: stats.storageSize,
          totalIndexSize: stats.totalIndexSize
        };
      } catch (error) {
        logger.debug(`Could not get stats for collection ${collection}`);
      }
    }

    return {
      database: {
        name: connection.name,
        collections: collections.map(c => c.name),
        stats: dbStats
      },
      collections: collectionStats,
      connection: {
        host: connection.host,
        port: connection.port,
        readyState: connection.readyState
      }
    };
  } catch (error) {
    logger.error('Failed to get database info:', error);
    throw error;
  }
};

// Create indexes for better performance
export const ensureIndexes = async (): Promise<void> => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database not connected');
    }

    logger.info('🔄 Ensuring database indexes...');

    // SearchResults collection indexes
    const searchResultsCollection = db.collection('searchresults');
    await Promise.all([
      searchResultsCollection.createIndex({ domain: 1, timestamp: -1 }),
      searchResultsCollection.createIndex({ keyword: 1, domain: 1 }),
      searchResultsCollection.createIndex({ timestamp: -1 }),
      searchResultsCollection.createIndex({ found: 1, position: 1 }),
      searchResultsCollection.createIndex({ country: 1 }),
      searchResultsCollection.createIndex({ domain: 1, keyword: 1, timestamp: -1 })
    ]);

    // ApiKeys collection indexes
    const apiKeysCollection = db.collection('apikeys');
    await Promise.all([
      apiKeysCollection.createIndex({ keyId: 1 }, { unique: true }),
      apiKeysCollection.createIndex({ status: 1 }),
      apiKeysCollection.createIndex({ priority: 1 }),
      apiKeysCollection.createIndex({ usedToday: 1 })
    ]);

    logger.info('✅ Database indexes ensured');
  } catch (error) {
    logger.error('❌ Failed to ensure indexes:', error);
    // Don't throw - indexes are performance optimization, not critical
  }
};

// Clean up old data
export const cleanupOldData = async (daysToKeep: number = 90): Promise<void> => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database not connected');
    }

    const result = await db.collection('searchresults').deleteMany({
      timestamp: { $lt: cutoffDate }
    });

    logger.info(`🧹 Cleaned up ${result.deletedCount} old search results (older than ${daysToKeep} days)`);
  } catch (error) {
    logger.error('❌ Failed to cleanup old data:', error);
    throw error;
  }
};