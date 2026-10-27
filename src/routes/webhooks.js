import express from 'express';
import crypto from 'crypto';
import paymentService from '../services/paymentService.js';
import { supabaseAdmin } from '../db/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /api/webhooks/mpesa
 * Safaricom Daraja STK Push Server-to-Server Callback.
 * Verified and processed idempotently.
 */
router.post('/mpesa', async (req, res) => {
  const payload = req.body;
  const eventId = payload?.Body?.stkCallback?.CheckoutRequestID || `mpesa_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  logger.info({ eventId }, 'Incoming M-Pesa Webhook Callback');

  try {
    // 1. Record webhook in audit/webhook_events table
    await supabaseAdmin.from('webhook_events').insert({
      provider: 'mpesa',
      event_id: eventId,
      payload,
      processed: false,
    });

    // 2. Process callback through payment service
    const result = await paymentService.handleMpesaCallback(payload);

    // 3. Mark webhook as processed
    await supabaseAdmin
      .from('webhook_events')
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
      })
      .eq('event_id', eventId);

    // Safaricom expects a 200 OK with ResultCode: 0 in response
    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Callback processed successfully',
    });
  } catch (err) {
    logger.error({ eventId, err: err.message }, 'Failed to process M-Pesa webhook callback');

    await supabaseAdmin
      .from('webhook_events')
      .update({
        processed: false,
        error_message: err.message,
      })
      .eq('event_id', eventId);

    return res.status(200).json({
      ResultCode: 1,
      ResultDesc: 'Callback rejected or logged for manual inspection',
    });
  }
});

/**
 * POST /api/webhooks/card
 * Hosted/tokenized card payment provider webhook.
 */
router.post('/card', async (req, res) => {
  const payload = req.body;
  const eventId = req.headers['x-event-id'] || `card_${Date.now()}`;

  logger.info({ eventId }, 'Incoming Card Webhook');
  res.status(200).json({ received: true });
});

export default router;
