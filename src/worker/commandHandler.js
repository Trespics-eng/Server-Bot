import logger from '../utils/logger.js';
import { normalizeCommand } from '../utils/validation.js';
import mediaService from '../services/mediaService.js';

// Menu modules
import mainMenu from '../menu/mainMenu.js';
import botMenu from '../menu/botMenu.js';
import antiDeleteMenu from '../menu/antiDeleteMenu.js';
import antiViewOnceMenu from '../menu/antiViewOnceMenu.js';
import autoReplyMenu from '../menu/autoReplyMenu.js';
import fileOrganizerMenu from '../menu/fileOrganizerMenu.js';
import settingsMenu from '../menu/settingsMenu.js';
import profilePicMenu from '../menu/profilePicMenu.js';
import stickerMenu from '../menu/stickerMenu.js';

// Feature modules
import botController from '../features/botController.js';
import antiDelete from '../features/antiDelete.js';
import antiViewOnce from '../features/antiViewOnce.js';
import fileOrganizer from '../features/fileOrganizer.js';
import profilePicture from '../features/profilePicture.js';
import stickerReply from '../features/stickerReply.js';

const activeSubmenus = new Map();

/**
 * Multi-Tenant Command Handler.
 * Routes numbered menu commands per WhatsApp account and chat.
 */
export const commandHandler = {
  /**
   * Handle an owner command.
   * @param {object} param0
   * @returns {Promise<boolean>}
   */
  async handleCommand({ accountId, phoneNumber, rawCommand, chatJid, sock }) {
    try {
      let cmd = normalizeCommand(rawCommand);
      const subKey = `${accountId}:${chatJid}`;

      // Check active submenu shortcut (e.g. typing 'a' while in menu 2 -> '2a')
      if (activeSubmenus.has(subKey) && cmd !== '0' && !/^[0-9][a-z]/.test(cmd)) {
        const sub = activeSubmenus.get(subKey);
        if (/^[a-g]$/.test(cmd)) {
          cmd = `${sub}${cmd}`;
        }
      }

      // ── Main Menu ──
      if (cmd === '0' || cmd === '.menu' || cmd === 'menu' || cmd === '.help') {
        activeSubmenus.delete(subKey);
        await mediaService.sendText(sock, chatJid, mainMenu.getText());
        return true;
      }

      // ── Feature 1: Bot On/Off ──
      if (cmd === '1') {
        activeSubmenus.set(subKey, '1');
        await mediaService.sendText(sock, chatJid, botMenu.getText());
        return true;
      }
      if (cmd === '1a') {
        await mediaService.sendText(sock, chatJid, botController.enable(accountId));
        return true;
      }
      if (cmd === '1b') {
        await mediaService.sendText(sock, chatJid, botController.disable(accountId));
        return true;
      }
      if (cmd === '1c') {
        await mediaService.sendText(sock, chatJid, botController.getStatusText(accountId));
        return true;
      }

      // ── Feature 2: Anti-Delete ──
      if (cmd === '2') {
        activeSubmenus.set(subKey, '2');
        await mediaService.sendText(sock, chatJid, antiDeleteMenu.getText());
        return true;
      }
      if (cmd === '2a') {
        await mediaService.sendText(sock, chatJid, antiDelete.enablePrivate(accountId));
        return true;
      }
      if (cmd === '2b') {
        await mediaService.sendText(sock, chatJid, antiDelete.enableGroup(accountId));
        return true;
      }
      if (cmd === '2c') {
        await mediaService.sendText(sock, chatJid, antiDelete.enableBoth(accountId));
        return true;
      }
      if (cmd === '2d') {
        await mediaService.sendText(sock, chatJid, antiDelete.disable(accountId));
        return true;
      }
      if (cmd === '2e') {
        await mediaService.sendText(sock, chatJid, antiDelete.getStatusText(accountId));
        return true;
      }

      // ── Feature 3: Anti-ViewOnce ──
      if (cmd === '3') {
        activeSubmenus.set(subKey, '3');
        await mediaService.sendText(sock, chatJid, antiViewOnceMenu.getText());
        return true;
      }
      if (cmd === '3a') {
        await mediaService.sendText(sock, chatJid, antiViewOnce.enablePrivate(accountId));
        return true;
      }
      if (cmd === '3b') {
        await mediaService.sendText(sock, chatJid, antiViewOnce.enableGroup(accountId));
        return true;
      }
      if (cmd === '3c') {
        await mediaService.sendText(sock, chatJid, antiViewOnce.enableBoth(accountId));
        return true;
      }
      if (cmd === '3d') {
        await mediaService.sendText(sock, chatJid, antiViewOnce.disable(accountId));
        return true;
      }
      if (cmd === '3e') {
        await mediaService.sendText(sock, chatJid, antiViewOnce.getStatusText(accountId));
        return true;
      }

      // ── Feature 4: Auto-Reply Menu ──
      if (cmd === '4') {
        activeSubmenus.set(subKey, '4');
        await mediaService.sendText(sock, chatJid, autoReplyMenu.getText());
        return true;
      }

      // ── Feature 5: File Organizer ──
      if (cmd === '5') {
        activeSubmenus.set(subKey, '5');
        await mediaService.sendText(sock, chatJid, fileOrganizerMenu.getText());
        return true;
      }
      if (cmd === '5a') {
        await mediaService.sendText(sock, chatJid, fileOrganizer.enable(accountId));
        return true;
      }
      if (cmd === '5b') {
        await mediaService.sendText(sock, chatJid, fileOrganizer.disable(accountId));
        return true;
      }
      if (cmd === '5c') {
        await mediaService.sendText(sock, chatJid, fileOrganizer.getStatusText(accountId));
        return true;
      }

      // ── Feature 6: Settings and Status ──
      if (cmd === '6') {
        activeSubmenus.set(subKey, '6');
        const phone = phoneNumber ? `+${phoneNumber}` : 'Connected';
        const status = `⚙️ *SYSTEM STATUS & DIAGNOSTICS*\n\n` +
          `• Account ID: \`${accountId}\`\n` +
          `• Linked Number: *${phone}*\n` +
          `• Bot Switch: ${botController.isEnabled(accountId) ? '✅ Active' : '⏸️ Paused'}\n` +
          `• Anti-Delete: ${antiDelete.isEnabledFor(accountId, chatJid) ? '✅ Active' : '⏹️ Disabled'}\n` +
          `• Anti-ViewOnce: ${antiViewOnce.isEnabledFor(accountId, chatJid) ? '✅ Active' : '⏹️ Disabled'}\n` +
          `• File Organizer: ${fileOrganizer.isEnabled(accountId) ? '✅ Active' : '⏹️ Disabled'}\n` +
          `• Web Dashboard: Active\n\n` +
          `Send *0* to return to Main Menu.`;
        await mediaService.sendText(sock, chatJid, status);
        return true;
      }

      // ── Feature 7: Help ──
      if (cmd === '7') {
        const helpText = `❓ *COMMAND GUIDE*\n\n` +
          `• Send *0* at any time to open the management menu.\n` +
          `• Send *.s* or *.sticker* with an image to make a sticker.\n` +
          `• Send *.setdp* with an image to change your profile picture.\n` +
          `• Send *.setvideodp* with a video for an animated profile picture.\n` +
          `• Visit your web dashboard to configure keyword rules anytime!`;
        await mediaService.sendText(sock, chatJid, helpText);
        return true;
      }

      // ── Feature 8: Profile Picture ──
      if (cmd === '8') {
        activeSubmenus.set(subKey, '8');
        await mediaService.sendText(sock, chatJid, profilePicMenu.getText());
        return true;
      }
      if (cmd === '8a') {
        const url = await profilePicture.getProfilePictureUrl(sock);
        await mediaService.sendText(sock, chatJid, url);
        return true;
      }
      if (cmd === '8d') {
        const res = await profilePicture.removeProfilePicture(sock);
        await mediaService.sendText(sock, chatJid, res);
        return true;
      }

      // ── Feature 9: Stickers ──
      if (cmd === '9') {
        activeSubmenus.set(subKey, '9');
        await mediaService.sendText(sock, chatJid, stickerMenu.getText());
        return true;
      }
      if (cmd === '9a') {
        await mediaService.sendText(sock, chatJid, stickerReply.getStatusText());
        return true;
      }

      return false;
    } catch (err) {
      logger.error({ accountId, err: err.message }, 'Error in commandHandler');
      return false;
    }
  },
};

export default commandHandler;
