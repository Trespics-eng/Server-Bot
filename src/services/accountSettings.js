import { supabaseAdmin } from '../db/supabase.js';
import logger from '../utils/logger.js';

/**
 * In-memory settings cache per WhatsApp account:
 * accountId -> { key -> value }
 */
const settingsCache = new Map();

/**
 * Universal Account Settings Manager for Multi-Tenant WhatsApp Sessions.
 * Bridges in-memory performance with Supabase persistence.
 */
export const accountSettings = {
  /**
   * Get setting for a specific WhatsApp account.
   * @param {string} accountId
   * @param {string} key - e.g. 'anti_delete.enabled', 'bot.enabled'
   * @param {*} defaultValue
   * @returns {*}
   */
  get(accountId, key, defaultValue = null) {
    if (!accountId) return defaultValue;
    const accMap = settingsCache.get(accountId);
    if (accMap && accMap.has(key)) {
      return accMap.get(key);
    }
    return defaultValue;
  },

  /**
   * Set setting for a specific WhatsApp account.
   * Updates memory instantly and synchronizes with Supabase asynchronously.
   * @param {string} accountId
   * @param {string} key
   * @param {*} value
   */
  set(accountId, key, value) {
    if (!accountId) return;

    if (!settingsCache.has(accountId)) {
      settingsCache.set(accountId, new Map());
    }
    settingsCache.get(accountId).set(key, value);

    // Asynchronously save to Supabase feature_settings
    const [featureCode] = key.split('.');
    const currentJson = this.getAllForFeature(accountId, featureCode);
    currentJson[key.replace(`${featureCode}.`, '')] = value;

    supabaseAdmin
      .from('feature_settings')
      .upsert({
        whatsapp_account_id: accountId,
        feature_code: featureCode,
        settings_json: currentJson,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'whatsapp_account_id,feature_code' })
      .then(({ error }) => {
        if (error) logger.debug({ accountId, key, err: error.message }, 'Failed to persist feature setting');
      })
      .catch((err) => {
        logger.debug({ accountId, key, err: err.message }, 'Error updating feature setting');
      });
  },

  /**
   * Load all settings for an account from Supabase into memory cache.
   * @param {string} accountId
   */
  async loadAccountSettings(accountId) {
    try {
      if (!settingsCache.has(accountId)) {
        settingsCache.set(accountId, new Map());
      }
      const accMap = settingsCache.get(accountId);

      // Default settings
      accMap.set('bot.enabled', true);
      accMap.set('anti_delete.enabled', true);
      accMap.set('anti_delete.scope', 'both');
      accMap.set('anti_delete.save_media', true);
      accMap.set('anti_view_once.enabled', true);
      accMap.set('anti_view_once.scope', 'both');
      accMap.set('auto_reply.enabled', true);
      accMap.set('sticker_reply.enabled', true);
      accMap.set('file_organizer.enabled', true);

      const { data: rows } = await supabaseAdmin
        .from('feature_settings')
        .select('feature_code, settings_json')
        .eq('whatsapp_account_id', accountId);

      if (rows && Array.isArray(rows)) {
        for (const row of rows) {
          const code = row.feature_code;
          const json = row.settings_json || {};
          for (const [subKey, val] of Object.entries(json)) {
            accMap.set(`${code}.${subKey}`, val);
          }
        }
      }
    } catch (err) {
      logger.debug({ accountId, err: err.message }, 'Fallback to default account settings');
    }
  },

  getAllForFeature(accountId, featureCode) {
    const res = {};
    const accMap = settingsCache.get(accountId);
    if (!accMap) return res;

    const prefix = `${featureCode}.`;
    for (const [k, v] of accMap.entries()) {
      if (k.startsWith(prefix)) {
        res[k.replace(prefix, '')] = v;
      }
    }
    return res;
  },
};

export default accountSettings;
