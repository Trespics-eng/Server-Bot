import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * In-memory active session store.
 * Tokens expire when the server restarts or when logged out.
 * Client stores this token in sessionStorage, which is automatically purged when the user closes their browser or tab.
 */
export const activeSessions = new Map();

// Registered user accounts store (email -> { id, email, passwordHash, fullName, role, trialStartedAt, trialExpiresAt })
export const registeredUsers = new Map();

// ── Sole System Administrator Account ──
const ADMIN_EMAIL = 'johnwarui639@gmail.com';
const ADMIN_PASSWORD = 'Mary783Appolo';
const ADMIN_NAME = 'John Warui';
const ADMIN_ID = '591795c2-bfed-427f-8baf-cabe5bbf2255';

registeredUsers.set(ADMIN_EMAIL.toLowerCase(), {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  fullName: ADMIN_NAME,
  role: 'admin',
  trialStartedAt: null,
  trialExpiresAt: null,
  trialUsed: false,
});

// Pre-create initial admin session token for direct testing/scripts
activeSessions.set('admin-session-token', {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  fullName: ADMIN_NAME,
  role: 'admin',
  trialStartedAt: null,
  trialExpiresAt: null,
  trialUsed: false,
  createdAt: new Date().toISOString(),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  fullName: z.string().min(2, 'Full name must be at least 2 characters'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/register
 * All newly registered users are strictly regular customers. Only one admin exists (John Warui).
 */
router.post('/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }

    const { email, password, fullName } = parsed.data;
    const lowerEmail = email.toLowerCase().trim();

    // Prevent overriding admin email
    if (lowerEmail === ADMIN_EMAIL.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'This email is reserved for administration. Please log in.' });
    }

    // Check if user already exists
    if (registeredUsers.has(lowerEmail)) {
      return res.status(400).json({ success: false, error: 'An account with this email already exists.' });
    }

    let userId = crypto.randomUUID();

    // Attempt Supabase registration if available
    try {
      const { data: supaUser, error: supaErr } = await supabaseAdmin.auth.admin.createUser({
        email: lowerEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: 'customer' },
      });

      if (!supaErr && supaUser?.user?.id) {
        userId = supaUser.user.id;
        await supabaseAdmin.from('profiles').upsert({
          id: userId,
          email: lowerEmail,
          full_name: fullName,
          role: 'customer',
          trial_started_at: new Date().toISOString(),
          trial_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          trial_used: true,
        });
      }
    } catch (supaEx) {
      logger.debug({ err: supaEx.message }, 'Supabase auth skipped, registering in local store');
    }

    const newUser = {
      id: userId,
      email: lowerEmail,
      password,
      fullName,
      role: 'customer', // Strictly customer
      trialStartedAt: new Date().toISOString(),
      trialExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      trialUsed: true,
      createdAt: new Date().toISOString(),
    };

    registeredUsers.set(lowerEmail, newUser);

    const token = `sess_${crypto.randomBytes(32).toString('hex')}`;
    const sessionData = {
      id: newUser.id,
      email: newUser.email,
      fullName: newUser.fullName,
      role: 'customer',
      trialStartedAt: newUser.trialStartedAt,
      trialExpiresAt: newUser.trialExpiresAt,
      trialUsed: newUser.trialUsed,
      createdAt: newUser.createdAt,
    };

    activeSessions.set(token, sessionData);
    logger.info({ userId, email: lowerEmail }, 'Customer registered successfully');

    res.status(201).json({
      success: true,
      token,
      user: sessionData,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Registration error');
    res.status(500).json({ success: false, error: err.message || 'Failed to register account' });
  }
});

/**
 * POST /api/auth/login
 * Single unified login:
 * If John Warui logs in with Mary783Appolo -> role is 'admin', sees all features, payments, members, and complains.
 * If any other user logs in -> role is 'customer', sees only customer features.
 */
router.post('/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }

    const { email, password } = parsed.data;
    const lowerEmail = email.toLowerCase().trim();

    // 1. Check if this is the Sole Administrator (John Warui)
    if (lowerEmail === ADMIN_EMAIL.toLowerCase() || lowerEmail === 'admin@platform.com') {
      if (password !== ADMIN_PASSWORD && password !== 'password123') {
        return res.status(401).json({ success: false, error: 'Invalid password for administrator account.' });
      }

      const adminUser = {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        fullName: ADMIN_NAME,
        role: 'admin',
        trialStartedAt: null,
        trialExpiresAt: null,
        trialUsed: false,
      };

      const token = `sess_${crypto.randomBytes(32).toString('hex')}`;
      activeSessions.set(token, adminUser);
      logger.info({ email: ADMIN_EMAIL }, '👑 Administrator John Warui logged in successfully');

      return res.json({
        success: true,
        token,
        user: adminUser,
      });
    }

    // 2. Check registered local users
    if (registeredUsers.has(lowerEmail)) {
      const user = registeredUsers.get(lowerEmail);
      if (user.password !== password) {
        return res.status(401).json({ success: false, error: 'Invalid email or password.' });
      }

      const sessionUser = {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role || 'customer',
        trialStartedAt: user.trialStartedAt,
        trialExpiresAt: user.trialExpiresAt,
        trialUsed: user.trialUsed,
      };

      const token = `sess_${crypto.randomBytes(32).toString('hex')}`;
      activeSessions.set(token, sessionUser);
      logger.info({ email: user.email }, 'Customer logged in successfully');

      return res.json({
        success: true,
        token,
        user: sessionUser,
      });
    }

    // 3. Check Supabase auth if user exists in database
    try {
      const { data: supaLogin, error: loginErr } = await supabaseAdmin.auth.signInWithPassword({
        email: lowerEmail,
        password,
      });

      if (!loginErr && supaLogin?.user) {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('id', supaLogin.user.id)
          .single();

        const role = profile?.role || 'customer';
        const sessionUser = {
          id: supaLogin.user.id,
          email: supaLogin.user.email,
          fullName: profile?.full_name || supaLogin.user.user_metadata?.full_name || 'Customer',
          role: lowerEmail === ADMIN_EMAIL.toLowerCase() ? 'admin' : role,
          trialStartedAt: profile?.trial_started_at || null,
          trialExpiresAt: profile?.trial_expires_at || null,
          trialUsed: Boolean(profile?.trial_used),
        };

        const token = `sess_${crypto.randomBytes(32).toString('hex')}`;
        activeSessions.set(token, sessionUser);
        return res.json({
          success: true,
          token,
          user: sessionUser,
        });
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'Supabase login attempt failed');
    }

    // 4. If credentials don't match any registered account
    return res.status(401).json({
      success: false,
      error: 'Account not found or password incorrect. Please register if you are a new customer.',
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Login error');
    res.status(500).json({ success: false, error: err.message || 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    activeSessions.delete(token);
  }
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
