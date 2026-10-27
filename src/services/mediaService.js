import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import dns from 'dns';
import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import logger from '../utils/logger.js';
import { sanitizeFilename } from '../utils/pathSafety.js';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  timeout: 30000,
});

const httpAgent = new http.Agent({
  family: 4,
  keepAlive: true,
  timeout: 30000,
});

axios.defaults.httpsAgent = httpsAgent;
axios.defaults.httpAgent = httpAgent;

/**
 * Universal Media & Messaging Service for Multi-Tenant WhatsApp Sessions.
 */
const mediaService = {
  /**
   * Download decrypted media from a WhatsApp message.
   * @param {object} message - Baileys message object
   * @returns {Promise<Buffer|null>}
   */
  async downloadMedia(message) {
    try {
      if (!message || !message.message) return null;
      const buffer = await downloadMediaMessage(
        message,
        'buffer',
        {
          options: {
            httpsAgent,
            httpAgent,
            timeout: 30000,
          },
        },
      );
      return buffer;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to download WhatsApp media');
      return null;
    }
  },

  /**
   * Extract media metadata from a message.
   * @param {object} message
   * @returns {{ type: string, mimetype: string, filename: string, extension: string, caption: string, fileLength: number }|null}
   */
  getMediaInfo(message) {
    if (!message || !message.message) return null;
    let msg = message.message;

    // Unwrap ephemeral / viewOnce
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    if (msg.documentWithCaptionMessage?.message?.documentMessage) {
      msg = msg.documentWithCaptionMessage.message;
    }

    const mediaTypes = [
      { key: 'imageMessage', type: 'image', defaultExt: '.jpg' },
      { key: 'videoMessage', type: 'video', defaultExt: '.mp4' },
      { key: 'audioMessage', type: 'audio', defaultExt: '.mp3' },
      { key: 'documentMessage', type: 'document', defaultExt: '' },
      { key: 'stickerMessage', type: 'sticker', defaultExt: '.webp' },
    ];

    for (const { key, type, defaultExt } of mediaTypes) {
      const mediaMsg = msg[key];
      if (mediaMsg) {
        const mimetype = mediaMsg.mimetype || '';
        const filename = mediaMsg.fileName || '';
        let extension = defaultExt;

        if (filename) {
          const ext = path.extname(filename);
          if (ext) extension = ext;
        } else if (mimetype) {
          const parts = mimetype.split('/');
          if (parts.length === 2) {
            const sub = parts[1].split(';')[0];
            extension = `.${sub}`;
          }
        }

        return {
          type,
          mimetype,
          filename: filename || `${type}_${Date.now()}${extension}`,
          extension,
          caption: mediaMsg.caption || '',
          fileLength: mediaMsg.fileLength || 0,
        };
      }
    }

    return null;
  },

  /**
   * Categorize a file by type and extension.
   * @param {object} mediaInfo
   * @returns {string}
   */
  categorizeFile(mediaInfo) {
    if (!mediaInfo) return 'other';
    const ext = (mediaInfo.extension || '').toLowerCase();
    const mime = (mediaInfo.mimetype || '').toLowerCase();

    const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'];
    const docExts = ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.csv', '.xls', '.xlsx', '.ppt', '.pptx'];

    if (mediaInfo.type === 'image' || mime.startsWith('image/')) return 'images';
    if (mediaInfo.type === 'video' || mime.startsWith('video/')) return 'videos';
    if (mediaInfo.type === 'audio' || mime.startsWith('audio/')) return 'audio';
    if (mediaInfo.type === 'sticker') return 'stickers';
    if (archiveExts.includes(ext)) return 'archives';
    if (docExts.includes(ext) || mime.includes('document') || mime.includes('pdf') || mime.includes('text/')) return 'documents';

    return 'other';
  },

  /**
   * Save media buffer to disk safely.
   */
  async saveToFile(buffer, filePath) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      await fs.promises.writeFile(filePath, buffer);
      logger.debug({ filePath, size: buffer.length }, 'Media buffer saved');
      return filePath;
    } catch (err) {
      logger.error({ err: err.message, filePath }, 'Failed to save media file to disk');
      return null;
    }
  },

  // ── Universal Socket Message Senders ──

  async sendText(sock, jid, text, options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { text, ...options });
  },

  async sendImage(sock, jid, imageBuffer, caption = '', options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { image: imageBuffer, caption, ...options });
  },

  async sendVideo(sock, jid, videoBuffer, caption = '', options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { video: videoBuffer, caption, ...options });
  },

  async sendAudio(sock, jid, audioBuffer, ptt = false, options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/mp4', ptt, ...options });
  },

  async sendDocument(sock, jid, docBuffer, fileName, mimetype = 'application/octet-stream', options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { document: docBuffer, fileName, mimetype, ...options });
  },

  async sendSticker(sock, jid, stickerBuffer, options = {}) {
    if (!sock?.sendMessage) return null;
    return sock.sendMessage(jid, { sticker: stickerBuffer, ...options });
  },
};

export default mediaService;
