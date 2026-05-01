import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  logger.warn('Supabase credentials missing — database features will be unavailable');
}

// Service role client — full DB access, used server-side only
export const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder',
  {
    auth: { persistSession: false },
    db:   { schema: 'public' },
  }
);

// Helper: throw on Supabase error
export function assertOk({ data, error }, label = 'DB operation') {
  if (error) {
    logger.error(`${label} failed`, { error: error.message, code: error.code });
    throw Object.assign(new Error(error.message), { code: error.code, status: 500 });
  }
  return data;
}
