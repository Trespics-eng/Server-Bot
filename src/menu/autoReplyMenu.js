/**
 * Auto Reply submenu.
 */
const autoReplyMenu = {
  /**
   * Get the main auto-reply submenu text.
   * @returns {string}
   */
  getText() {
    return `╔══════════════════════════╗
║  💬 *AUTO REPLY*        ║
╚══════════════════════════╝

*4a.* 📴 Configure Offline Auto Reply
*4b.* 🔑 Configure Keyword & Greeting Replies
*4c.* ✅ Enable Auto Reply
*4d.* ⏹️ Disable Auto Reply
*4e.* 📋 Manage Reply Rules
*4f.* 📊 Check Auto Reply Status

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.`;
  },

  /**
   * Get the offline reply configuration text.
   * @returns {string}
   */
  getOfflineConfigText() {
    return `📴 *Offline Auto Reply Configuration*

*4a1.* Set availability to Available 🟢
*4a2.* Set availability to Away 🟡
*4a3.* Set availability to Offline 🔴
*4a4.* Set custom offline message

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.
Send *4* to return to Auto Reply menu.`;
  },

  /**
   * Get the keyword config text.
   * @returns {string}
   */
  getKeywordConfigText() {
    return `🔑 *Keyword & Greeting Reply Configuration*

Send *4e* to manage reply rules (add, edit, delete, list).

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.
Send *4* to return to Auto Reply menu.`;
  },

  /**
   * Get the reply rules management text.
   * @returns {string}
   */
  getReplyRulesText() {
    return `📋 *Reply Rules Management*

*4e1.* ➕ Add a Rule
*4e2.* 📋 List All Rules
*4e3.* ✏️ Edit a Rule
*4e4.* 🗑️ Delete a Rule
*4e5.* 🔄 Enable/Disable a Rule

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.
Send *4* to return to Auto Reply menu.`;
  },
};

export default autoReplyMenu;
