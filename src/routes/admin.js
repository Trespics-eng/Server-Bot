import express from 'express';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import connectionManager from '../worker/connectionManager.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Require admin authentication on all routes in this file
router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/customers
 */
router.get('/customers', async (req, res) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select(`
        id,
        email,
        full_name,
        role,
        trial_used,
        trial_expires_at,
        created_at,
        whatsapp_accounts (
          id,
          phone_number,
          label,
          status,
          connected_at
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, customers: profiles || [] });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch admin customers');
    res.status(500).json({ success: false, error: 'Failed to load customers' });
  }
});

/**
 * GET /api/admin/whatsapp-accounts
 * View all WhatsApp numbers across all customers
 */
router.get('/whatsapp-accounts', async (req, res) => {
  try {
    const { data: accounts, error } = await supabaseAdmin
      .from('whatsapp_accounts')
      .select(`
        id,
        user_id,
        phone_number,
        label,
        status,
        connected_at,
        last_seen_at,
        created_at,
        profiles (
          id,
          email,
          full_name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = (accounts || []).map((acc) => {
      const live = connectionManager.getStatus(acc.id);
      return {
        ...acc,
        liveStatus: live || { status: acc.status, hasQR: false },
      };
    });

    res.json({ success: true, accounts: enriched });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch all admin whatsapp accounts');
    res.status(500).json({ success: false, error: 'Failed to load whatsapp accounts' });
  }
});

/**
 * GET /api/admin/metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const { count: customerCount } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true });

    const { count: accountsCount } = await supabaseAdmin
      .from('whatsapp_accounts')
      .select('id', { count: 'exact', head: true });

    const { count: activeSubsCount } = await supabaseAdmin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('amount_minor')
      .eq('status', 'success');

    const totalRevenueMinor = (payments || []).reduce((acc, p) => acc + (p.amount_minor || 0), 0);

    // Live worker metrics
    let liveConnectedCount = 0;
    for (const [, session] of connectionManager.sessions.entries()) {
      if (session.status === 'connected') liveConnectedCount++;
    }

    res.json({
      success: true,
      metrics: {
        totalCustomers: customerCount || 0,
        totalWhatsAppAccounts: accountsCount || 0,
        liveConnectedSessions: liveConnectedCount,
        activeSubscriptions: activeSubsCount || 0,
        totalRevenueKES: totalRevenueMinor,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch admin metrics');
    res.status(500).json({ success: false, error: 'Failed to load metrics' });
  }
});

/**
 * PATCH /api/admin/customers/:id/role
 */
router.patch('/customers/:id/role', async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['customer', 'admin'].includes(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: `Updated user role to ${role}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update role' });
  }
});

/**
 * GET /api/admin/payments
 * All payment transaction records across all users
 */
router.get('/payments', async (req, res) => {
  try {
    const { data: payments, error } = await supabaseAdmin
      .from('payments')
      .select(`
        id,
        order_id,
        user_id,
        provider,
        provider_tx_ref,
        checkout_request_id,
        amount_minor,
        currency,
        status,
        payer_phone,
        created_at,
        profiles (
          email,
          full_name
        ),
        orders (
          feature_code,
          plan_period,
          whatsapp_accounts (
            label,
            phone_number
          )
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, payments: payments || [] });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch admin payments');
    res.status(500).json({ success: false, error: 'Failed to load payments' });
  }
});

export default router;
