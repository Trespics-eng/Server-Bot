/**
 * File Organizer submenu.
 */
const fileOrganizerMenu = {
  /**
   * Get the submenu text.
   * @returns {string}
   */
  getText() {
    return `╔══════════════════════════╗
║  📁 *FILE ORGANIZER*    ║
╚══════════════════════════╝

*5a.* Enable in Private Chats
*5b.* Enable in Groups
*5c.* Enable in Both (Private + Groups)
*5d.* Disable File Organization
*5e.* Configure Download Folder
*5f.* Configure Categories
*5g.* Check File Organizer Status

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.`;
  },

  /**
   * Get the categories configuration text.
   * @returns {string}
   */
  getCategoriesText() {
    return `📂 *File Categories Configuration*

Files are automatically sorted into:
• 📄 *documents* - PDF, Word, Excel, PowerPoint, text files
• 🖼️ *images* - JPG, PNG, GIF, WebP, etc.
• 🎬 *videos* - MP4, AVI, MKV, MOV, etc.
• 🎵 *audio* - MP3, WAV, OGG, FLAC, etc.
• 📦 *archives* - ZIP, RAR, 7Z, TAR, etc.
• 📎 *other* - Unrecognized file types

Custom categories coming in a future update.

━━━━━━━━━━━━━━━━━━━━━━━━━━
Send *0* to return to Main Menu.
Send *5* to return to File Organizer menu.`;
  },
};

export default fileOrganizerMenu;
