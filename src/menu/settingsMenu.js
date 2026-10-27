import botController from '../features/botController.js';
import antiDelete from '../features/antiDelete.js';
import antiViewOnce from '../features/antiViewOnce.js';
import autoReply from '../features/autoReply.js';
import fileOrganizer from '../features/fileOrganizer.js';

/**
 * Settings and Status menu (Feature 6).
 */
const settingsMenu = {
  getText(accountId = null) {
    return `╔══════════════════════════╗
║  ⚙️ *SETTINGS & STATUS* ║
╚══════════════════════════╝

🤖 *Master Bot Status:* ${botController.isEnabled(accountId) ? '✅ ON' : '⏸️ OFF'}

🗑️ *Anti-Delete:* ${antiDelete.isEnabledFor(accountId, '') ? '✅ Active' : '⏹️ Disabled'}
👁️ *Anti-ViewOnce:* ${antiViewOnce.isEnabledFor(accountId, '') ? '✅ Active' : '⏹️ Disabled'}

💬 *Auto Reply:* ${autoReply.isEnabled(accountId) ? '✅ Enabled' : '⏹️ Disabled'}
📁 *File Organizer:* ${fileOrganizer.isEnabled(accountId) ? '✅ Active' : '⏹️ Disabled'}
🌐 *Web Dashboard:* Active

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.`;
  },
};

export default settingsMenu;
