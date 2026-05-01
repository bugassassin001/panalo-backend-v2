import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const PLAN_PRICES = {
  starter:    process.env.STRIPE_PRICE_STARTER,
  pro:        process.env.STRIPE_PRICE_PRO,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

router.use(requireAuth);

// ── GET /api/billing/plans ───────────────────────────────────────────────────
router.get('/plans', asyncHandler(async (_req, res) => {
  res.json({
    plans: [
      {
        id:          'starter',
        name:        'Starter',
        price:       49,
        interval:    'month',
        tasks:       50,
        features:    ['50 tasks/month','AI auto-completion','Human fallback','Email notifications','Task dashboard'],
        highlighted: false,
      },
      {
        id:          'pro',
        name:        'Pro',
        price:       149,
        interval:    'month',
        tasks:       200,
        features:    ['200 tasks/month','Priority routing','In-task agent chat','Advanced dashboard','Slack integration'],
        highlighted: true,
      },
      {
        id:          'enterprise',
        name:        'Enterprise',
        price:       499,
        interval:    'month',
        tasks:       -1, // unlimited
        features:    ['Unlimited tasks','Dedicated named agent','Custom SLA','API access','Onboarding call'],
        highlighted: false,
      },
    ],
  });
}));

// ── GET /api/billing/subscription ────────────────────────────────────────────
router.get('/subscription', asyncHandler(async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get usage this cycle
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { count: tasksUsed } = await supabase
    .from('tasks').select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .gte('created_at', startOfMonth);

  const limits = { starter: 50, pro: 200, enterprise: -1 };
  const limit  = limits[user.plan] || 50;

  res.json({
    plan:            user.plan,
    status:          user.subscription_status || 'active',
    tasks_used:      tasksUsed || 0,
    tasks_limit:     limit,
    tasks_remaining: limit === -1 ? -1 : Math.max(0, limit - (tasksUsed || 0)),
    renews_at:       user.subscription_renews_at || null,
    stripe_customer: user.stripe_customer_id ? '••••' : null,
  });
}));

// ── POST /api/billing/checkout ───────────────────────────────────────────────
router.post('/checkout', asyncHandler(async (req, res) => {
  const { plan } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();

  // Create or retrieve Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email:    user.email,
      name:     `${user.first_name} ${user.last_name}`,
      metadata: { user_id: user.id, plan },
    });
    customerId = customer.id;
    await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer:   customerId,
    mode:       'subscription',
    line_items: [{ price: PLAN_PRICES[plan], quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success&plan=${plan}`,
    cancel_url:  `${process.env.FRONTEND_URL}/pricing?checkout=cancelled`,
    metadata:    { user_id: user.id, plan },
    subscription_data: { metadata: { user_id: user.id, plan } },
  });

  logger.info('Checkout session created', { userId: user.id, plan, sessionId: session.id });
  res.json({ url: session.url, sessionId: session.id });
}));

// ── POST /api/billing/portal ─────────────────────────────────────────────────
router.post('/portal', asyncHandler(async (req, res) => {
  const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.user.id).single();
  if (!user?.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Please subscribe to a plan first.' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer:   user.stripe_customer_id,
    return_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
  });

  res.json({ url: session.url });
}));

// ── GET /api/billing/invoices ─────────────────────────────────────────────────
router.get('/invoices', asyncHandler(async (req, res) => {
  const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.user.id).single();

  if (!user?.stripe_customer_id) return res.json({ invoices: [] });

  const invoices = await stripe.invoices.list({
    customer: user.stripe_customer_id, limit: 12,
  });

  res.json({
    invoices: invoices.data.map(inv => ({
      id:          inv.id,
      number:      inv.number,
      amount:      inv.amount_paid / 100,
      currency:    inv.currency,
      status:      inv.status,
      created:     new Date(inv.created * 1000).toISOString(),
      pdf:         inv.invoice_pdf,
      description: inv.lines.data[0]?.description || 'Panalo.ai subscription',
    })),
  });
}));

export default router;
