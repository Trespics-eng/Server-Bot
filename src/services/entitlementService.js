import { supabaseAdmin } from '../db/supabase.js';
import logger from '../utils/logger.js';

/**
 * Unified Entitlement & Subscription Verification Engine.
 * Answers authoritative entitlement questions:
 * 1. Active 7-day free trial -> All features entitled.
 * 2. Active 'bundle_all' subscription -> All features entitled.
 * 3. Active specific feature subscription -> Entitled.
 */
export class EntitlementService {
  constructor(dbClient = supabaseAdmin) {
    this.db = dbClient;
    /** @type {Map<string, { data: object, expiresAt: number }>} */
    this.overviewCache = new Map();
    this.cacheTtlMs = 30000; // 30 seconds in-memory cache
  }

  /**
   * Invalidate cached entitlements for an account (e.g. after subscription or trial change).
   * @param {string} [accountId]
   */
  invalidateCache(accountId) {
    if (accountId) {
      this.overviewCache.delete(accountId);
    } else {
      this.overviewCache.clear();
    }
  }

  /**
   * Check if an account is entitled to execute a feature.
   * @param {string} accountId - WhatsApp account UUID
   * @param {string} featureCode - e.g. 'anti_delete', 'auto_reply', etc.
   * @returns {Promise<{ entitled: boolean, reason: string, expiresAt: string|null }>}
   */
  async isFeatureEntitled(accountId, featureCode) {
    // If overview is cached, read directly from memory
    const cached = this.overviewCache.get(accountId);
    if (cached && Date.now() < cached.expiresAt && cached.data[featureCode]) {
      return cached.data[featureCode];
    }

    try {
      // 1. Fetch account & profile status
      const { data: account, error: accErr } = await this.db
        .from('whatsapp_accounts')
        .select(`
          id,
          status,
          user_id,
          profiles:user_id (
            id,
            role,
            trial_started_at,
            trial_expires_at,
            trial_used
          )
        `)
        .eq('id', accountId)
        .single();

      if (accErr || !account) {
        return { entitled: false, reason: 'account_not_found', expiresAt: null };
      }

      if (account.status === 'suspended') {
        return { entitled: false, reason: 'account_suspended', expiresAt: null };
      }

      const profile = account.profiles;
      const now = new Date();

      // 2. Check 7-Day Free Trial
      if (profile?.trial_expires_at) {
        const trialExpiry = new Date(profile.trial_expires_at);
        if (trialExpiry > now) {
          return {
            entitled: true,
            reason: 'trial',
            expiresAt: profile.trial_expires_at,
          };
        }
      }

      // 3. Check Active Subscriptions for this account:
      // Either exact feature OR All-In-One bundle
      const { data: subs, error: subErr } = await this.db
        .from('subscriptions')
        .select('id, feature_code, status, end_at')
        .eq('whatsapp_account_id', accountId)
        .in('feature_code', [featureCode, 'bundle_all'])
        .eq('status', 'active')
        .gt('end_at', now.toISOString());

      if (!subErr && subs && subs.length > 0) {
        // Find if bundle_all is active
        const bundleSub = subs.find((s) => s.feature_code === 'bundle_all');
        if (bundleSub) {
          return {
            entitled: true,
            reason: 'bundle_all_subscription',
            expiresAt: bundleSub.end_at,
          };
        }

        const featureSub = subs.find((s) => s.feature_code === featureCode);
        if (featureSub) {
          return {
            entitled: true,
            reason: 'feature_subscription',
            expiresAt: featureSub.end_at,
          };
        }
      }

      return {
        entitled: false,
        reason: 'unsubscribed_or_expired',
        expiresAt: null,
      };
    } catch (err) {
      logger.error({ accountId, featureCode, err: err.message }, 'Error in isFeatureEntitled check');
      return { entitled: false, reason: 'system_error', expiresAt: null };
    }
  }

  /**
   * Start 7-day free trial on first successful WhatsApp connection.
   * @param {string} userId
   * @returns {Promise<{ started: boolean, expiresAt: string }>}
   */
  async activateFreeTrialIfEligible(userId) {
    try {
      const { data: profile } = await this.db
        .from('profiles')
        .select('trial_used, trial_started_at, trial_expires_at')
        .eq('id', userId)
        .single();

      if (!profile || profile.trial_used) {
        return { started: false, expiresAt: profile?.trial_expires_at || null };
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 calendar days

      await this.db
        .from('profiles')
        .update({
          trial_started_at: now.toISOString(),
          trial_expires_at: expiresAt.toISOString(),
          trial_used: true,
          updated_at: now.toISOString(),
        })
        .eq('id', userId);

      this.invalidateCache();
      logger.info({ userId, expiresAt: expiresAt.toISOString() }, 'Activated 7-day free trial for user');
      return { started: true, expiresAt: expiresAt.toISOString() };
    } catch (err) {
      logger.error({ userId, err: err.message }, 'Failed to activate trial');
      return { started: false, expiresAt: null };
    }
  }

  /**
   * Return full entitlements overview for an account with high-speed memory caching.
   * Eliminates database bottleneck & prevents message lag under poor internet connections.
   * @param {string} accountId
   * @returns {Promise<object>}
   */
  async getAccountEntitlementsOverview(accountId) {
    const cached = this.overviewCache.get(accountId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const knownFeatures = ['anti_delete', 'auto_reply', 'anti_view_once', 'file_organizer', 'bundle_all'];
    const results = {};

    try {
      // Single batched query for account & profile
      const { data: account } = await this.db
        .from('whatsapp_accounts')
        .select(`
          id,
          status,
          user_id,
          profiles:user_id (
            id,
            role,
            trial_started_at,
            trial_expires_at,
            trial_used
          )
        `)
        .eq('id', accountId)
        .single();

      if (!account || account.status === 'suspended') {
        const fallback = { entitled: false, reason: account?.status === 'suspended' ? 'account_suspended' : 'account_not_found', expiresAt: null };
        knownFeatures.forEach((code) => { results[code] = fallback; });
        this.overviewCache.set(accountId, { data: results, expiresAt: Date.now() + this.cacheTtlMs });
        return results;
      }

      const profile = account.profiles;
      const now = new Date();
      let trialActive = false;
      let trialExpiry = null;

      if (profile?.trial_expires_at) {
        const exp = new Date(profile.trial_expires_at);
        if (exp > now) {
          trialActive = true;
          trialExpiry = profile.trial_expires_at;
        }
      }

      if (trialActive) {
        const trialEntitlement = { entitled: true, reason: 'trial', expiresAt: trialExpiry };
        knownFeatures.forEach((code) => { results[code] = trialEntitlement; });
        this.overviewCache.set(accountId, { data: results, expiresAt: Date.now() + this.cacheTtlMs });
        return results;
      }

      // Single batched query for active subscriptions
      const { data: subs } = await this.db
        .from('subscriptions')
        .select('id, feature_code, status, end_at')
        .eq('whatsapp_account_id', accountId)
        .eq('status', 'active')
        .gt('end_at', now.toISOString());

      const activeSubs = subs || [];
      const bundleSub = activeSubs.find((s) => s.feature_code === 'bundle_all');

      for (const code of knownFeatures) {
        if (bundleSub) {
          results[code] = { entitled: true, reason: 'bundle_all_subscription', expiresAt: bundleSub.end_at };
          continue;
        }
        const featSub = activeSubs.find((s) => s.feature_code === code);
        if (featSub) {
          results[code] = { entitled: true, reason: 'feature_subscription', expiresAt: featSub.end_at };
        } else {
          results[code] = { entitled: false, reason: 'unsubscribed_or_expired', expiresAt: null };
        }
      }

      this.overviewCache.set(accountId, { data: results, expiresAt: Date.now() + this.cacheTtlMs });
      return results;
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Failed in getAccountEntitlementsOverview');
      const fallback = { entitled: false, reason: 'system_error', expiresAt: null };
      knownFeatures.forEach((code) => { results[code] = fallback; });
      return results;
    }
  }

  /**
   * Scheduled job to expire lapsed subscriptions.
   * @returns {Promise<number>} expired count
   */
  async processExpiredSubscriptions() {
    try {
      const now = new Date().toISOString();
      const { data: expiredList, error } = await this.db
        .from('subscriptions')
        .update({ status: 'expired', updated_at: now })
        .eq('status', 'active')
        .lte('end_at', now)
        .select('id, whatsapp_account_id, feature_code');

      if (error) throw error;
      const count = expiredList?.length || 0;
      if (count > 0) {
        logger.info({ count }, 'Processed expired subscriptions');
      }
      return count;
    } catch (err) {
      logger.error({ err: err.message }, 'Error in processExpiredSubscriptions');
      return 0;
    }
  }
}

export const entitlementService = new EntitlementService();
export default entitlementService;
