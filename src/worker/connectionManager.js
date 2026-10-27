import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import NodeCache from '@cacheable/node-cache';
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidStatusBroadcast,
  isJidNewsletter,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import logger from '../utils/logger.js';
import { isValidAccountId, buildSandboxedPath } from '../utils/pathSafety.js';
import { supabaseAdmin } from '../db/supabase.js';
import entitlementService from '../services/entitlementService.js';

// Resolve project root for logo path
const __cm_filename = fileURLToPath(import.meta.url);
const __cm_dirname = path.dirname(__cm_filename);
const LOGO_PATH = path.resolve(__cm_dirname, '../../../logo.png');

export const ConnectionStatus = {
  PENDING: 'pending',
  CONNECTING: 'connecting',
  QR_READY: 'qr_ready',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  NEEDS_REAUTHENTICATION: 'needs_reauthentication',
  ERROR: 'error',
  SUSPENDED: 'suspended',
};

/**
 * Multi-account WhatsApp Connection Manager.
 * Maintains isolated Baileys socket sessions per customer account.
 */
export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseAuthDir = path.resolve(options.baseAuthDir || process.env.AUTH_DIR || './auth');
    this.baseDownloadDir = path.resolve(options.baseDownloadDir || process.env.DOWNLOAD_DIR || './downloads');
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.qrTtlMs = options.qrTtlMs || 60000; // 60s QR code validity

    /** @type {Map<string, object>} accountId -> session data */
    this.sessions = new Map();

    // Ensure base directories exist
    if (!fs.existsSync(this.baseAuthDir)) {
      fs.mkdirSync(this.baseAuthDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(this.baseDownloadDir)) {
      fs.mkdirSync(this.baseDownloadDir, { recursive: true, mode: 0o700 });
    }

    // Connect message pipeline
    this.on('messages.upsert', (payload) => {
      import('./messagePipeline.js')
        .then(({ messagePipeline }) => messagePipeline.handleIncomingMessages(payload))
        .catch((err) => logger.error({ err: err.message }, 'Pipeline upsert invocation error'));
    });

    this.on('messages.update', (payload) => {
      import('./messagePipeline.js')
        .then(({ messagePipeline }) => messagePipeline.handleMessageUpdates(payload))
        .catch((err) => logger.error({ err: err.message }, 'Pipeline update invocation error'));
    });
  }

  /**
   * Register or fetch an account session instance in memory.
   * @param {string} accountId - Unique account UUID
   * @param {object} metadata - { userId, phoneNumber, label }
   * @returns {object} session
   */
  initAccount(accountId, metadata = {}) {
    if (!isValidAccountId(accountId)) {
      throw new Error(`Invalid accountId format: ${accountId}`);
    }

    if (this.sessions.has(accountId)) {
      const session = this.sessions.get(accountId);
      if (metadata.userId) session.userId = metadata.userId;
      if (metadata.label) session.label = metadata.label;
      if (metadata.phoneNumber) session.phoneNumber = metadata.phoneNumber;
      return session;
    }

    const authDir = buildSandboxedPath(this.baseAuthDir, accountId);
    const downloadDir = buildSandboxedPath(this.baseDownloadDir, accountId);

    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
    }

    const session = {
      accountId,
      userId: metadata.userId || null,
      phoneNumber: metadata.phoneNumber || null,
      label: metadata.label || 'Default WhatsApp',
      authDir,
      downloadDir,
      status: ConnectionStatus.PENDING,
      sock: null,
      reconnectAttempts: 0,
      reconnectTimeout: null,
      manualDisconnect: false,
      connectedAt: null,
      lastDisconnectReason: null,
      lastDisconnectCode: null,
      lastError: null,
      qrRaw: null,
      qrDataUrl: null,
      qrGeneratedAt: null,
      qrExpiresAt: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      // Isolated caches per account
      msgRetryCounterCache: new NodeCache({ stdTTL: 3600, useClones: false }),
      userDevicesCache: new NodeCache({ stdTTL: 300, useClones: false }),
      signalKeyCache: new NodeCache({ stdTTL: 300, useClones: false }),
      messageStore: new NodeCache({ stdTTL: 86400, maxKeys: 5000, useClones: false }),
    };

    this.sessions.set(accountId, session);
    logger.info({ accountId, userId: session.userId }, 'Initialized account session');
    return session;
  }

  /**
   * Start WhatsApp connection for an account.
   * Deduplicates: Guarantees ONLY 1 QR code is generated and remains stable until scanned.
   * @param {string} accountId
   * @param {object} [metadata]
   * @param {object} [options] { forceRestart, forceNewQR, isRestart }
   * @returns {Promise<object>} safe status
   */
  async startConnection(accountId, metadata = {}, options = {}) {
    const session = this.initAccount(accountId, metadata);

    // 1. If already connected with an active socket and no force restart requested
    if (session.status === ConnectionStatus.CONNECTED && session.sock && !options.forceRestart) {
      logger.debug({ accountId }, 'Account is already connected; skipping duplicate start');
      return this.getStatus(accountId);
    }

    // 2. Guarantee ONLY 1 QR code: If already has an active QR and not forcing fresh QR, keep it!
    if (
      session.status === ConnectionStatus.QR_READY &&
      session.sock &&
      session.qrDataUrl &&
      session.qrExpiresAt > Date.now() &&
      !options.forceNewQR &&
      !options.forceRestart
    ) {
      logger.debug({ accountId }, 'Account already has an active pairing QR code; keeping current session');
      return this.getStatus(accountId);
    }

    // 2b. If socket is currently connecting (waiting for QR from WhatsApp), don't start a new one
    if (
      session.status === ConnectionStatus.CONNECTING &&
      session.sock &&
      !options.forceNewQR &&
      !options.forceRestart
    ) {
      logger.debug({ accountId }, 'Account socket is currently connecting; waiting for QR');
      return this.getStatus(accountId);
    }

    // 3. Wipe auth ONLY if user explicitly requested a fresh QR reset
    if (options.forceNewQR) {
      logger.info({ accountId }, 'User requested fresh pairing - wiping auth directory');
      this.cleanupAuth(session);
      session.qrDataUrl = null;
      session.qrRaw = null;
      session.qrExpiresAt = null;
      session.pairingCode = null;
      session.pairingCodeExpiresAt = null;
    }

    // Clean up any existing socket before starting a new connection
    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        session.sock.end(undefined);
      } catch {}
      session.sock = null;
    }

    // Reset manual disconnect flag
    session.manualDisconnect = false;
    session.lastError = null;
    this.setStatus(session, ConnectionStatus.CONNECTING);

    try {
      // Load auth state for this isolated account
      const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

      // Create isolated socket instance with Ubuntu Chrome browser signature
      const sock = makeWASocket({
        version,
        browser: Browsers.ubuntu('Chrome'), // Standard Ubuntu Chrome companion signature
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }), session.signalKeyCache),
        },
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 60000,
        emitOwnEvents: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid) || isJidNewsletter?.(jid),
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: session.msgRetryCounterCache,
        userDevicesCache: session.userDevicesCache,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        getMessage: async (key) => {
          if (!key?.id) return null;
          return session.messageStore.get(key.id) || null;
        },
      });

      session.sock = sock;

      // Listen to credentials update
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          logger.error({ accountId, err: err.message }, 'Failed to save account credentials');
        }
      });

      // Listen to connection lifecycle updates
      sock.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(accountId, update);
      });

      // Listen to incoming messages
      sock.ev.on('messages.upsert', (messageUpdate) => {
        if (messageUpdate?.messages && Array.isArray(messageUpdate.messages)) {
          for (const msg of messageUpdate.messages) {
            if (msg.key?.id && msg.message) {
              session.messageStore.set(msg.key.id, msg.message);
            }
          }
        }

        this.emit('messages.upsert', {
          accountId,
          userId: session.userId,
          phoneNumber: session.phoneNumber,
          messageUpdate,
          sock: session.sock,
        });
      });

      // Listen to message updates (for Anti-Delete revoke detection)
      sock.ev.on('messages.update', (updates) => {
        this.emit('messages.update', {
          accountId,
          userId: session.userId,
          phoneNumber: session.phoneNumber,
          updates,
          sock: session.sock,
        });
      });

      return this.getStatus(accountId);
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Failed to initialize WhatsApp socket');
      session.lastError = err.message;
      this.setStatus(session, ConnectionStatus.ERROR);
      return this.getStatus(accountId);
    }
  }

  /**
   * Internal connection update handler.
   * @private
   */
  async handleConnectionUpdate(accountId, update) {
    const session = this.sessions.get(accountId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    // QR generated
    if (qr) {
      try {
        session.qrRaw = qr;
        session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        session.qrGeneratedAt = Date.now();
        session.qrExpiresAt = Date.now() + this.qrTtlMs;
        this.setStatus(session, ConnectionStatus.QR_READY);

        this.emit('qr', {
          accountId,
          userId: session.userId,
          qrDataUrl: session.qrDataUrl,
          expiresAt: session.qrExpiresAt,
        });
        logger.info({ accountId }, 'Generated fresh pairing QR code for account');
      } catch (err) {
        logger.error({ accountId, err: err.message }, 'Failed to render QR code data URL');
      }
    }

    // Connection opened
    if (connection === 'open') {
      session.reconnectAttempts = 0;
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.qrExpiresAt = null;
      session.connectedAt = new Date().toISOString();
      session.lastDisconnectReason = null;
      session.lastDisconnectCode = null;

      // Extract verified phone number if available
      const jid = session.sock?.user?.id || session.sock?.authState?.creds?.me?.id;
      if (jid) {
        session.phoneNumber = jid.split(':')[0].split('@')[0];
      }

      this.setStatus(session, ConnectionStatus.CONNECTED);

      // Persist connected state and verified phone number to database
      this.syncDbConnected(accountId, session.phoneNumber, session.connectedAt, session.userId);

      this.emit('connected', {
        accountId,
        userId: session.userId,
        phoneNumber: session.phoneNumber,
        connectedAt: session.connectedAt,
      });
      logger.info({ accountId, phoneNumber: session.phoneNumber }, 'WhatsApp connection opened successfully');

      // Send welcome message with logo and usage guide to the owner
      this.sendWelcomeMessage(session).catch((err) => {
        logger.error({ accountId, err: err.message }, 'Failed to send welcome message');
      });
    }

    // Connection closed
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || lastDisconnect?.error?.output?.payload?.message || 'Unknown';
      session.lastDisconnectCode = statusCode;
      session.lastDisconnectReason = reason;

      logger.warn({ accountId, statusCode, reason }, 'WhatsApp connection closed');

      // Clean up dead socket instance immediately so reconnect is not blocked
      if (session.sock) {
        try {
          session.sock.ev.removeAllListeners();
          session.sock.end(undefined);
        } catch {}
        session.sock = null;
      }

      // 1. Session logged out by user on device
      if (statusCode === DisconnectReason.loggedOut) {
        this.cleanupAuth(session);
        this.setStatus(session, ConnectionStatus.NEEDS_REAUTHENTICATION);
        this.syncDbStatus(accountId, 'needs_reauthentication');
        this.emit('loggedOut', { accountId, userId: session.userId });
        return;
      }

      // 2. Corrupted / Bad Session
      if (statusCode === DisconnectReason.badSession) {
        this.cleanupAuth(session);
        this.setStatus(session, ConnectionStatus.NEEDS_REAUTHENTICATION);
        this.syncDbStatus(accountId, 'needs_reauthentication');
        this.emit('badSession', { accountId, userId: session.userId });
        return;
      }

      // 2b. 401 Unauthorized / Connection Failure — stale or invalid credentials
      // WhatsApp rejected our saved auth keys. Wipe them and reconnect fresh.
      if (statusCode === 401) {
        logger.info({ accountId }, 'WhatsApp rejected credentials (401) — wiping auth and reconnecting fresh');
        this.cleanupAuth(session);
        session.reconnectAttempts = 0;
        this.setStatus(session, ConnectionStatus.CONNECTING);
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = setTimeout(() => {
          this.startConnection(accountId, {}, { forceRestart: true }).catch((err) => {
            logger.error({ accountId, err: err.message }, 'Fresh reconnect after 401 failed');
          });
        }, 500);
        return;
      }

      // 3. User requested manual disconnect
      if (session.manualDisconnect) {
        this.setStatus(session, ConnectionStatus.DISCONNECTED);
        this.syncDbStatus(accountId, 'disconnected');
        return;
      }

      // 4. Critical: WhatsApp QR Scan handshake restart (StatusCode 515)
      // WhatsApp intentionally closes socket during QR pairing to swap keys.
      // Must reconnect IMMEDIATELY (no exponential backoff delay) to prevent phone timeout!
      const isRestartRequired = statusCode === DisconnectReason.restartRequired || (typeof reason === 'string' && reason.toLowerCase().includes('restart required'));
      if (isRestartRequired) {
        logger.info({ accountId }, 'WhatsApp handshake restart required (515) - reconnecting immediately');
        this.setStatus(session, ConnectionStatus.CONNECTING);
        session.reconnectAttempts = 0;
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = setTimeout(() => {
          this.startConnection(accountId, {}, { forceRestart: true }).catch((err) => {
            logger.error({ accountId, err: err.message }, 'Immediate restart connection failed');
          });
        }, 300);
        return;
      }

      // 5. Temporary disconnect -> reconnect with exponential backoff
      if (session.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, session.reconnectAttempts), 30000);
        session.reconnectAttempts++;
        logger.info({ accountId, attempt: session.reconnectAttempts, delayMs: delay }, 'Scheduling reconnection');

        this.setStatus(session, ConnectionStatus.CONNECTING);
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = setTimeout(() => {
          this.startConnection(accountId, {}, { forceRestart: true }).catch((err) => {
            logger.error({ accountId, err: err.message }, 'Reconnection attempt failed');
          });
        }, delay);
      } else {
        logger.error({ accountId, attempts: session.reconnectAttempts }, 'Max reconnect attempts reached. Giving up.');
        this.setStatus(session, ConnectionStatus.DISCONNECTED);
        this.syncDbStatus(accountId, 'disconnected');
      }
    }
  }

  /**
   * Helper to sync connected status to Supabase and activate free trial.
   * @private
   */
  async syncDbConnected(accountId, phoneNumber, connectedAt, userId) {
    try {
      const updateData = {
        status: 'connected',
        connected_at: connectedAt,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (phoneNumber) {
        updateData.phone_number = phoneNumber;
      }
      await supabaseAdmin
        .from('whatsapp_accounts')
        .update(updateData)
        .eq('id', accountId);

      if (userId) {
        await entitlementService.activateFreeTrialIfEligible(userId);
      }
    } catch (err) {
      logger.debug({ accountId, err: err.message }, 'Failed to sync connected state to Supabase');
    }
  }

  /**
   * Send a welcome message with the bot logo and a complete usage guide
   * to the owner when their WhatsApp number connects successfully.
   * @private
   */
  async sendWelcomeMessage(session) {
    const { sock, phoneNumber, accountId } = session;
    if (!sock?.sendMessage || !phoneNumber) return;

    // Build the owner's JID to send the welcome message to themselves
    const ownerJid = `${phoneNumber}@s.whatsapp.net`;

    // Small delay to let the connection fully stabilize
    await new Promise((r) => setTimeout(r, 2000));

    // Re-check socket is still alive after the delay
    if (!session.sock?.sendMessage || session.status !== ConnectionStatus.CONNECTED) return;

    // Read the logo image
    let logoBuffer = null;
    try {
      if (fs.existsSync(LOGO_PATH)) {
        logoBuffer = fs.readFileSync(LOGO_PATH);
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'Could not read logo file for welcome message');
    }

    const welcomeText =
`✅ *WhatsApp Bot Connected Successfully!*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 *COMPLETE BOT USAGE GUIDE*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏠 *HOW TO ACCESS THE MAIN MENU*
• Send *0* (zero) in any chat to open the Main Menu
• You can also send *.menu* or *.help*
• The Main Menu is your control center for all features

📋 *HOW TO SELECT FROM THE MAIN MENU*
The Main Menu shows numbered features (1-9).
Simply send the *number* of the feature to open its submenu:
• *1* → Bot On/Off
• *2* → Anti-Delete
• *3* → Anti-ViewOnce
• *4* → Auto Reply
• *5* → File Organizer
• *6* → Settings & Status
• *7* → Help & Commands
• *8* → Profile Picture
• *9* → Sticker Maker

🔢 *HOW TO SELECT A SUBMENU OPTION*
Once inside a submenu, send the *number + letter* shown.
Example: Inside Anti-Delete (menu 2), send *2a* to enable for private chats.
💡 *Shortcut:* If you're already inside a submenu, you can just send the *letter* (e.g. *a* instead of *2a*).
Send *0* at any time to go back to the Main Menu.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚙️ *FEATURE GUIDE — HOW TO USE EACH FEATURE*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔌 *1. Bot On/Off*
Controls the master switch for all automated features.
• Send *1a* → Turn bot ON
• Send *1b* → Turn bot OFF (pauses all automations)
• Send *1c* → Check current bot status

🗑️ *2. Anti-Delete*
Automatically recovers messages that were deleted by the sender ("Delete for Everyone"). Recovers text, images, videos, voice notes, and documents.
• Send *2a* → Enable in Private Chats only
• Send *2b* → Enable in Groups only
• Send *2c* → Enable in Both (Private + Groups)
• Send *2d* → Disable Anti-Delete
• Send *2e* → Check current Anti-Delete status

👁️ *3. Anti-ViewOnce*
Captures view-once photos and videos so they're saved permanently.

_Automatic Mode (always-on):_
When enabled, any view-once media sent to you is automatically intercepted and reposted as a permanent copy in the same chat.
• Send *3a* → Enable in Private Chats only
• Send *3b* → Enable in Groups only
• Send *3c* → Enable in Both (Private + Groups)
• Send *3d* → Disable Anti-ViewOnce
• Send *3e* → Check current status

_On-Demand Reveal (manual .vv command):_
• *Swipe-reply* (quote) any view-once message
• Type *.vv* or *reveal* and send
• The bot will download and repost the media as a normal permanent photo/video

💬 *4. Auto Reply*
Automatically replies to incoming messages based on keyword rules you configure.
• Send *4a* → Configure Offline Auto Reply
• Send *4b* → Configure Keyword & Greeting Replies
• Send *4c* → Enable Auto Reply
• Send *4d* → Disable Auto Reply
• Send *4e* → Manage Reply Rules (add/edit/delete)
• Send *4f* → Check Auto Reply status

📁 *5. File Organizer*
Automatically sorts incoming media files into categorized folders (images, videos, audio, documents, archives).
• Send *5a* → Enable File Organizer
• Send *5b* → Disable File Organizer
• Send *5c* → Check File Organizer status

⚙️ *6. Settings & Status*
View the current status of all features at a glance.
• Send *6* → View full system diagnostics

❓ *7. Help*
View a quick summary of all available commands.
• Send *7* → Display command reference

🖼️ *8. Profile Picture*
Manage your WhatsApp profile picture directly from chat.
• Send *8a* → Set profile picture (reply to an image with *.setdp*)
• Send *8c* → Remove profile picture
• Send *8d* → View current profile picture URL

🎭 *9. Sticker Maker*
Convert images and videos into WhatsApp stickers.
• Send *.s* or *.sticker* with an attached image
• Or *swipe-reply* to any image and send *.s*
• Works with both photos and short video clips

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ *QUICK COMMAND REFERENCE*

• *0* / *.menu* / *.help* → Open Main Menu
• *.vv* / *reveal* → Reveal view-once (reply to it)
• *.s* / *.sticker* → Make sticker (attach/reply image)
• *.setdp* → Set profile picture (reply to image)
• *.setvideodp* → Set animated profile picture (reply to video)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *TIPS:*
• All commands work in any chat (private or group)
• Only you (the account owner) can control the bot
• Send *0* at any time to return to the Main Menu
• Visit your Web Dashboard for advanced configuration

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Enjoy your WhatsApp Bot! 🚀`;

    try {
      if (logoBuffer) {
        // Send logo image with the welcome text as caption
        await session.sock.sendMessage(ownerJid, {
          image: logoBuffer,
          caption: welcomeText,
        });
      } else {
        // Fallback: send text-only welcome if logo is missing
        await session.sock.sendMessage(ownerJid, { text: welcomeText });
      }
      logger.info({ accountId, phoneNumber }, 'Welcome message sent to owner');
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Failed to send welcome message to owner');
    }
  }

  /**
   * Helper to sync status changes to Supabase.
   * @private
   */
  async syncDbStatus(accountId, status) {
    try {
      await supabaseAdmin
        .from('whatsapp_accounts')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', accountId);
    } catch (err) {
      logger.debug({ accountId, status, err: err.message }, 'Failed to sync status to Supabase');
    }
  }

  /**
   * Safely disconnect an account's socket.
   * @param {string} accountId
   * @returns {boolean}
   */
  disconnect(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) return false;

    session.manualDisconnect = true;
    clearTimeout(session.reconnectTimeout);

    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        session.sock.end(undefined);
      } catch (err) {
        logger.debug({ accountId, err: err.message }, 'Socket close notice');
      }
      session.sock = null;
    }

    session.qrRaw = null;
    session.qrDataUrl = null;
    session.qrExpiresAt = null;
    this.setStatus(session, ConnectionStatus.DISCONNECTED);
    this.syncDbStatus(accountId, 'disconnected');
    logger.info({ accountId }, 'Account disconnected intentionally');
    return true;
  }

  /**
   * Log out and wipe authentication data.
   * @param {string} accountId
   * @returns {Promise<boolean>}
   */
  async logout(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) return false;

    session.manualDisconnect = true;
    clearTimeout(session.reconnectTimeout);

    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        await session.sock.logout();
      } catch {
        try {
          session.sock.end(undefined);
        } catch { /* ignore */ }
      }
      session.sock = null;
    }

    this.cleanupAuth(session);
    this.setStatus(session, ConnectionStatus.NEEDS_REAUTHENTICATION);
    this.syncDbStatus(accountId, 'needs_reauthentication');
    logger.info({ accountId }, 'Account logged out and credentials wiped');
    return true;
  }

  /**
   * Remove account completely from memory and wipe auth/downloads if requested.
   * @param {string} accountId
   * @param {boolean} [deleteFiles=true]
   * @returns {boolean}
   */
  removeAccount(accountId, deleteFiles = true) {
    const session = this.sessions.get(accountId);
    if (!session) return false;

    this.disconnect(accountId);

    if (deleteFiles) {
      this.cleanupAuth(session);
      try {
        if (fs.existsSync(session.downloadDir)) {
          fs.rmSync(session.downloadDir, { recursive: true, force: true });
        }
      } catch (err) {
        logger.error({ accountId, err: err.message }, 'Failed to remove download folder');
      }
    }

    this.sessions.delete(accountId);
    logger.info({ accountId }, 'Removed account session from ConnectionManager');
    return true;
  }

  /**
   * Clean up auth folder for an account.
   * @private
   */
  cleanupAuth(session) {
    try {
      if (fs.existsSync(session.authDir)) {
        fs.rmSync(session.authDir, { recursive: true, force: true });
        fs.mkdirSync(session.authDir, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      logger.error({ accountId: session.accountId, err: err.message }, 'Error wiping auth directory');
    }
  }

  /**
   * Set status and emit status change event.
   * @private
   */
  setStatus(session, newStatus) {
    const oldStatus = session.status;
    session.status = newStatus;
    if (oldStatus !== newStatus) {
      this.emit('status', {
        accountId: session.accountId,
        userId: session.userId,
        status: newStatus,
        previousStatus: oldStatus,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get safe status for public API / dashboard (no credentials leaked).
   * @param {string} accountId
   * @returns {object|null}
   */
  getStatus(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) return null;

    const hasValidQR = Boolean(
      session.status === ConnectionStatus.QR_READY &&
      session.qrDataUrl &&
      session.qrExpiresAt &&
      session.qrExpiresAt > Date.now()
    );

    const hasValidPairingCode = Boolean(
      session.pairingCode &&
      session.pairingCodeExpiresAt &&
      session.pairingCodeExpiresAt > Date.now()
    );

    return {
      accountId: session.accountId,
      userId: session.userId,
      phoneNumber: session.phoneNumber,
      label: session.label,
      status: session.status,
      connectedAt: session.connectedAt,
      reconnectAttempts: session.reconnectAttempts,
      hasQR: hasValidQR,
      pairingCode: hasValidPairingCode ? session.pairingCode : null,
      pairingCodeExpiresAt: hasValidPairingCode ? session.pairingCodeExpiresAt : null,
      lastError: session.lastError,
      lastDisconnectReason: session.lastDisconnectReason,
    };
  }

  /**
   * Request an 8-character pairing code to link a phone number without QR code.
   * @param {string} accountId
   * @param {string} phoneNumber
   * @returns {Promise<{ pairingCode: string, phoneNumber: string, expiresAt: number }>}
   */
  async requestPairingCode(accountId, phoneNumber) {
    const session = this.sessions.get(accountId) || this.initAccount(accountId);
    const targetPhone = phoneNumber || session.phoneNumber;
    if (!targetPhone) {
      throw new Error('Please enter a phone number with country code (e.g. 254746278212).');
    }

    const cleanNumber = targetPhone.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 8) {
      throw new Error('Invalid phone number length. Include your country code without + (e.g. 254746278212).');
    }
    session.phoneNumber = cleanNumber;

    // For pairing code flow, we need a fresh socket connection without existing creds
    // because pairing code registration requires clean state
    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        session.sock.end(undefined);
      } catch {}
      session.sock = null;
    }
    this.cleanupAuth(session);

    // Reset state before fresh connection
    session.qrRaw = null;
    session.qrDataUrl = null;
    session.qrExpiresAt = null;
    session.pairingCode = null;
    session.pairingCodeExpiresAt = null;
    session.lastError = null;

    // Start a fresh connection
    await this.startConnection(accountId, { phoneNumber: cleanNumber }, { forceRestart: true });

    // Wait up to 15 seconds for the socket WebSocket connection to be established.
    // The socket needs to complete the WS handshake with WhatsApp servers before
    // requestPairingCode can be called. We give extra time since the second account
    // connection can take longer to establish.
    let attempts = 0;
    const maxAttempts = 75; // 75 * 200ms = 15 seconds
    while (attempts < maxAttempts) {
      // If socket died during connection, break early
      if (session.status === ConnectionStatus.ERROR || session.status === ConnectionStatus.DISCONNECTED) {
        break;
      }
      if (session.sock && typeof session.sock.requestPairingCode === 'function') {
        // Check if the socket's WebSocket is actually open
        try {
          if (session.sock.ws?.readyState === 1) break; // WebSocket.OPEN
        } catch {}
        // Also break if QR was generated (means socket is connected to WA servers)
        if (session.qrRaw) break;
      }
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    if (!session.sock || typeof session.sock.requestPairingCode !== 'function') {
      throw new Error('WhatsApp connection could not be established. Please ensure your internet is stable and try again.');
    }

    // Additional brief wait for WS to be fully ready if it isn't yet
    if (!session.sock.ws || session.sock.ws.readyState !== 1) {
      let wsAttempts = 0;
      while (wsAttempts < 25) { // 5 more seconds
        try {
          if (session.sock?.ws?.readyState === 1) break;
        } catch {}
        if (session.qrRaw) break;
        await new Promise((r) => setTimeout(r, 200));
        wsAttempts++;
      }
    }

    // Retry the pairing code request up to 3 times with brief delays
    let lastError = null;
    for (let retry = 0; retry < 3; retry++) {
      try {
        // Re-verify socket is still alive before each attempt
        if (!session.sock || typeof session.sock.requestPairingCode !== 'function') {
          throw new Error('Socket was lost during pairing attempt');
        }

        const code = await session.sock.requestPairingCode(cleanNumber);
        // Format code as XXXX-XXXX if 8 chars
        const formattedCode = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        session.pairingCode = formattedCode;
        session.pairingCodeExpiresAt = Date.now() + 180000; // 3 minutes validity

        logger.info({ accountId, cleanNumber, pairingCode: formattedCode }, 'Generated WhatsApp phone pairing code');

        this.emit('pairingCode', {
          accountId,
          userId: session.userId,
          pairingCode: formattedCode,
          phoneNumber: cleanNumber,
          expiresAt: session.pairingCodeExpiresAt,
        });

        return {
          pairingCode: formattedCode,
          phoneNumber: cleanNumber,
          expiresAt: session.pairingCodeExpiresAt,
        };
      } catch (err) {
        lastError = err;
        const msg = err.message || String(err);
        logger.warn({ accountId, cleanNumber, retry, err: msg }, 'Pairing code attempt failed, retrying...');

        // If connection was closed, we need to re-establish it
        if (msg.includes('Connection Closed') || msg.includes('timed out') || msg.includes('socket')) {
          if (retry < 2) {
            // Wait and let the auto-reconnect handler restart the socket
            await new Promise((r) => setTimeout(r, 3000));

            // If socket was re-established by auto-reconnect, continue the retry
            if (session.sock && typeof session.sock.requestPairingCode === 'function') {
              continue;
            }

            // Otherwise start a fresh connection manually
            try {
              await this.startConnection(accountId, { phoneNumber: cleanNumber }, { forceRestart: true });
              // Wait for the new socket to be ready
              let readyWait = 0;
              while (readyWait < 40) {
                if (session.sock?.ws?.readyState === 1 || session.qrRaw) break;
                await new Promise((r) => setTimeout(r, 200));
                readyWait++;
              }
            } catch {}
            continue;
          }
        } else {
          // Non-transient error — don't retry
          break;
        }
      }
    }

    // All retries exhausted
    const finalMsg = lastError?.message || 'Unknown error';
    logger.error({ accountId, cleanNumber, err: finalMsg }, 'Failed to request pairing code after retries');
    if (finalMsg.includes('Connection Closed') || finalMsg.includes('timed out')) {
      throw new Error('Could not generate pairing code: WhatsApp connection keeps dropping. This can happen if another device is actively using this number. Please disconnect WhatsApp Web on other devices and try again.');
    }
    throw lastError || new Error('Failed to generate pairing code. Please try again.');
  }

  /**
   * Get QR code for authenticated user.
   * @param {string} accountId
   * @returns {object|null} { qrDataUrl, expiresAt, status }
   */
  getQR(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) return null;

    if (session.status !== ConnectionStatus.QR_READY) {
      return {
        qrDataUrl: null,
        expiresAt: null,
        status: session.status,
        expired: false,
      };
    }

    const isExpired = !session.qrExpiresAt || session.qrExpiresAt <= Date.now();
    return {
      qrDataUrl: isExpired ? null : session.qrDataUrl,
      expiresAt: session.qrExpiresAt,
      status: session.status,
      expired: isExpired,
    };
  }

  /**
   * Graceful shutdown of all sessions on server termination.
   */
  async shutdownAll() {
    logger.info('Shutting down all active WhatsApp sessions...');
    const promises = [];
    for (const [accountId] of this.sessions.entries()) {
      promises.push(Promise.resolve(this.disconnect(accountId)));
    }
    await Promise.all(promises);
    logger.info('All WhatsApp sessions stopped');
  }

  /**
   * Automatically restore sessions that have saved credentials on server startup.
   * Enables persistent 24/7 server operation across server restarts.
   */
  async autoRestoreSessions() {
    try {
      logger.info('Checking for existing WhatsApp sessions to auto-restore...');
      const toRestore = [];

      // Check local auth directory for any folders with creds.json
      if (fs.existsSync(this.baseAuthDir)) {
        const entries = fs.readdirSync(this.baseAuthDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && isValidAccountId(entry.name)) {
            const credsPath = path.join(this.baseAuthDir, entry.name, 'creds.json');
            if (fs.existsSync(credsPath)) {
              toRestore.push(entry.name);
            }
          }
        }
      }

      logger.info({ count: toRestore.length, accounts: toRestore }, 'Found saved WhatsApp sessions to restore');

      for (const accountId of toRestore) {
        logger.info({ accountId }, 'Auto-restoring WhatsApp connection for account');
        this.startConnection(accountId).catch((err) => {
          logger.error({ accountId, err: err.message }, 'Failed to auto-restore WhatsApp connection');
        });
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Error in autoRestoreSessions');
    }
  }
}

// Export singleton instance as default, class as named export
export const connectionManager = new ConnectionManager();
export default connectionManager;
