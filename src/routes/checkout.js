import express from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import paymentService from '../services/paymentService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const checkoutSchema = z.object({
  accountId: z.string().uuid(),
  featureCode: z.string().min(1),
  period: z.enum(['weekly', 'monthly']),
  paymentMethod: z.enum(['mpesa', 'card']).default('mpesa'),
  phoneNumber: z.string().optional(),
});

/**
 * POST /api/checkout
 * Authoritative checkout initiation. Retrieves price from database,
 * creates pending order, and initiates M-Pesa STK push or Card session.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }

    const { accountId, featureCode, period, paymentMethod, phoneNumber } = parsed.data;

    // 1. Verify account ownership
    const { data: account, error: accErr } = await supabaseAdmin
      .from('whatsapp_accounts')
      .select('id, user_id, phone_number')
      .eq('id', accountId)
      .single();

    if (accErr || !account || (account.user_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'Unauthorized WhatsApp account.' });
    }

    // 2. Authoritative Price Lookup from DB (never trust browser-supplied price)
    const { data: feature, error: fErr } = await supabaseAdmin
      .from('feature_catalog')
      .select(`
        id,
        code,
        name,
        feature_prices (
          id,
          period,
          duration_days,
          amount_minor,
          currency,
          is_active
        )
      `)
      .eq('code', featureCode)
      .eq('is_active', true)
      .single();

    if (fErr || !feature) {
      return res.status(400).json({ success: false, error: `Invalid or unavailable feature: ${featureCode}` });
    }

    const price = feature.feature_prices?.find((p) => p.period === period && p.is_active);
    if (!price) {
      return res.status(400).json({ success: false, error: `No active price configured for period: ${period}` });
    }

    const idempotencyKey = crypto.randomUUID();

    // 3. Create pending Order
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: req.user.id,
        whatsapp_account_id: accountId,
        feature_code: featureCode,
        plan_period: period,
        amount_minor: price.amount_minor,
        currency: price.currency,
        status: 'pending',
        idempotency_key: idempotencyKey,
      })
      .select()
      .single();

    if (orderErr) throw orderErr;

    // 4. Initiate Payment with selected provider
    if (paymentMethod === 'mpesa') {
      const payerPhone = phoneNumber || account.phone_number;
      if (!payerPhone) {
        return res.status(400).json({
          success: false,
          error: 'M-Pesa phone number is required (e.g., 2547XXXXXXXX).',
        });
      }

      const paymentResult = await paymentService.initiateMpesaPayment({
        orderId: order.id,
        userId: req.user.id,
        amountMinor: price.amount_minor,
        phone: payerPhone,
      });

      return res.json({
        success: true,
        orderId: order.id,
        amount: price.amount_minor,
        currency: price.currency,
        paymentMethod: 'mpesa',
        payment: paymentResult,
      });
    }

    // Card checkout flow (hosted/tokenized session)
    return res.json({
      success: true,
      orderId: order.id,
      amount: price.amount_minor,
      currency: price.currency,
      paymentMethod: 'card',
      message: 'Card payment session initiated',
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Checkout initiation error');
    res.status(500).json({ success: false, error: err.message || 'Checkout failed' });
  }
});

/**
 * GET /api/checkout/orders/:orderId
 * Poll order and payment status.
 */
router.get('/orders/:orderId', requireAuth, async (req, res) => {
  const { orderId } = req.params;
  try {
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*, payments(*)')
      .eq('id', orderId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve order status' });
  }
});

export default router;
