/**
 * Sticker Reply Menu (Feature 9).
 */
const stickerMenu = {
  /**
   * Get the sticker reply menu text.
   * @returns {string}
   */
  getText() {
    return `╔══════════════════════════╗
║  🎭 *REPLY USING STICKERS* ║
╚══════════════════════════╝

*9a.* 🎨 Convert Image to Sticker Reply
*9b.* 🤖 Toggle Sticker Auto-Reply Mode
*9c.* 📋 Add Sticker Keyword Reply Rule
*9d.* 📊 Sticker Reply Status

━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *How to use:*
• *9a* — Send or reply to an image to convert and send back as a sticker
• *9b* — Toggle automatic sticker responses for incoming messages
• *9c* — Configure keywords that trigger automated sticker replies

Send *0* to return to Main Menu.`;
  },
};

export default stickerMenu;
