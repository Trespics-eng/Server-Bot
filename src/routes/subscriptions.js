import express from 'express';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/subscriptions
 * Retrieve all subscriptions for the authenticated customer.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: subs, error } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        id,
        feature_code,
        plan_period,
        status,
        amount_minor,
        currency,
        start_at,
        end_at,
        whatsapp_accounts (
          id,
          label,
          phone_number
        )
      `)
      .eq('user_id', req.user.id)
      .order('end_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, subscriptions: subs || [] });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch subscriptions');
    res.status(500).json({ success: false, error: 'Failed to load subscriptions' });
  }
});

/**
 * GET /api/subscriptions/payments
 * Retrieve customer payment history.
 */
router.get('/payments', requireAuth, async (req, res) => {
  try {
    const { data: payments, error } = await supabaseAdmin
      .from('payments')
      .select(`
        id,
        provider,
        provider_tx_ref,
        amount_minor,
        currency,
        status,
        payer_phone,
        created_at,
        orders (
          feature_code,
          plan_period,
          whatsapp_accounts (
            label,
            phone_number
          )
        )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, payments: payments || [] });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch payment history');
    res.status(500).json({ success: false, error: 'Failed to load payments' });
  }
});

export default router;
