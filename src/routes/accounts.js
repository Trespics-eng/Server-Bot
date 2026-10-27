import express from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth, requireAccountOwner } from '../middleware/auth.js';
import connectionManager from '../worker/connectionManager.js';
import entitlementService from '../services/entitlementService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const createAccountSchema = z.object({
  phoneNumber: z.string().optional(),
  label: z.string().min(1).max(50).default('My WhatsApp'),
});

/**
 * GET /api/accounts
 * List all WhatsApp accounts owned by authenticated user.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: accounts, error } = await supabaseAdmin
      .from('whatsapp_accounts')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Augment with real-time in-memory connection status & entitlements
    const enriched = await Promise.all(
      (accounts || []).map(async (acc) => {
        const liveStatus = connectionManager.getStatus(acc.id);
        const entitlements = await entitlementService.getAccountEntitlementsOverview(acc.id);
        return {
          ...acc,
          liveStatus: liveStatus || { status: acc.status, hasQR: false },
          entitlements,
        };
      })
    );

    res.json({ success: true, accounts: enriched });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch accounts');
    res.status(500).json({ success: false, error: 'Failed to retrieve WhatsApp accounts' });
  }
});

/**
 * POST /api/accounts
 * Create a new WhatsApp account record (enforces max 3 limit).
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }

    // 1. Concurrency-safe limit check: Max accounts per customer (default 10)
    const maxAllowed = parseInt(process.env.MAX_ACCOUNTS_PER_USER || '10', 10);
    const { count, error: countErr } = await supabaseAdmin
      .from('whatsapp_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    if (countErr) throw countErr;

    if (count >= maxAllowed) {
      return res.status(400).json({
        success: false,
        error: `Account limit reached: Customers can register up to ${maxAllowed} WhatsApp numbers.`,
      });
    }

    // Clean phone number if supplied
    let cleanPhone = null;
    if (parsed.data.phoneNumber) {
      cleanPhone = parsed.data.phoneNumber.replace(/[^0-9]/g, '');
    }

    // 2. Insert account record
    const { data: newAccount, error: insErr } = await supabaseAdmin
      .from('whatsapp_accounts')
      .insert({
        user_id: req.user.id,
        phone_number: cleanPhone,
        label: parsed.data.label,
        status: 'pending',
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // Initialize session structure
    connectionManager.initAccount(newAccount.id, {
      userId: req.user.id,
      label: newAccount.label,
      phoneNumber: newAccount.phone_number,
    });

    res.status(201).json({
      success: true,
      account: {
        ...newAccount,
        liveStatus: connectionManager.getStatus(newAccount.id),
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Error creating WhatsApp account');
    res.status(500).json({ success: false, error: err.message || 'Failed to create account' });
  }
});

/**
 * GET /api/accounts/:accountId
 */
router.get('/:accountId', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  const liveStatus = connectionManager.getStatus(accountId);
  const entitlements = await entitlementService.getAccountEntitlementsOverview(accountId);
  res.json({
    success: true,
    account: {
      ...req.account,
      liveStatus: liveStatus || { status: req.account.status },
      entitlements,
    },
  });
});

/**
 * POST /api/accounts/:accountId/activate
 * Requests WhatsApp connection and QR generation.
 */
router.post('/:accountId/activate', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  const forceNew = req.query.force === 'true' || Boolean(req.body?.force) || Boolean(req.body?.freshQR);
  try {
    // Only force restart/fresh QR when user explicitly requests it.
    // Otherwise let startConnection's built-in deduplication work:
    // - If already connected, returns existing status
    // - If QR is already active and not expired, keeps the same QR
    // - If socket is dead/missing, creates a new one
    const liveStatus = await connectionManager.startConnection(
      accountId,
      { userId: req.user.id },
      { forceRestart: forceNew, forceNewQR: forceNew }
    );

    res.json({
      success: true,
      message: 'Connection initialization started',
      status: liveStatus,
    });
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Failed to activate bot');
    res.status(500).json({ success: false, error: 'Could not start WhatsApp connection' });
  }
});

/**
 * GET /api/accounts/:accountId/status
 * Get safe real-time connection status.
 */
router.get('/:accountId/status', requireAuth, requireAccountOwner(), (req, res) => {
  const { accountId } = req.params;
  const status = connectionManager.getStatus(accountId);
  if (!status) {
    return res.json({
      success: true,
      status: { accountId, status: req.account.status, hasQR: false },
    });
  }
  res.json({ success: true, status });
});

/**
 * GET /api/accounts/:accountId/qr
 * Retrieve rendered QR code data URL for pairing.
 */
router.get('/:accountId/qr', requireAuth, requireAccountOwner(), (req, res) => {
  const { accountId } = req.params;
  const qrInfo = connectionManager.getQR(accountId);

  if (!qrInfo || !qrInfo.qrDataUrl) {
    return res.json({
      success: true,
      hasQR: false,
      status: qrInfo?.status || req.account.status,
      message: 'No active QR code available. Click Activate Bot to generate one.',
    });
  }

  res.json({
    success: true,
    hasQR: true,
    qrDataUrl: qrInfo.qrDataUrl,
    expiresAt: qrInfo.expiresAt,
    status: qrInfo.status,
  });
});

/**
 * POST /api/accounts/:accountId/pairing-code
 * Generates an 8-digit pairing code to link WhatsApp with phone number without scanning a QR code.
 */
router.post('/:accountId/pairing-code', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  const phoneNumber = req.body.phoneNumber || req.account.phone_number;

  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      error: 'Phone number with country code is required to generate a WhatsApp pairing code.',
    });
  }

  try {
    const result = await connectionManager.requestPairingCode(accountId, phoneNumber);
    res.json({
      success: true,
      pairingCode: result.pairingCode,
      phoneNumber: result.phoneNumber,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Failed to generate pairing code');
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to generate WhatsApp pairing code',
    });
  }
});

/**
 * POST /api/accounts/:accountId/disconnect
 */
router.post('/:accountId/disconnect', requireAuth, requireAccountOwner(), (req, res) => {
  const { accountId } = req.params;
  const disconnected = connectionManager.disconnect(accountId);
  res.json({ success: true, disconnected, status: 'disconnected' });
});

/**
 * POST /api/accounts/:accountId/reconnect
 */
router.post('/:accountId/reconnect', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  connectionManager.disconnect(accountId);
  const status = await connectionManager.startConnection(accountId, { userId: req.user.id });
  res.json({ success: true, status });
});

/**
 * DELETE /api/accounts/:accountId
 */
router.delete('/:accountId', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  try {
    // 1. Remove from worker and clean files
    connectionManager.removeAccount(accountId, true);

    // 2. Delete database record
    const { error } = await supabaseAdmin
      .from('whatsapp_accounts')
      .delete()
      .eq('id', accountId);

    if (error) throw error;

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Failed to delete account');
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

export default router;
