import express from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth, requireAccountOwner } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/features
 * Return all active catalog features with weekly and monthly prices.
 */
router.get('/', async (req, res) => {
  try {
    const { data: catalog, error } = await supabaseAdmin
      .from('feature_catalog')
      .select(`
        id,
        code,
        name,
        description,
        category,
        is_bundle,
        feature_prices (
          id,
          period,
          duration_days,
          amount_minor,
          currency
        )
      `)
      .eq('is_active', true)
      .order('is_bundle', { ascending: false });

    if (error) throw error;
    res.json({ success: true, features: catalog || [] });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load feature catalog');
    res.status(500).json({ success: false, error: 'Could not load feature catalog' });
  }
});

/**
 * GET /api/accounts/:accountId/features/:featureCode/settings
 */
router.get('/:accountId/features/:featureCode/settings', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId, featureCode } = req.params;
  try {
    const { data: settings } = await supabaseAdmin
      .from('feature_settings')
      .select('settings_json')
      .eq('whatsapp_account_id', accountId)
      .eq('feature_code', featureCode)
      .single();

    res.json({
      success: true,
      settings: settings?.settings_json || {},
    });
  } catch (err) {
    logger.error({ accountId, featureCode, err: err.message }, 'Error fetching feature settings');
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * PUT /api/accounts/:accountId/features/:featureCode/settings
 */
router.put('/:accountId/features/:featureCode/settings', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId, featureCode } = req.params;
  const newSettings = req.body.settings || {};

  try {
    const { data, error } = await supabaseAdmin
      .from('feature_settings')
      .upsert({
        whatsapp_account_id: accountId,
        feature_code: featureCode,
        settings_json: newSettings,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'whatsapp_account_id,feature_code' })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, settings: data.settings_json });
  } catch (err) {
    logger.error({ accountId, featureCode, err: err.message }, 'Failed to save feature settings');
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/**
 * GET /api/accounts/:accountId/rules
 */
router.get('/:accountId/rules', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  try {
    const { data: rules, error } = await supabaseAdmin
      .from('keyword_rules')
      .select('*')
      .eq('whatsapp_account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, rules: rules || [] });
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Failed to fetch keyword rules');
    res.status(500).json({ success: false, error: 'Could not load rules' });
  }
});

const ruleSchema = z.object({
  keyword: z.string().min(1).max(100),
  replyText: z.string().min(1).max(2000),
  matchType: z.enum(['exact', 'contains', 'regex', 'starts_with']).default('contains'),
  caseSensitive: z.boolean().default(false),
  scope: z.enum(['all', 'private', 'group']).default('all'),
  enabled: z.boolean().default(true),
});

/**
 * POST /api/accounts/:accountId/rules
 */
router.post('/:accountId/rules', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId } = req.params;
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
  }

  try {
    const { data: rule, error } = await supabaseAdmin
      .from('keyword_rules')
      .insert({
        whatsapp_account_id: accountId,
        keyword: parsed.data.keyword,
        reply_text: parsed.data.replyText,
        match_type: parsed.data.matchType,
        case_sensitive: parsed.data.caseSensitive,
        scope: parsed.data.scope,
        enabled: parsed.data.enabled,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, rule });
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Failed to create rule');
    res.status(500).json({ success: false, error: 'Could not create rule' });
  }
});

/**
 * PUT /api/accounts/:accountId/rules/:ruleId
 * Update an existing custom auto-reply rule
 */
router.put('/:accountId/rules/:ruleId', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId, ruleId } = req.params;
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (parsed.data.keyword !== undefined) updates.keyword = parsed.data.keyword;
  if (parsed.data.replyText !== undefined) updates.reply_text = parsed.data.replyText;
  if (parsed.data.matchType !== undefined) updates.match_type = parsed.data.matchType;
  if (parsed.data.caseSensitive !== undefined) updates.case_sensitive = parsed.data.caseSensitive;
  if (parsed.data.scope !== undefined) updates.scope = parsed.data.scope;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;

  try {
    const { data: updated, error } = await supabaseAdmin
      .from('keyword_rules')
      .update(updates)
      .eq('id', ruleId)
      .eq('whatsapp_account_id', accountId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, rule: updated });
  } catch (err) {
    logger.error({ ruleId, err: err.message }, 'Failed to update rule');
    res.status(500).json({ success: false, error: 'Could not update rule' });
  }
});

/**
 * PATCH /api/accounts/:accountId/rules/:ruleId/toggle
 */
router.patch('/:accountId/rules/:ruleId/toggle', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId, ruleId } = req.params;
  try {
    const { data: current } = await supabaseAdmin
      .from('keyword_rules')
      .select('enabled')
      .eq('id', ruleId)
      .eq('whatsapp_account_id', accountId)
      .single();

    const newEnabled = current ? !current.enabled : true;

    const { data: updated, error } = await supabaseAdmin
      .from('keyword_rules')
      .update({ enabled: newEnabled, updated_at: new Date().toISOString() })
      .eq('id', ruleId)
      .eq('whatsapp_account_id', accountId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, enabled: updated?.enabled });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to toggle rule' });
  }
});

/**
 * DELETE /api/accounts/:accountId/rules/:ruleId
 */
router.delete('/:accountId/rules/:ruleId', requireAuth, requireAccountOwner(), async (req, res) => {
  const { accountId, ruleId } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('keyword_rules')
      .delete()
      .eq('id', ruleId)
      .eq('whatsapp_account_id', accountId);

    if (error) throw error;
    res.json({ success: true, message: 'Rule deleted successfully' });
  } catch (err) {
    logger.error({ ruleId, err: err.message }, 'Failed to delete rule');
    res.status(500).json({ success: false, error: 'Could not delete rule' });
  }
});

export default router;
