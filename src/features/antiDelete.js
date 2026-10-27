import accountSettings from '../services/accountSettings.js';
import { isGroupJid } from '../utils/validation.js';

export const antiDelete = {
  isEnabledFor(accountId, chatJid) {
    const enabled = accountSettings.get(accountId, 'anti_delete.enabled', true);
    if (!enabled) return false;

    const scope = accountSettings.get(accountId, 'anti_delete.scope', 'both');
    const isGroup = isGroupJid(chatJid);

    switch (scope) {
      case 'private': return !isGroup;
      case 'group': return isGroup;
      case 'both': return true;
      default: return true;
    }
  },

  enablePrivate(accountId) {
    accountSettings.set(accountId, 'anti_delete.enabled', true);
    accountSettings.set(accountId, 'anti_delete.scope', 'private');
    return '✅ *SUCCESS:* Anti-Delete is enabled for *private chats* only.';
  },

  enableGroup(accountId) {
    accountSettings.set(accountId, 'anti_delete.enabled', true);
    accountSettings.set(accountId, 'anti_delete.scope', 'group');
    return '✅ *SUCCESS:* Anti-Delete is enabled for *groups* only.';
  },

  enableBoth(accountId) {
    accountSettings.set(accountId, 'anti_delete.enabled', true);
    accountSettings.set(accountId, 'anti_delete.scope', 'both');
    return '✅ *SUCCESS:* Anti-Delete is enabled for both *private chats and groups*.';
  },

  disable(accountId) {
    accountSettings.set(accountId, 'anti_delete.enabled', false);
    accountSettings.set(accountId, 'anti_delete.scope', 'none');
    return '⏹️ *SUCCESS:* Anti-Delete has been disabled.';
  },

  getStatusText(accountId) {
    const enabled = accountSettings.get(accountId, 'anti_delete.enabled', true);
    const scope = accountSettings.get(accountId, 'anti_delete.scope', 'both');

    return `🗑️ *Anti-Delete Status*\n\n` +
      `• Status: ${enabled ? '✅ Enabled' : '⏹️ Disabled'}\n` +
      `• Scope: ${scope}\n` +
      `• Media Recovery: ✅ Active (Images, Videos, Voice Notes, Docs)\n\n` +
      `Send *2a* to enable Private only\n` +
      `Send *2b* to enable Groups only\n` +
      `Send *2c* to enable Both\n` +
      `Send *2d* to disable\n` +
      `Send *0* to return to Main Menu.`;
  },
};

export default antiDelete;
