import cors from 'cors';

const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:9002'
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    console.log(`🔍 CORS: Processing origin: "${origin}" (type: ${typeof origin})`);
    
    // In development, allow all origins for testing
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV !== 'production') {
      console.log(`✅ CORS: Allowing origin in development mode: ${origin}`);
      return callback(null, true);
    }
    
    // Allow requests with no origin (mobile apps, curl, Postman, etc.)
    if (!origin) {
      console.log('✅ CORS: Allowing request with no origin');
      return callback(null, true);
    }
    
    // Allow file:// protocol for local HTML files
    if (typeof origin === 'string' && origin.startsWith('file://')) {
      console.log('✅ CORS: Allowing file:// origin');
      return callback(null, true);
    }
    
    // Allow null origin for local file access
    if (origin === 'null' || origin === null) {
      console.log('✅ CORS: Allowing null origin');
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      console.log('✅ CORS: Allowing whitelisted origin:', origin);
      return callback(null, true);
    }
    
    console.log(`❌ CORS: Rejecting origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-SerpAPI-Key'],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count']
});
