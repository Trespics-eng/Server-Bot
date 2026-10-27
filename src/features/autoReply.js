import accountSettings from '../services/accountSettings.js';

export const autoReply = {
  isEnabled(accountId) {
    return accountSettings.get(accountId, 'auto_reply.enabled', true);
  },

  enable(accountId) {
    accountSettings.set(accountId, 'auto_reply.enabled', true);
    return '✅ *SUCCESS:* Auto-Reply is now enabled.\n\nKeyword rules are active according to your configuration.';
  },

  disable(accountId) {
    accountSettings.set(accountId, 'auto_reply.enabled', false);
    return '⏹️ *SUCCESS:* Auto-Reply has been disabled.\n\nYour keyword rules are preserved and can be re-enabled later.';
  },

  getAvailability(accountId) {
    return accountSettings.get(accountId, 'auto_reply.availability', 'available');
  },

  setAvailability(accountId, status) {
    accountSettings.set(accountId, 'auto_reply.availability', status);
    return `✅ *SUCCESS:* Availability set to *${status}*.`;
  },
};

export default autoReply;
