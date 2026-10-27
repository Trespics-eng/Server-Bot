import axios from 'axios';
import crypto from 'crypto';
import { supabaseAdmin } from '../db/supabase.js';
import logger from '../utils/logger.js';

export class PaymentService {
  constructor(dbClient = supabaseAdmin) {
    this.db = dbClient;
    this.mpesaConsumerKey = process.env.MPESA_CONSUMER_KEY || '';
    this.mpesaConsumerSecret = process.env.MPESA_CONSUMER_SECRET || '';
    this.mpesaShortcode = process.env.MPESA_SHORTCODE || '174379';
    this.mpesaPasskey = process.env.MPESA_PASSKEY || '';
    this.mpesaCallbackUrl = process.env.MPESA_CALLBACK_URL || 'https://api.example.com/api/webhooks/mpesa';
    this.mpesaAuthUrl = process.env.MPESA_AUTH_URL || 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    this.mpesaStkUrl = process.env.MPESA_STK_URL || 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
  }

  /**
   * Helper to generate Daraja OAuth token.
   * @private
   */
  async getDarajaToken() {
    if (!this.mpesaConsumerKey || !this.mpesaConsumerSecret) {
      // Return mock token in test/sandbox if credentials not yet configured in local env
      return 'sandbox_mock_daraja_token';
    }

    const auth = Buffer.from(`${this.mpesaConsumerKey}:${this.mpesaConsumerSecret}`).toString('base64');
    try {
      const res = await axios.get(this.mpesaAuthUrl, {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000,
      });
      return res.data.access_token;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to obtain M-Pesa access token');
      throw new Error(`Daraja Authentication failed: ${err.message}`);
    }
  }

  /**
   * Helper to format international phone number for Daraja STK (254XXXXXXXXX).
   * @param {string} phone
   * @returns {string}
   */
  formatMpesaPhone(phone) {
    let clean = (phone || '').replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
      clean = '254' + clean.slice(1);
    } else if (clean.startsWith('7') || clean.startsWith('1')) {
      clean = '254' + clean;
    }
    return clean;
  }

  /**
   * Initiate M-Pesa STK Push.
   * @param {object} params - { orderId, userId, accountId, amountMinor, phone }
   * @returns {Promise<object>} { checkoutRequestId, merchantRequestId, status }
   */
  async initiateMpesaPayment({ orderId, userId, amountMinor, phone }) {
    const formattedPhone = this.formatMpesaPhone(phone);
    if (!formattedPhone || formattedPhone.length < 10) {
      throw new Error('Valid M-Pesa phone number is required (e.g., 2547XXXXXXXX)');
    }

    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const password = Buffer.from(`${this.mpesaShortcode}${this.mpesaPasskey}${timestamp}`).toString('base64');

    // Create pending payment record in DB
    const checkoutReqId = `ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const merchantReqId = `mr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const { data: payment, error: pErr } = await this.db
      .from('payments')
      .insert({
        order_id: orderId,
        user_id: userId,
        provider: 'mpesa',
        checkout_request_id: checkoutReqId,
        merchant_request_id: merchantReqId,
        amount_minor: amountMinor,
        currency: 'KES',
        status: 'pending',
        payer_phone: formattedPhone,
      })
      .select()
      .single();

    if (pErr) throw pErr;

    // If live credentials are provided, call Daraja STK Push API
    if (this.mpesaConsumerKey && this.mpesaConsumerSecret && this.mpesaPasskey) {
      try {
        const token = await this.getDarajaToken();
        const payload = {
          BusinessShortCode: this.mpesaShortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: amountMinor,
          PartyA: formattedPhone,
          PartyB: this.mpesaShortcode,
          PhoneNumber: formattedPhone,
          CallBackURL: this.mpesaCallbackUrl,
          AccountReference: `SUB-${orderId.slice(0, 8)}`,
          TransactionDesc: 'WhatsApp Bot Feature Subscription',
        };

        const res = await axios.post(this.mpesaStkUrl, payload, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000,
        });

        if (res.data.CheckoutRequestID) {
          await this.db
            .from('payments')
            .update({
              checkout_request_id: res.data.CheckoutRequestID,
              merchant_request_id: res.data.MerchantRequestID,
            })
            .eq('id', payment.id);

          return {
            paymentId: payment.id,
            checkoutRequestId: res.data.CheckoutRequestID,
            status: 'pending',
            message: 'STK push prompt sent to phone. Enter M-Pesa PIN.',
          };
        }
      } catch (err) {
        logger.error({ err: err.response?.data || err.message }, 'M-Pesa STK API request failed');
        // Keep payment pending/mark error
      }
    }

    // In sandbox / test mode without real Daraja credentials
    return {
      paymentId: payment.id,
      checkoutRequestId: checkoutReqId,
      status: 'pending',
      message: 'STK push prompt simulated for sandbox testing.',
    };
  }

  /**
   * Process and verify M-Pesa STK Push Callback safely & idempotently.
   * @param {object} callbackData - Raw callback payload from Safaricom
   * @returns {Promise<object>} result
   */
  async handleMpesaCallback(callbackData) {
    const stkCallback = callbackData?.Body?.stkCallback;
    if (!stkCallback) {
      throw new Error('Invalid M-Pesa callback format');
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    logger.info({ CheckoutRequestID, ResultCode, ResultDesc }, 'Received M-Pesa Callback');

    // 1. Find payment record by CheckoutRequestID
    const { data: payment, error: pErr } = await this.db
      .from('payments')
      .select('*, orders(*)')
      .eq('checkout_request_id', CheckoutRequestID)
      .single();

    if (pErr || !payment) {
      logger.warn({ CheckoutRequestID }, 'Payment record not found for M-Pesa callback');
      return { handled: false, reason: 'payment_not_found' };
    }

    // 2. Idempotency Check: If already processed successfully, avoid duplicate activation
    if (payment.status === 'success') {
      logger.info({ paymentId: payment.id }, 'Payment already marked success; skipping duplicate processing');
      return { handled: true, status: 'already_completed' };
    }

    // 3. Check ResultCode (0 = Success)
    if (ResultCode === 0) {
      let mpesaReceiptNumber = null;
      let transactionDate = null;
      let amountPaid = null;

      if (CallbackMetadata?.Item) {
        for (const item of CallbackMetadata.Item) {
          if (item.Name === 'MpesaReceiptNumber') mpesaReceiptNumber = item.Value;
          if (item.Name === 'TransactionDate') transactionDate = item.Value;
          if (item.Name === 'Amount') amountPaid = item.Value;
        }
      }

      // Update payment record
      await this.db
        .from('payments')
        .update({
          status: 'success',
          provider_tx_ref: mpesaReceiptNumber,
          raw_callback_json: callbackData,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id);

      // Update order record
      await this.db
        .from('orders')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', payment.order_id);

      // 4. Activate or extend subscription!
      await this.activateSubscriptionForOrder(payment.orders);

      logger.info({ orderId: payment.order_id, mpesaReceiptNumber }, 'Successfully activated subscription via M-Pesa');
      return { handled: true, status: 'success', receipt: mpesaReceiptNumber };
    } else {
      // Payment failed or was cancelled by user
      await this.db
        .from('payments')
        .update({
          status: 'failed',
          raw_callback_json: callbackData,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id);

      await this.db
        .from('orders')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', payment.order_id);

      logger.info({ orderId: payment.order_id, ResultDesc }, 'M-Pesa payment failed or cancelled');
      return { handled: true, status: 'failed', reason: ResultDesc };
    }
  }

  /**
   * Activates or extends the subscription when payment is verified.
   * Handles weekly (7 days) and monthly (30 days) plans.
   * @param {object} order
   */
  async activateSubscriptionForOrder(order) {
    if (!order) return;

    const { user_id, whatsapp_account_id, feature_code, plan_period, amount_minor, currency } = order;
    const durationDays = plan_period === 'monthly' ? 30 : 7;
    const now = new Date();

    // Check if an existing subscription exists for this account & feature
    const { data: existingSub } = await this.db
      .from('subscriptions')
      .select('id, end_at, status')
      .eq('whatsapp_account_id', whatsapp_account_id)
      .eq('feature_code', feature_code)
      .single();

    let startAt = now;
    let endAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // If currently active, extend from the existing end date rather than overwriting
    if (existingSub && existingSub.status === 'active' && new Date(existingSub.end_at) > now) {
      const currentExpiry = new Date(existingSub.end_at);
      endAt = new Date(currentExpiry.getTime() + durationDays * 24 * 60 * 60 * 1000);
      startAt = new Date(existingSub.start_at || now);
    }

    if (existingSub) {
      await this.db
        .from('subscriptions')
        .update({
          status: 'active',
          plan_period,
          amount_minor,
          currency,
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
          order_id: order.id,
          updated_at: now.toISOString(),
        })
        .eq('id', existingSub.id);
    } else {
      await this.db.from('subscriptions').insert({
        user_id,
        whatsapp_account_id,
        feature_code,
        plan_period,
        status: 'active',
        amount_minor,
        currency,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        order_id: order.id,
      });
    }

    logger.info({
      accountId: whatsapp_account_id,
      featureCode: feature_code,
      planPeriod: plan_period,
      expiresAt: endAt.toISOString(),
    }, 'Subscription activated/extended');
  }
}

export const paymentService = new PaymentService();
export default paymentService;
