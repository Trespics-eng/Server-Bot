import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from './utils/logger.js';
import connectionManager from './worker/connectionManager.js';
import entitlementService from './services/entitlementService.js';
import { requireAuth } from './middleware/auth.js';
import { supabaseAdmin } from './db/supabase.js';

// Route imports
import authRouter, { activeSessions } from './routes/auth.js';
import accountsRouter from './routes/accounts.js';
import featuresRouter from './routes/features.js';
import checkoutRouter from './routes/checkout.js';
import subscriptionsRouter from './routes/subscriptions.js';
import webhooksRouter from './routes/webhooks.js';
import adminRouter from './routes/admin.js';
import feedbackRouter from './routes/feedback.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const IS_DEV = (process.env.NODE_ENV || 'development') === 'development';

// ── Security & Middleware ──
// In development: accept any origin so ngrok tunnels, LAN IPs, and the Vite
// dev server all work without constant reconfiguration.
// In production: lock this down to your actual domain.
app.use(cors({
  origin: IS_DEV
    ? true                              // allow ALL origins in dev
    : (process.env.FRONTEND_URL || 'http://localhost:5173'),
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'whatsapp-bot-saas-api',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── User Profile & Trial Info ──
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    let fullName = req.user.profile?.fullName || req.user.profile?.full_name || '';
    let role = req.user.role || 'customer';
    let trialStartedAt = req.user.profile?.trialStartedAt || req.user.profile?.trial_started_at || null;
    let trialExpiresAt = req.user.profile?.trialExpiresAt || req.user.profile?.trial_expires_at || null;
    let trialUsed = Boolean(req.user.profile?.trialUsed || req.user.profile?.trial_used);

    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();

      if (profile) {
        fullName = profile.full_name || fullName;
        role = profile.role || role;
        trialStartedAt = profile.trial_started_at || trialStartedAt;
        trialExpiresAt = profile.trial_expires_at || trialExpiresAt;
        trialUsed = Boolean(profile.trial_used);
      }
    } catch {}

    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        role,
        fullName,
        trialStartedAt,
        trialExpiresAt,
        trialUsed,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve profile' });
  }
});

// ── Update User Profile ──
app.patch('/api/me', requireAuth, async (req, res) => {
  try {
    const { fullName, email } = req.body;
    let updatedName = fullName;

    // Update in-memory session if active
    if (req.user.token && activeSessions.has(req.user.token)) {
      const sess = activeSessions.get(req.user.token);
      if (fullName !== undefined) sess.fullName = fullName;
      if (email !== undefined) sess.email = email;
      updatedName = sess.fullName;
    }

    // Update Supabase profile
    try {
      const updates = { updated_at: new Date().toISOString() };
      if (fullName !== undefined) updates.full_name = fullName;
      if (email !== undefined) updates.email = email;

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', req.user.id)
        .select()
        .single();

      if (profile?.full_name) updatedName = profile.full_name;
    } catch (dbErr) {
      logger.debug({ err: dbErr.message }, 'Supabase profile update fallback to session store');
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: email || req.user.email,
        role: req.user.role,
        fullName: updatedName || 'Customer',
        trialStartedAt: req.user.profile?.trialStartedAt || null,
        trialExpiresAt: req.user.profile?.trialExpiresAt || null,
        trialUsed: Boolean(req.user.profile?.trialUsed),
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to update profile');
    res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

// ── Mount API Routes ──
app.use('/api/auth', authRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/features', featuresRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin', adminRouter);
app.use('/api/feedback', feedbackRouter);

// ── Serve Built Dashboard (production / ngrok mode) ──
// When the dashboard is built with `npm run build:dashboard`, the static
// files land in server/public/. Express serves them here so a single
// port 4000 handles both the API and the dashboard UI.
const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));

  // SPA fallback — serve index.html for any non-API route so React Router works
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    const indexFile = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      return res.sendFile(indexFile);
    }
    next();
  });
}

// ── 404 Handler ──
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Centralized Error Handler ──
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled express route error');
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

// ── Background Jobs (Expiration checks) ──
const expirationInterval = setInterval(async () => {
  try {
    await entitlementService.processExpiredSubscriptions();
  } catch (err) {
    logger.error({ err: err.message }, 'Error in periodic expiration job');
  }
}, 600000); // Every 10 minutes

// ── Graceful Shutdown ──
let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, `WhatsApp SaaS API server running on port ${PORT}`);
    // Automatically reconnect all accounts with saved sessions on startup
    connectionManager.autoRestoreSessions();
  });
}

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutting down server gracefully...');
  clearInterval(expirationInterval);
  await connectionManager.shutdownAll();
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
