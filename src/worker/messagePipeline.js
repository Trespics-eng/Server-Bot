import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import entitlementService from '../services/entitlementService.js';
import { supabaseAdmin } from '../db/supabase.js';
import { buildSandboxedPath, sanitizeFilename } from '../utils/pathSafety.js';
import mediaService from '../services/mediaService.js';
import { extractNumberFromJid, isOwnerJid, normalizeCommand, isGroupJid } from '../utils/validation.js';
import commandHandler from './commandHandler.js';
import antiDelete from '../features/antiDelete.js';
import antiViewOnce from '../features/antiViewOnce.js';
import fileOrganizer from '../features/fileOrganizer.js';
import stickerReply from '../features/stickerReply.js';
import profilePicture from '../features/profilePicture.js';
import botController from '../features/botController.js';

/**
 * Universal Multi-Tenant Message Processing Pipeline.
 * 
 * Houses 100% of all bot features from standalone mode:
 * 1. Anti-Delete (Real Media Recovery: Images, Videos, Voice Notes, Documents)
 * 2. Anti-ViewOnce (Permanent capture of ephemeral media)
 * 3. Smart Auto-Reply (Exact, Contains, Regex, Starts-With from Supabase)
 * 4. Sticker Maker (.sticker, .s, animated stickers)
 * 5. Video Profile Picture (.setdp, .setvideodp)
 * 6. Interactive WhatsApp Numbered Management Menu (0, 1, 2, 3...)
 * 7. Automatic File Organizer (Categorized sandboxes per account)
 */
export class MessagePipeline {
  constructor(options = {}) {
    this.baseDownloadDir = path.resolve(options.baseDownloadDir || process.env.DOWNLOAD_DIR || './downloads');
    this.processedMessages = new Set();
    this.maxDedupe = 3000;

    /** @type {Map<string, object>} messageId -> cached message details and media buffers */
    this.messageCache = new Map();
    this.maxCache = 5000;
  }

  /**
   * Process incoming Baileys messages.upsert event for a specific account.
   */
  async handleIncomingMessages({ accountId, userId, phoneNumber, messageUpdate, sock }) {
    if (!messageUpdate || !Array.isArray(messageUpdate.messages)) return;

    for (const msg of messageUpdate.messages) {
      try {
        await this.processSingleMessage({ accountId, userId, phoneNumber, message: msg, sock });
      } catch (err) {
        logger.error({ accountId, messageId: msg?.key?.id, err: err.message }, 'Error in account message pipeline');
      }
    }
  }

  /**
   * Process message update events (Anti-Delete revoke detection).
   */
  async handleMessageUpdates({ accountId, userId, phoneNumber, updates, sock }) {
    if (!updates || !Array.isArray(updates)) return;

    for (const item of updates) {
      try {
        // messageStubType 1 = REVOKE (delete for everyone in WhatsApp)
        if (item.update?.messageStubType === 1 || item.update?.message === null) {
          const messageId = item.key?.id;
          const chatJid = item.key?.remoteJid;
          const senderJid = item.key?.participant || chatJid;

          if (messageId && chatJid) {
            await this.handleDeletedMessage({ accountId, messageId, chatJid, senderJid, sock });
          }
        }
      } catch (err) {
        logger.error({ accountId, err: err.message }, 'Error handling message update in pipeline');
      }
    }
  }

  /**
   * Process a single incoming message.
   * @private
   */
  async processSingleMessage({ accountId, userId, phoneNumber, message, sock }) {
    if (!message || !message.key || !message.message) return;

    const msgId = message.key.id;
    if (!msgId || this.processedMessages.has(msgId)) return;
    this.processedMessages.add(msgId);

    // Prune deduplication cache
    if (this.processedMessages.size > this.maxDedupe) {
      const firstEntry = this.processedMessages.values().next().value;
      if (firstEntry) this.processedMessages.delete(firstEntry);
    }

    const chatJid = message.key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return;

    // Cache message and pre-download media for instant anti-delete recovery
    await this.cacheMessageForAntiDelete(accountId, message, chatJid);

    // Skip replaying automated replies/commands for old backlog messages on initial link
    const msgTimestamp = message.messageTimestamp ? Number(message.messageTimestamp) * 1000 : null;
    const isOldMessage = msgTimestamp && (Date.now() - msgTimestamp > 180000);
    if (isOldMessage) {
      return;
    }

    // Entitlement Verification (retrieved instantly from memory cache)
    const entitlements = await entitlementService.getAccountEntitlementsOverview(accountId);

    // Extract text and sender details
    const text = this.extractText(message).trim();
    const isFromMe = Boolean(message.key.fromMe);
    const senderJid = message.key.participant || chatJid;
    const isOwner = isFromMe || isOwnerJid(senderJid, sock, phoneNumber);

    // ── 0. Feature: On-Demand ViewOnce Reveal (.vv / reveal) ──
    // Must be checked BEFORE menu commands, because .vv is a dot-command reply
    if (isOwner && this.isViewOnceRevealCommand(text)) {
      const handled = await this.handleViewOnceReveal({ accountId, phoneNumber, message, chatJid, senderJid, sock });
      if (handled) return;
    }

    // ── 1. Interactive Owner Menu ('0', '1', '2', etc.) ──
    if (isOwner && this.isPotentialMenuCommand(text)) {
      const handled = await commandHandler.handleCommand({
        accountId,
        phoneNumber,
        rawCommand: text,
        chatJid,
        sock,
      });
      if (handled) return;
    }

    // Master Bot ON/OFF check for automation features
    if (!botController.isEnabled(accountId)) {
      return;
    }

    // ── 2. Feature: Sticker Maker (.s / .sticker) ──
    if (this.isStickerCommand(text)) {
      const handled = await this.handleStickerCommand({ message, chatJid, sock });
      if (handled) return;
    }

    // ── 3. Feature: Profile Picture (.setdp / .setvideodp) ──
    if (isOwner && this.isProfilePictureCommand(text)) {
      const handled = await this.handleProfilePictureCommand({ text, message, chatJid, sock });
      if (handled) return;
    }

    // ── 5. Feature: Anti-ViewOnce (Automatic: Extract permanent photo/video) ──
    if (entitlements.anti_view_once?.entitled && antiViewOnce.isEnabledFor(accountId, chatJid) && this.isViewOnce(message)) {
      await this.handleAntiViewOnce({ accountId, phoneNumber, message, chatJid, senderJid, sock });
    }

    // ── 6. Feature: Smart Auto-Reply ──
    if (entitlements.auto_reply?.entitled && !isFromMe) {
      await this.handleAutoReply(accountId, text, chatJid, sock);
    }

    // ── 7. Feature: File Organizer ──
    if (entitlements.file_organizer?.entitled && fileOrganizer.isEnabled(accountId) && this.hasMedia(message)) {
      await this.handleFileOrganizer(accountId, message);
    }
  }

  /**
   * Cache message details and download media in advance so deleted media is recovered 100%.
   * @private
   */
  async cacheMessageForAntiDelete(accountId, message, chatJid) {
    try {
      const msgId = message.key.id;
      if (!msgId) return;

      const text = this.extractText(message);
      const caption = this.extractCaption(message);
      const mediaInfo = mediaService.getMediaInfo(message);
      const senderJid = message.key.participant || chatJid;

      let mediaBuffer = null;
      if (mediaInfo) {
        // Asynchronously download and hold media buffer in memory
        mediaService.downloadMedia(message).then((buf) => {
          if (buf && this.messageCache.has(msgId)) {
            const entry = this.messageCache.get(msgId);
            entry.mediaBuffer = buf;
          }
        }).catch(() => {});
      }

      this.messageCache.set(msgId, {
        id: msgId,
        accountId,
        chatJid,
        senderJid,
        text,
        caption,
        type: mediaInfo?.type || (text ? 'text' : 'unknown'),
        extension: mediaInfo?.extension || '',
        mediaInfo,
        mediaBuffer,
        timestamp: Date.now(),
        rawMessage: message,
      });

      if (this.messageCache.size > this.maxCache) {
        const oldest = this.messageCache.keys().next().value;
        if (oldest) this.messageCache.delete(oldest);
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'Failed to cache message for anti-delete');
    }
  }

  /**
   * Handle deleted message recovery (Reposts REAL IMAGES, VIDEOS, AUDIO & TEXT).
   * @private
   */
  async handleDeletedMessage({ accountId, messageId, chatJid, senderJid, sock }) {
    const cached = this.messageCache.get(messageId);
    if (!cached) {
      logger.debug({ accountId, messageId }, 'Deleted message not found in cache');
      return;
    }

    // Check if Anti-Delete is enabled for this chat
    if (!antiDelete.isEnabledFor(accountId, chatJid)) return;

    try {
      const senderNum = extractNumberFromJid(cached.senderJid || senderJid);
      const senderTag = senderNum ? `@${senderNum}` : 'Someone';
      const mentions = senderNum ? [`${senderNum}@s.whatsapp.net`] : [];

      // ── 1. If the deleted message had media, re-post the ACTUAL media file! ──
      let buffer = cached.mediaBuffer;
      if (!buffer && cached.rawMessage && cached.type !== 'text') {
        buffer = await mediaService.downloadMedia(cached.rawMessage);
      }

      if (buffer) {
        const mediaCaption = `🗑️ *[Anti-Delete Recovered]*\n` +
          `👤 Deleted ${cached.type} from ${senderTag}` +
          (cached.caption ? `\n\n📝 Caption: "${cached.caption}"` : '');

        if (cached.type === 'image') {
          await mediaService.sendImage(sock, chatJid, buffer, mediaCaption, { mentions });
        } else if (cached.type === 'video') {
          await mediaService.sendVideo(sock, chatJid, buffer, mediaCaption, { mentions });
        } else if (cached.type === 'audio') {
          await mediaService.sendAudio(sock, chatJid, buffer, false);
          await mediaService.sendText(sock, chatJid, `🗑️ *[Anti-Delete]* Recovered voice note from ${senderTag}`, { mentions });
        } else {
          await mediaService.sendDocument(sock, chatJid, buffer, `recovered_${messageId}${cached.extension || '.bin'}`, undefined, { caption: mediaCaption, mentions });
        }

        logger.info({ accountId, messageId, type: cached.type }, 'Recovered deleted media reposted into chat');
        return;
      }

      // ── 2. If it was text, re-post the message text ──
      const deletedContent = cached.text || cached.caption || '(Media content was purged)';
      const alertText = `🗑️ *[Anti-Delete Recovered]*\n\n` +
        `👤 *Sender:* ${senderTag}\n` +
        `📝 *Deleted Message:*\n"${deletedContent}"`;

      await mediaService.sendText(sock, chatJid, alertText, { mentions });
      logger.info({ accountId, messageId }, 'Recovered deleted text reposted into chat');
    } catch (err) {
      logger.error({ accountId, messageId, err: err.message }, 'Failed to repost recovered deleted message');
    }
  }

  /**
   * Handle Anti-ViewOnce (Downloads and forwards the real photo/video).
   * @private
   */
  async handleAntiViewOnce({ accountId, phoneNumber, message, chatJid, senderJid, sock }) {
    try {
      const innerContent = antiViewOnce.extractViewOnceContent(message);
      if (!innerContent) return;

      const wrappedMessage = { ...message, message: innerContent };
      const mediaInfo = mediaService.getMediaInfo(wrappedMessage);
      const buffer = await mediaService.downloadMedia(wrappedMessage);

      if (!buffer) return;

      const senderNum = extractNumberFromJid(senderJid);
      const senderTag = senderNum ? `@${senderNum}` : 'Someone';
      const originalCaption = this.extractCaption(wrappedMessage) || '';
      const caption = `👁️ *[Anti-ViewOnce Permanent Copy]*\n\n` +
        `👤 From: ${senderTag}\n` +
        `💬 Chat: ${isGroupJid(chatJid) ? 'Group' : 'Private'}` +
        (originalCaption ? `\n\n📝 Caption: "${originalCaption}"` : '');

      const mentions = senderNum ? [`${senderNum}@s.whatsapp.net`] : [];

      if (mediaInfo?.type === 'video') {
        await mediaService.sendVideo(sock, chatJid, buffer, caption, { mentions });
      } else {
        await mediaService.sendImage(sock, chatJid, buffer, caption, { mentions });
      }

      logger.info({ accountId, chatJid, type: mediaInfo?.type }, 'Anti-ViewOnce media saved and reposted');
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Error in handleAntiViewOnce');
    }
  }

  /**
   * Handle On-Demand ViewOnce Reveal (.vv / reveal command).
   * When the owner replies (quotes) a view-once message with .vv or reveal,
   * this downloads and reposts the media as a permanent copy.
   * @private
   */
  async handleViewOnceReveal({ accountId, phoneNumber, message, chatJid, senderJid, sock }) {
    try {
      // The .vv command must be a reply (quote) to another message
      const contextInfo = message.message?.extendedTextMessage?.contextInfo
        || message.message?.conversation?.contextInfo;

      if (!contextInfo?.quotedMessage) {
        await mediaService.sendText(sock, chatJid,
          '⚠️ *To reveal a view-once message:*\n\n' +
          '1. Swipe-reply (quote) the view-once message\n' +
          '2. Type *.vv* or *reveal* and send\n\n' +
          'The bot will download and repost the media permanently.');
        return true;
      }

      const quotedMsg = contextInfo.quotedMessage;

      // Check if the quoted message is a view-once message
      const viewOnceContent = quotedMsg.viewOnceMessage?.message
        || quotedMsg.viewOnceMessageV2?.message
        || quotedMsg.viewOnceMessageV2Extension?.message
        || null;

      // Also check if the quoted message itself contains direct media
      // (sometimes WhatsApp strips the viewOnce wrapper in the quote)
      const hasDirectMedia = quotedMsg.imageMessage || quotedMsg.videoMessage;

      const innerContent = viewOnceContent || (hasDirectMedia ? quotedMsg : null);

      if (!innerContent) {
        // Check the message cache — the original view-once message might be cached
        const quotedId = contextInfo.stanzaId;
        const cached = quotedId ? this.messageCache.get(quotedId) : null;

        if (cached?.rawMessage) {
          const cachedViewOnce = antiViewOnce.extractViewOnceContent(cached.rawMessage);
          if (cachedViewOnce) {
            return await this._revealViewOnceFromContent(cachedViewOnce, cached.rawMessage, accountId, chatJid, senderJid, sock);
          }

          // Try downloading cached raw message directly if it had media
          if (cached.mediaBuffer || cached.mediaInfo) {
            const buffer = cached.mediaBuffer || await mediaService.downloadMedia(cached.rawMessage);
            if (buffer) {
              const senderNum = extractNumberFromJid(cached.senderJid || senderJid);
              const senderTag = senderNum ? `@${senderNum}` : 'Someone';
              const mentions = senderNum ? [`${senderNum}@s.whatsapp.net`] : [];
              const caption = `👁️ *[View-Once Revealed]*\n\n👤 From: ${senderTag}`;

              if (cached.type === 'video') {
                await mediaService.sendVideo(sock, chatJid, buffer, caption, { mentions });
              } else {
                await mediaService.sendImage(sock, chatJid, buffer, caption, { mentions });
              }
              logger.info({ accountId, chatJid }, 'View-once media revealed from cache via .vv command');
              return true;
            }
          }
        }

        await mediaService.sendText(sock, chatJid,
          '❌ *Could not reveal this message.*\n\n' +
          'This may happen if:\n' +
          '• The quoted message is not a view-once message\n' +
          '• The view-once media has already expired from WhatsApp servers\n' +
          '• The message was sent before the bot was connected\n\n' +
          '_Tip: Try to reveal view-once messages as soon as you receive them!_');
        return true;
      }

      return await this._revealViewOnceFromContent(innerContent, message, accountId, chatJid, senderJid, sock);
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Error in handleViewOnceReveal');
      await mediaService.sendText(sock, chatJid, '❌ Failed to reveal view-once message. The media may have expired.');
      return true;
    }
  }

  /**
   * Helper: Download and repost view-once content as permanent media.
   * @private
   */
  async _revealViewOnceFromContent(innerContent, originalMessage, accountId, chatJid, senderJid, sock) {
    const wrappedMessage = { ...originalMessage, message: innerContent };
    const mediaInfo = mediaService.getMediaInfo(wrappedMessage);
    const buffer = await mediaService.downloadMedia(wrappedMessage);

    if (!buffer) {
      await mediaService.sendText(sock, chatJid,
        '❌ *Could not download view-once media.* The content may have expired on WhatsApp servers.');
      return true;
    }

    const senderNum = extractNumberFromJid(senderJid);
    const senderTag = senderNum ? `@${senderNum}` : 'Someone';
    const originalCaption = this.extractCaption(wrappedMessage) || '';
    const caption = `👁️ *[View-Once Revealed via .vv]*\n\n` +
      `👤 From: ${senderTag}\n` +
      `💬 Chat: ${isGroupJid(chatJid) ? 'Group' : 'Private'}` +
      (originalCaption ? `\n\n📝 Caption: "${originalCaption}"` : '');

    const mentions = senderNum ? [`${senderNum}@s.whatsapp.net`] : [];

    if (mediaInfo?.type === 'video') {
      await mediaService.sendVideo(sock, chatJid, buffer, caption, { mentions });
    } else {
      await mediaService.sendImage(sock, chatJid, buffer, caption, { mentions });
    }

    logger.info({ accountId, chatJid, type: mediaInfo?.type }, 'View-once media revealed via .vv command');
    return true;
  }

  /**
   * Handle Sticker Creation (.sticker, .s).
   * @private
   */
  async handleStickerCommand({ message, chatJid, sock }) {
    try {
      let targetMessage = message;

      // Check if replying to a message
      const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quoted) {
        targetMessage = {
          key: { id: 'quoted' },
          message: quoted,
        };
      }

      const mediaInfo = mediaService.getMediaInfo(targetMessage);
      if (!mediaInfo) return false;

      const buffer = await mediaService.downloadMedia(targetMessage);
      if (!buffer) return false;

      await mediaService.sendText(sock, chatJid, '⏳ Creating your sticker...');

      let stickerBuffer = null;
      if (mediaInfo.type === 'video') {
        stickerBuffer = await stickerReply.convertVideoToSticker(buffer);
      } else {
        stickerBuffer = await stickerReply.convertImageToSticker(buffer);
      }

      if (stickerBuffer) {
        await mediaService.sendSticker(sock, chatJid, stickerBuffer);
        return true;
      } else {
        await mediaService.sendText(sock, chatJid, '❌ Failed to generate sticker. Make sure the file is a valid image or video clip.');
        return true;
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Error in handleStickerCommand');
      return false;
    }
  }

  /**
   * Handle Profile Picture setting (.setdp, .setvideodp).
   * @private
   */
  async handleProfilePictureCommand({ text, message, chatJid, sock }) {
    try {
      const isVideo = text.toLowerCase().includes('.setvideodp') || text === '8c';
      let targetMessage = message;

      const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quoted) {
        targetMessage = { key: { id: 'quoted' }, message: quoted };
      }

      const buffer = await mediaService.downloadMedia(targetMessage);
      if (!buffer) {
        await mediaService.sendText(sock, chatJid, '⚠️ Please attach or reply to an image/video with *.setdp* or *.setvideodp*.');
        return true;
      }

      await mediaService.sendText(sock, chatJid, '⏳ Updating your WhatsApp profile picture...');

      let result = '';
      if (isVideo) {
        result = await profilePicture.setFromVideo(sock, buffer);
      } else {
        result = await profilePicture.setFromImage(sock, buffer);
      }

      await mediaService.sendText(sock, chatJid, result);
      return true;
    } catch (err) {
      logger.error({ err: err.message }, 'Error in handleProfilePictureCommand');
      return false;
    }
  }

  /**
   * Evaluate auto-reply keyword rules.
   * @private
   */
  async handleAutoReply(accountId, text, chatJid, sock) {
    if (!text) return;

    try {
      const { data: rules } = await supabaseAdmin
        .from('keyword_rules')
        .select('*')
        .eq('whatsapp_account_id', accountId)
        .eq('enabled', true);

      if (!rules || rules.length === 0) return;

      for (const rule of rules) {
        let match = false;
        const matchType = rule.match_type || 'contains';
        const target = rule.case_sensitive ? text : text.toLowerCase();
        const kw = rule.case_sensitive ? rule.keyword : rule.keyword.toLowerCase();

        switch (matchType) {
          case 'exact':
            match = target === kw;
            break;
          case 'starts_with':
            match = target.startsWith(kw);
            break;
          case 'regex':
            try {
              const regex = new RegExp(rule.keyword, rule.case_sensitive ? '' : 'i');
              match = regex.test(text);
            } catch {
              match = target.includes(kw);
            }
            break;
          case 'contains':
          default:
            match = target.includes(kw);
            break;
        }

        if (match) {
          await mediaService.sendText(sock, chatJid, rule.reply_text);
          logger.info({ accountId, chatJid, keyword: rule.keyword }, 'Triggered auto-reply rule');
          break;
        }
      }
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Failed to evaluate auto-reply');
    }
  }

  /**
   * Organize media files into account sandbox.
   * @private
   */
  async handleFileOrganizer(accountId, message) {
    try {
      const mediaInfo = mediaService.getMediaInfo(message);
      if (!mediaInfo) return;

      const category = mediaService.categorizeFile(mediaInfo);
      const safeDir = path.join(this.baseDownloadDir, accountId, category);
      const filename = sanitizeFilename(mediaInfo.filename);
      const safePath = path.join(safeDir, filename);

      const buffer = await mediaService.downloadMedia(message);
      if (buffer) {
        await mediaService.saveToFile(buffer, safePath);
        logger.debug({ accountId, safePath }, 'Organized and saved media attachment');
      }
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Error in handleFileOrganizer');
    }
  }

  // ── Helper inspection methods ──

  isPotentialMenuCommand(text) {
    if (!text) return false;
    const lower = text.trim().toLowerCase();
    return (
      lower === '0' || lower === 'menu' || lower === '.menu' || lower === '.help' ||
      /^[0-9]([a-g][0-9]?)?$/.test(lower)
    );
  }

  isStickerCommand(text) {
    if (!text) return false;
    const lower = text.trim().toLowerCase();
    return lower === '.s' || lower === '.sticker' || lower.startsWith('.s ') || lower.startsWith('.sticker ');
  }

  isProfilePictureCommand(text) {
    if (!text) return false;
    const lower = text.trim().toLowerCase();
    return (
      lower.startsWith('.setdp') ||
      lower.startsWith('.setvideodp') ||
      lower === '8b' ||
      lower === '8c'
    );
  }

  isViewOnce(message) {
    if (!message || !message.message) return false;
    return !!(
      message.message.viewOnceMessage ||
      message.message.viewOnceMessageV2 ||
      message.message.viewOnceMessageV2Extension
    );
  }

  isViewOnceRevealCommand(text) {
    if (!text) return false;
    const lower = text.trim().toLowerCase();
    return lower === '.vv' || lower === 'reveal' || lower === '.reveal';
  }

  hasMedia(message) {
    if (!message || !message.message) return false;
    let msg = message.message;
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    return !!(msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage || msg.stickerMessage);
  }

  extractText(message) {
    if (!message || !message.message) return '';
    let msg = message.message;

    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;

    if (typeof msg.conversation === 'string') return msg.conversation;
    if (typeof msg.extendedTextMessage?.text === 'string') return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;

    return '';
  }

  extractCaption(message) {
    if (!message || !message.message) return '';
    let msg = message.message;
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    return msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || '';
  }
}

export const messagePipeline = new MessagePipeline();
export default messagePipeline;
