/**
 * Panalo.ai — Express Backend
 * Main entry point
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './middleware/error.js';
import { initQueue } from './workers/taskQueue.js';

// ── Routes ──────────────────────────────────────────────────────────────────
import authRoutes      from './routes/auth.js';
import taskRoutes      from './routes/tasks.js';
import agentRoutes     from './routes/agents.js';
import messageRoutes   from './routes/messages.js';
import billingRoutes   from './routes/billing.js';
import adminRoutes     from './routes/admin.js';
import webhookRoutes   from './routes/webhooks.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security & parsing ───────────────────────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // disabled so frontend HTML files work
}));

// Parse allowed origins from env
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, mobile apps)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS policy: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

app.use(compression());
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) }
}));

// ── Stripe webhooks need raw body BEFORE json parser ─────────────────────────
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Global rate limiting ─────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)        || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', globalLimiter);

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts. Please wait 15 minutes.' },
});
app.use('/api/auth/', authLimiter);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'panalo-ai-backend',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV,
  });
});

app.get('/', (_req, res) => {
  res.json({
    name:    'Panalo.ai API',
    version: '1.0.0',
    docs:    '/api/docs',
    health:  '/health',
  });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/tasks',    taskRoutes);
app.use('/api/agents',   agentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/billing',  billingRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/webhooks', webhookRoutes);

// ── 404 + Error handling ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start server ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // Initialize task queue (non-blocking — warn if Redis unavailable)
    await initQueue().catch(err => {
      logger.warn('Task queue unavailable (Redis not connected) — tasks will process synchronously', {
        error: err.message,
      });
    });

    app.listen(PORT, () => {
      logger.info(`🚀 Panalo.ai backend running`, {
        port: PORT,
        env:  process.env.NODE_ENV,
        url:  `http://localhost:${PORT}`,
      });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();

export default app;
