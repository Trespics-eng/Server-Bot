import accountSettings from '../services/accountSettings.js';
import { isGroupJid } from '../utils/validation.js';

export const antiViewOnce = {
  isEnabledFor(accountId, chatJid) {
    const enabled = accountSettings.get(accountId, 'anti_view_once.enabled', true);
    if (!enabled) return false;

    const scope = accountSettings.get(accountId, 'anti_view_once.scope', 'both');
    const isGroup = isGroupJid(chatJid);

    switch (scope) {
      case 'private': return !isGroup;
      case 'group': return isGroup;
      case 'both': return true;
      default: return true;
    }
  },

  enablePrivate(accountId) {
    accountSettings.set(accountId, 'anti_view_once.enabled', true);
    accountSettings.set(accountId, 'anti_view_once.scope', 'private');
    return '✅ *SUCCESS:* Anti-ViewOnce is enabled for *private chats* only.';
  },

  enableGroup(accountId) {
    accountSettings.set(accountId, 'anti_view_once.enabled', true);
    accountSettings.set(accountId, 'anti_view_once.scope', 'group');
    return '✅ *SUCCESS:* Anti-ViewOnce is enabled for *groups* only.';
  },

  enableBoth(accountId) {
    accountSettings.set(accountId, 'anti_view_once.enabled', true);
    accountSettings.set(accountId, 'anti_view_once.scope', 'both');
    return '✅ *SUCCESS:* Anti-ViewOnce is enabled for both *private chats and groups*.';
  },

  disable(accountId) {
    accountSettings.set(accountId, 'anti_view_once.enabled', false);
    accountSettings.set(accountId, 'anti_view_once.scope', 'none');
    return '⏹️ *SUCCESS:* Anti-ViewOnce has been disabled.';
  },

  getStatusText(accountId) {
    const enabled = accountSettings.get(accountId, 'anti_view_once.enabled', true);
    const scope = accountSettings.get(accountId, 'anti_view_once.scope', 'both');

    return `👁️ *Anti-ViewOnce Status*\n\n` +
      `• Status: ${enabled ? '✅ Enabled' : '⏹️ Disabled'}\n` +
      `• Scope: ${scope}\n` +
      `• Action: Intercepts & forwards permanent photo/video to owner\n\n` +
      `Send *3a* for Private only\n` +
      `Send *3b* for Groups only\n` +
      `Send *3c* for Both\n` +
      `Send *3d* to disable\n` +
      `Send *0* to return to Main Menu.`;
  },

  extractViewOnceContent(message) {
    if (!message || !message.message) return null;
    const msg = message.message;

    if (msg.viewOnceMessage?.message) return msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) return msg.viewOnceMessageV2.message;
    if (msg.viewOnceMessageV2Extension?.message) return msg.viewOnceMessageV2Extension.message;

    return null;
  },
};

export default antiViewOnce;
