import accountSettings from '../services/accountSettings.js';

export const fileOrganizer = {
  isEnabled(accountId) {
    return accountSettings.get(accountId, 'file_organizer.enabled', true);
  },

  enable(accountId) {
    accountSettings.set(accountId, 'file_organizer.enabled', true);
    return '✅ *SUCCESS:* Automatic File Organizer is now *ENABLED*.';
  },

  disable(accountId) {
    accountSettings.set(accountId, 'file_organizer.enabled', false);
    return '⏹️ *SUCCESS:* Automatic File Organizer is now *DISABLED*.';
  },

  getStatusText(accountId) {
    const enabled = this.isEnabled(accountId);
    return `📁 *Automatic File Organizer*\n\n` +
      `• Status: ${enabled ? '✅ Enabled' : '⏹️ Disabled'}\n` +
      `• Auto-sorts: Images, Videos, Audio, Documents, Archives\n` +
      `• Sandbox: Isolated per WhatsApp account\n\n` +
      `Send *5a* to Enable\n` +
      `Send *5b* to Disable\n` +
      `Send *0* to return to Main Menu.`;
  },
};

export default fileOrganizer;
