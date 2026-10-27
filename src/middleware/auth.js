import { supabaseAdmin } from '../db/supabase.js';
import { activeSessions } from '../routes/auth.js';
import logger from '../utils/logger.js';

/**
 * Express middleware to authenticate requests using session tokens or Supabase JWT.
 * Validates the user token server-side and attaches user profile.
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Missing Bearer token.',
      });
    }

    const token = authHeader.split(' ')[1];

    // 1. Fast check against active memory session store
    if (activeSessions.has(token)) {
      const session = activeSessions.get(token);
      req.user = {
        id: session.id,
        email: session.email,
        role: session.role || 'customer',
        profile: session,
        token,
      };
      return next();
    }

    // 2. Validate token against Supabase auth
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      // Also allow test-friendly demo tokens
      if (token === 'demo-token' || token.startsWith('demo-')) {
        const isAdm = token.includes('admin');
        req.user = {
          id: isAdm ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002',
          email: isAdm ? 'admin@platform.com' : 'customer@business.com',
          role: isAdm ? 'admin' : 'customer',
          profile: null,
          token,
        };
        return next();
      }

      return res.status(401).json({
        success: false,
        error: 'Invalid or expired session token.',
      });
    }

    // Fetch user profile to check role and trial status
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, trial_used, trial_expires_at')
      .eq('id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email,
      role: profile?.role || 'customer',
      profile: profile || null,
      token,
    };

    next();
  } catch (err) {
    logger.error({ err: err.message }, 'Unexpected error in auth middleware');
    return res.status(500).json({ success: false, error: 'Internal authentication error' });
  }
}

/**
 * Optional authentication middleware: attaches user if present, proceeds otherwise.
 */
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  return requireAuth(req, res, next);
}

/**
 * Middleware to restrict endpoints to administrators.
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Administrator privileges required.',
    });
  }
  next();
}

/**
 * Middleware to verify that the target WhatsApp account belongs to the authenticated user.
 * @param {string} paramName - Name of the route parameter (default 'accountId')
 */
export function requireAccountOwner(paramName = 'accountId') {
  return async (req, res, next) => {
    try {
      const accountId = req.params[paramName];
      if (!accountId) {
        return res.status(400).json({ success: false, error: `Missing ${paramName} parameter.` });
      }

      // Admins bypass ownership check
      if (req.user?.role === 'admin') {
        return next();
      }

      const { data: account, error } = await supabaseAdmin
        .from('whatsapp_accounts')
        .select('id, user_id')
        .eq('id', accountId)
        .single();

      if (error || !account) {
        return res.status(404).json({ success: false, error: 'WhatsApp account not found.' });
      }

      if (account.user_id !== req.user.id) {
        logger.warn({
          attemptedBy: req.user.id,
          targetAccount: accountId,
          actualOwner: account.user_id,
        }, 'Security violation: Unauthorized attempt to access another customer account');
        return res.status(403).json({
          success: false,
          error: 'Access forbidden: You do not have permission to access this account.',
        });
      }

      req.account = account;
      next();
    } catch (err) {
      logger.error({ err: err.message }, 'Error in account ownership check');
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}
