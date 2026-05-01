import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

const router  = Router();
const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ── POST /api/webhooks/stripe ─────────────────────────────────────────────────
// Note: raw body is set in index.js for this route
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder'
    );
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session  = event.data.object;
        const userId   = session.metadata?.user_id;
        const plan     = session.metadata?.plan;
        if (userId && plan) {
          await supabase.from('users').update({
            plan,
            subscription_status:    'active',
            stripe_subscription_id: session.subscription,
            stripe_customer_id:     session.customer,
            subscription_renews_at: null,
            updated_at:             new Date().toISOString(),
          }).eq('id', userId);
          logger.info('Subscription activated', { userId, plan });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.user_id;
          if (userId) {
            await supabase.from('users').update({
              subscription_status:    'active',
              subscription_renews_at: new Date(sub.current_period_end * 1000).toISOString(),
              updated_at:             new Date().toISOString(),
            }).eq('id', userId);
          }
          // Log invoice
          await supabase.from('invoices').insert({
            user_id:     userId,
            stripe_id:   invoice.id,
            amount:      invoice.amount_paid / 100,
            currency:    invoice.currency,
            status:      'paid',
            pdf_url:     invoice.invoice_pdf,
            created_at:  new Date(invoice.created * 1000).toISOString(),
          }).onConflict('stripe_id').ignore();
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const sub     = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId  = sub.metadata?.user_id;
        if (userId) {
          await supabase.from('users').update({
            subscription_status: 'past_due',
            updated_at:          new Date().toISOString(),
          }).eq('id', userId);
          logger.warn('Subscription payment failed', { userId });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await supabase.from('users').update({
            plan:                'starter',
            subscription_status: 'cancelled',
            updated_at:          new Date().toISOString(),
          }).eq('id', userId);
          logger.info('Subscription cancelled', { userId });
        }
        break;
      }

      default:
        logger.info('Unhandled Stripe event', { type: event.type });
    }
  } catch (err) {
    logger.error('Webhook processing error', { type: event.type, error: err.message });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  res.json({ received: true });
});

export default router;
