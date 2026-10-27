/**
 * Main Menu - displayed when the owner sends '0'.
 */
const mainMenu = {
  /**
   * Get the main menu text.
   * @returns {string}
   */
  getText() {
    return `╔══════════════════════════╗
║    🤖 *MAIN MENU*       ║
╚══════════════════════════╝

Welcome to the Bot Management Panel.

Send the number of the feature you want to manage:

*1.* 🔌 Bot On/Off
*2.* 🗑️ Anti-Delete
*3.* 👁️ Anti-ViewOnce
*4.* 💬 Auto Reply
*5.* 📁 Automatic File Organizer
*6.* ⚙️ Settings and Status
*7.* ❓ Help
*8.* 🖼️ Profile Picture
*9.* 🎭 Reply Using Stickers

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* at any time to return to this menu.`;
  },
};

export default mainMenu;
