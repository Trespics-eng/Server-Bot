import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Universal Sticker Creation Feature for WhatsApp Bot.
 * Uses FFmpeg to convert images and short video clips to WhatsApp-compliant WebP stickers (512x512).
 */
export const stickerReply = {
  /**
   * Check if FFmpeg is available on the host system.
   */
  async isFFmpegAvailable() {
    try {
      await execFileAsync('ffmpeg', ['-version']);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Convert an image buffer to a WebP sticker (512x512).
   * @param {Buffer} imageBuffer
   * @returns {Promise<Buffer|null>}
   */
  async convertImageToSticker(imageBuffer) {
    if (!imageBuffer || imageBuffer.length === 0) return null;

    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const inputPath = path.join(tmpDir, `wa_sticker_in_${timestamp}.jpg`);
    const outputPath = path.join(tmpDir, `wa_sticker_out_${timestamp}.webp`);

    try {
      await fs.promises.writeFile(inputPath, imageBuffer);

      // Convert using ffmpeg: scale to fit within 512x512 with transparent padding
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-vcodec', 'libwebp',
        '-filter:v', "scale='if(gt(a,1),512,-1)':'if(gt(a,1),-1,512)',pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        '-lossless', '1',
        '-qscale', '75',
        '-preset', 'default',
        '-an',
        '-vsync', '0',
        '-y',
        outputPath,
      ], { timeout: 30000 });

      if (fs.existsSync(outputPath)) {
        const webpBuffer = await fs.promises.readFile(outputPath);
        return webpBuffer;
      }
      return null;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to convert image to sticker');
      return null;
    } finally {
      try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
  },

  /**
   * Convert a short video clip (up to 7 seconds) into an animated WhatsApp WebP sticker.
   * @param {Buffer} videoBuffer
   * @returns {Promise<Buffer|null>}
   */
  async convertVideoToSticker(videoBuffer) {
    if (!videoBuffer || videoBuffer.length === 0) return null;

    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const inputPath = path.join(tmpDir, `wa_anim_in_${timestamp}.mp4`);
    const outputPath = path.join(tmpDir, `wa_anim_out_${timestamp}.webp`);

    try {
      await fs.promises.writeFile(inputPath, videoBuffer);

      // Convert video to animated webp, looping, <= 500KB for WhatsApp
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-t', '6',
        '-vf', "scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-compression_level', '4',
        '-q:v', '50',
        '-loop', '0',
        '-an',
        '-vsync', '0',
        '-y',
        outputPath,
      ], { timeout: 45000 });

      if (fs.existsSync(outputPath)) {
        const webpBuffer = await fs.promises.readFile(outputPath);
        return webpBuffer;
      }
      return null;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to convert video to animated sticker');
      return null;
    } finally {
      try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
  },

  getStatusText() {
    return `╔══════════════════════════╗\n` +
      `║  🎭 *STICKER MAKER*      ║\n` +
      `╚══════════════════════════╝\n\n` +
      `✅ *Active & Ready*\n` +
      `📌 Send any image or short video with caption *.sticker* or *.s*\n` +
      `📌 Or reply to any image with *.sticker* to convert it instantly!`;
  },
};

export default stickerReply;
