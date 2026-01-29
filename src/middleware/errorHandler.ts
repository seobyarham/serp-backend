import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ApiResponse } from '../types/api.types';

export const errorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  logger.error('Error occurred:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body
  });

  // Default error response
  let status = 500;
  let message = 'Internal Server Error';
  const errors: string[] = [];

  // Handle specific error types
  if (error.name === 'ValidationError') {
    status = 400;
    message = 'Validation Error';
    if (error.details) {
      errors.push(...error.details.map((d: any) => d.message));
    }
  } else if (error.name === 'CastError') {
    status = 400;
    message = 'Invalid ID format';
  } else if (error.code === 11000) {
    status = 409;
    message = 'Duplicate key error';
    errors.push('Resource already exists');
  } else if (error.name === 'MongoNetworkError') {
    status = 503;
    message = 'Database connection error';
  } else if (error.message) {
    message = error.message;
    
    // Check for specific API errors
    if (error.message.includes('quota') || error.message.includes('limit')) {
      status = 429;
      message = 'API quota exceeded';
    } else if (error.message.includes('timeout')) {
      status = 408;
      message = 'Request timeout';
    } else if (error.message.includes('Invalid JSON')) {
      status = 400;
      message = 'Invalid JSON format in request body';
    } else if (error.message.includes('validation')) {
      status = 400;
      message = 'Validation failed';
    }
  }

  const response: ApiResponse = {
    success: false,
    message,
    errors: errors.length > 0 ? errors : undefined,
    ...(process.env.NODE_ENV === 'development' && { 
      stack: error.stack,
      originalError: error.message,
      requestInfo: {
        method: req.method,
        url: req.url,
        body: req.body,
        headers: req.headers
      }
    })
  };

  res.status(status).json(response);
};