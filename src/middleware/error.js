import { logger } from '../lib/logger.js';

export function notFound(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    available: ['/health', '/api/auth', '/api/tasks', '/api/messages', '/api/billing'],
  });
}

export function errorHandler(err, req, res, _next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Don't log 4xx as errors
  if (status >= 500) {
    logger.error('Unhandled error', {
      status, message,
      path:   req.path,
      method: req.method,
      stack:  err.stack,
    });
  }

  res.status(status).json({
    error:   message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * Wrap async route handlers — eliminates try/catch boilerplate
 */
export const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
