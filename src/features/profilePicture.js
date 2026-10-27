import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Profile Picture feature.
 * Handles setting, removing, and viewing the bot owner's WhatsApp profile picture.
 * Supports setting a video as a playing profile picture (video avatar)
 * using WhatsApp's w:profile:picture protocol with video type.
 */
const profilePicture = {
  /**
   * Set the profile picture from an image buffer.
   * @param {import('@whiskeysockets/baileys').WASocket} sock - Baileys socket
   * @param {Buffer} imageBuffer - the image data
   * @returns {Promise<string>} result message
   */
  async setFromImage(sock, imageBuffer) {
    try {
      if (!sock) {
        return '❌ *FAILED:* WhatsApp socket is not connected.';
      }
      if (!imageBuffer || imageBuffer.length === 0) {
        return '❌ *FAILED:* Image data is empty.';
      }

      const myJid = sock.user?.id;
      if (!myJid) {
        return '❌ *FAILED:* Could not determine your WhatsApp ID.';
      }

      await sock.updateProfilePicture(myJid, imageBuffer);

      logger.info('Profile picture updated from image');
      return '✅ *SUCCESS:* Profile picture updated!\n\n⏳ It may take a moment for the change to appear on all devices.';
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Failed to set profile picture from image');
      return `❌ *FAILED:* ${err.message}`;
    }
  },

  /**
   * Set a video as the playing profile picture (video avatar).
   * This uses WhatsApp's native video profile picture protocol.
   *
   * The protocol sends an IQ stanza to w:profile:picture with:
   * - A <picture type="image"> node containing the thumbnail/still frame
   * - A <picture type="video"> node containing the video data
   *
   * Requires ffmpeg to:
   * 1. Extract a thumbnail frame for the still preview
   * 2. Re-encode the video to meet WhatsApp's requirements
   *    (square aspect ratio, short duration, small file size)
   *
   * @param {import('@whiskeysockets/baileys').WASocket} sock - Baileys socket
   * @param {Buffer} videoBuffer - the video data
   * @returns {Promise<string>} result message
   */
  async setFromVideo(sock, videoBuffer) {
    try {
      if (!sock) {
        return '❌ *FAILED:* WhatsApp socket is not connected.';
      }
      if (!videoBuffer || videoBuffer.length === 0) {
        return '❌ *FAILED:* Video data is empty.';
      }

      // Check if ffmpeg is available
      const ffmpegAvailable = await this.isFFmpegAvailable();
      if (!ffmpegAvailable) {
        return (
          '❌ *FAILED:* `ffmpeg` is not installed on this system.\n\n' +
          '📌 *To install ffmpeg:*\n' +
          '• *Ubuntu/Debian:* `sudo apt install ffmpeg`\n' +
          '• *macOS:* `brew install ffmpeg`\n' +
          '• *Windows:* Download from https://ffmpeg.org\n\n' +
          'Install ffmpeg and try again.'
        );
      }

      const myJid = sock.user?.id;
      if (!myJid) {
        return '❌ *FAILED:* Could not determine your WhatsApp ID.';
      }

      // Write video to a temp file
      const tmpDir = os.tmpdir();
      const timestamp = Date.now();
      const videoPath = path.join(tmpDir, `wa_bot_video_${timestamp}.mp4`);
      const processedVideoPath = path.join(tmpDir, `wa_bot_processed_${timestamp}.mp4`);
      const framePath = path.join(tmpDir, `wa_bot_frame_${timestamp}.jpg`);

      fs.writeFileSync(videoPath, videoBuffer);

      try {
        // Get the video duration
        const duration = await this.getVideoDuration(videoPath);

        // WhatsApp video profile pictures have constraints:
        // - Short duration (up to ~6 seconds)
        // - Square aspect ratio (640x640 recommended)
        // - Small file size
        const maxDuration = Math.min(duration, 6);

        // 1. Process the video: crop to square, limit duration, re-encode
        await execFileAsync('ffmpeg', [
          '-i', videoPath,
          '-t', String(maxDuration),
          '-vf', 'scale=640:640:force_original_aspect_ratio=increase,crop=640:640',
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '28',
          '-pix_fmt', 'yuv420p',
          '-an',               // strip audio for profile video
          '-movflags', '+faststart',
          '-y',
          processedVideoPath,
        ], { timeout: 60000 });

        if (!fs.existsSync(processedVideoPath)) {
          return '❌ *FAILED:* Could not process the video.';
        }

        // 2. Extract a thumbnail frame from the middle for the still preview
        const seekTime = Math.min(maxDuration / 2, 1);
        await execFileAsync('ffmpeg', [
          '-ss', String(seekTime),
          '-i', processedVideoPath,
          '-vframes', '1',
          '-q:v', '2',
          '-y',
          framePath,
        ], { timeout: 15000 });

        if (!fs.existsSync(framePath)) {
          return '❌ *FAILED:* Could not extract a thumbnail frame from the video.';
        }

        const processedVideoBuffer = fs.readFileSync(processedVideoPath);
        const frameBuffer = fs.readFileSync(framePath);

        // Check processed video size (WhatsApp limit ~2MB for profile videos)
        if (processedVideoBuffer.length > 2 * 1024 * 1024) {
          return (
            '❌ *FAILED:* Processed video is too large (' +
            (processedVideoBuffer.length / 1024 / 1024).toFixed(1) +
            ' MB).\n\n' +
            '📌 WhatsApp profile videos should be under 2 MB.\n' +
            'Try sending a shorter or lower-quality video.'
          );
        }

        // 3. Generate the resized thumbnail image (like Baileys' generateProfilePicture)
        //    We use ffmpeg to ensure proper 640x640 JPEG
        const thumbPath = path.join(tmpDir, `wa_bot_thumb_${timestamp}.jpg`);
        await execFileAsync('ffmpeg', [
          '-i', framePath,
          '-vf', 'scale=640:640',
          '-q:v', '5',
          '-y',
          thumbPath,
        ], { timeout: 10000 });

        const thumbBuffer = fs.existsSync(thumbPath) ? fs.readFileSync(thumbPath) : frameBuffer;

        // 4. Send the video profile picture via WhatsApp protocol
        //    This uses the w:profile:picture IQ stanza with both
        //    an image thumbnail and the video data
        await this.sendVideoProfilePicture(sock, myJid, thumbBuffer, processedVideoBuffer);

        // Cleanup extra temp
        try { fs.unlinkSync(thumbPath); } catch { /* ignore */ }

        const durationStr = maxDuration.toFixed(1);
        const sizeStr = (processedVideoBuffer.length / 1024).toFixed(0);
        logger.info({ duration: durationStr, size: sizeStr }, 'Video profile picture set');

        return (
          '✅ *SUCCESS:* Video profile picture set!\n\n' +
          `🎬 Duration: ${durationStr}s\n` +
          `📦 Size: ${sizeStr} KB\n` +
          '⏳ It may take a moment for the change to appear on all devices.\n\n' +
          '💡 _The video will play when someone views your profile._'
        );
      } finally {
        // Cleanup temp files
        try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
        try { fs.unlinkSync(processedVideoPath); } catch { /* ignore */ }
        try { fs.unlinkSync(framePath); } catch { /* ignore */ }
      }
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Failed to set video profile picture');
      return `❌ *FAILED:* ${err.message}`;
    }
  },

  /**
   * Send the video profile picture using WhatsApp's IQ protocol.
   *
   * This constructs and sends a raw IQ stanza to WhatsApp's servers
   * with both image (thumbnail) and video content nodes under
   * the w:profile:picture namespace.
   *
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {string} jid - the JID to update (owner's JID)
   * @param {Buffer} imageBuffer - thumbnail/still image (JPEG)
   * @param {Buffer} videoBuffer - processed video (MP4)
   */
  async sendVideoProfilePicture(sock, jid, imageBuffer, videoBuffer) {
    // Baileys exposes the internal `query` method on the socket
    // We need to use it to send a custom IQ stanza
    if (typeof sock.query !== 'function') {
      throw new Error(
        'Socket does not expose the `query` method. ' +
        'This Baileys version may not support custom IQ queries.'
      );
    }

    // Determine target JID handling (same logic as Baileys' updateProfilePicture)
    const { jidNormalizedUser } = await import('@whiskeysockets/baileys');
    const myId = sock.authState?.creds?.me?.id;
    let targetJid;
    if (myId && jidNormalizedUser(jid) !== jidNormalizedUser(myId)) {
      targetJid = jidNormalizedUser(jid);
    }

    // First set the still image (thumbnail) as the base profile picture
    // This ensures there's always a fallback for clients that don't support video
    const { generateProfilePicture } = await import('@whiskeysockets/baileys');
    const { img } = await generateProfilePicture(imageBuffer);

    // Send the profile picture update with both image and video
    // The IQ stanza includes two <picture> nodes:
    // 1. type="image" - the still thumbnail
    // 2. type="video" - the video that plays on profile view
    await sock.query({
      tag: 'iq',
      attrs: {
        to: '@s.whatsapp.net',
        type: 'set',
        xmlns: 'w:profile:picture',
        ...(targetJid ? { target: targetJid } : {}),
      },
      content: [
        {
          tag: 'picture',
          attrs: { type: 'image' },
          content: img,
        },
        {
          tag: 'picture',
          attrs: { type: 'video' },
          content: videoBuffer,
        },
      ],
    });
  },

  /**
   * Remove the current profile picture.
   * @param {import('@whiskeysockets/baileys').WASocket} sock - Baileys socket
   * @returns {Promise<string>} result message
   */
  async removeProfilePicture(sock) {
    try {
      if (!sock) {
        return '❌ *FAILED:* WhatsApp socket is not connected.';
      }

      const myJid = sock.user?.id;
      if (!myJid) {
        return '❌ *FAILED:* Could not determine your WhatsApp ID.';
      }

      await sock.removeProfilePicture(myJid);

      logger.info('Profile picture removed');
      return '✅ *SUCCESS:* Profile picture removed!\n\n⏳ It may take a moment for the change to appear on all devices.';
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Failed to remove profile picture');
      return `❌ *FAILED:* ${err.message}`;
    }
  },

  /**
   * Get the current profile picture URL.
   * @param {import('@whiskeysockets/baileys').WASocket} sock - Baileys socket
   * @returns {Promise<string>} result message
   */
  async getProfilePictureUrl(sock) {
    try {
      if (!sock) {
        return '❌ *FAILED:* WhatsApp socket is not connected.';
      }

      const myJid = sock.user?.id;
      if (!myJid) {
        return '❌ *FAILED:* Could not determine your WhatsApp ID.';
      }

      const url = await sock.profilePictureUrl(myJid, 'image');

      if (url) {
        return `🔗 *Current Profile Picture URL:*\n\n${url}\n\n⚠️ This URL is temporary and will expire.`;
      }
      return '📭 *No profile picture is currently set.*';
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('item-not-found')) {
        return '📭 *No profile picture is currently set.*';
      }
      logger.error({ err: err.message, stack: err.stack }, 'Failed to get profile picture URL');
      return `❌ *FAILED:* ${err.message}`;
    }
  },

  /**
   * Check if ffmpeg is available on the system.
   * @returns {Promise<boolean>}
   */
  async isFFmpegAvailable() {
    try {
      await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Get the duration of a video file in seconds.
   * @param {string} videoPath - absolute path to the video
   * @returns {Promise<number>} duration in seconds
   */
  async getVideoDuration(videoPath) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ], { timeout: 10000 });

      const duration = parseFloat(stdout.trim());
      return isNaN(duration) ? 1 : duration;
    } catch {
      // Fallback: just use 1 second in
      return 1;
    }
  },
};

export default profilePicture;
