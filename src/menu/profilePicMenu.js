/**
 * Profile Picture submenu (Feature 8).
 * Allows the owner to set a profile picture from an image,
 * set a playing video as the profile picture,
 * remove the current profile picture, or view the current one.
 */
const profilePicMenu = {
  /**
   * Get the submenu text.
   * @returns {string}
   */
  getText() {
    return `╔══════════════════════════╗
║  🖼️ *PROFILE PICTURE*   ║
╚══════════════════════════╝

*8a.* 🖼️ Set Profile Picture (Image)
<!-- *8b.* 🎬 Set Video as Profile Picture (Disabled for now) -->
*8c.* 🗑️ Remove Profile Picture
*8d.* 🔗 View Current Profile Picture URL

━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *How to use:*
• *8a* — Send an image to set as profile pic
<!-- • *8b* — Send a video (temporarily disabled) -->
<!-- ⚠️ Video requirements: max 6 seconds, requires ffmpeg -->

Send *0* to return to Main Menu.`;
  },
};

export default profilePicMenu;
