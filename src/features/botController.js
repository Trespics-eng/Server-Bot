import accountSettings from '../services/accountSettings.js';

export const botController = {
  isEnabled(accountId) {
    return accountSettings.get(accountId, 'bot.enabled', true);
  },

  enable(accountId) {
    accountSettings.set(accountId, 'bot.enabled', true);
    return '✅ *SUCCESS:* Bot enabled successfully.\n\nAll automated features are now active.';
  },

  disable(accountId) {
    accountSettings.set(accountId, 'bot.enabled', false);
    return '⏸️ *SUCCESS:* Bot paused.\n\nAutomation features are paused. Management commands remain active.\n\nSend *0* anytime to open the menu.';
  },

  getStatusText(accountId) {
    const enabled = this.isEnabled(accountId);
    return `🤖 *Bot Status:* ${enabled ? '✅ ON' : '⏸️ OFF'}\n\n${
      enabled
        ? 'All configured features are active.'
        : 'Automated features are paused. Owner commands are still accepted.'
    }\n\nSend *1a* to Turn ON\nSend *1b* to Turn OFF\nSend *0* to return to Main Menu.`;
  },
};

export default botController;
