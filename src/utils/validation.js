/**
 * Input validation utilities.
 * All functions are pure and side-effect free.
 */

/**
 * Normalize a phone number by stripping non-digit characters.
 * @param {string} number
 * @returns {string}
 */
export function normalizePhoneNumber(number) {
  if (!number || typeof number !== 'string') return '';
  return number.replace(/[^0-9]/g, '');
}

/**
 * Extract the bare phone number from a WhatsApp JID.
 * Handles both user JIDs (xxxxx@s.whatsapp.net) and
 * group participant JIDs.
 * @param {string} jid
 * @returns {string} phone number digits only
 */
export function extractNumberFromJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  // Take everything before the @ sign
  const atIndex = jid.indexOf('@');
  let raw = atIndex >= 0 ? jid.substring(0, atIndex) : jid;
  // Handle multi-device colon and agent underscores (e.g. 254746278212:5 or 254746278212_1)
  if (raw.includes(':')) {
    raw = raw.split(':')[0];
  }
  if (raw.includes('_')) {
    raw = raw.split('_')[0];
  }
  return normalizePhoneNumber(raw);
}

/**
 * Check if a JID matches the owner (by number, owner JID, or socket user ID/LID).
 * @param {string} jid
 * @param {object} [sock]
 * @param {string} [ownerNumber]
 * @returns {boolean}
 */
export function isOwnerJid(jid, sock = null, ownerNumber = '') {
  if (!jid || typeof jid !== 'string') return false;
  const cleanOwner = normalizePhoneNumber(ownerNumber);
  const num = extractNumberFromJid(jid);

  if (cleanOwner && num && isOwner(num, cleanOwner)) return true;
  if (cleanOwner && jid.includes(cleanOwner)) return true;

  const meId = sock?.user?.id || sock?.authState?.creds?.me?.id;
  if (meId) {
    const meNum = extractNumberFromJid(meId);
    if (num && meNum && num === meNum) return true;
    const baseJid = jid.split('@')[0].split(':')[0];
    const baseMe = meId.split('@')[0].split(':')[0];
    if (baseJid && baseMe && baseJid === baseMe) return true;
  }

  const meLid = sock?.user?.lid || sock?.authState?.creds?.me?.lid;
  if (meLid) {
    const rawLid = jid.split('@')[0].split(':')[0];
    const baseLid = meLid.split('@')[0].split(':')[0];
    if (rawLid && baseLid && rawLid === baseLid) return true;
  }

  return false;
}

/**
 * Resolve the optimal JID to reply to the owner.
 * If the incoming chat is an LID or self-chat, replying to the standard
 * phone JID (e.g. 254746278212@s.whatsapp.net) guarantees reliable delivery
 * without failing on Baileys companion LID encryption.
 * @param {string} chatJid
 * @param {object} [sock]
 * @param {string} [ownerNumber]
 * @returns {string}
 */
export function resolveOwnerReplyJid(chatJid, sock = null, ownerNumber = '') {
  const cleanOwner = normalizePhoneNumber(ownerNumber);
  const ownerStandardJid = cleanOwner ? `${cleanOwner}@s.whatsapp.net` : null;

  if (chatJid && (chatJid.endsWith('@lid') || isOwnerJid(chatJid, sock, ownerNumber))) {
    return ownerStandardJid || chatJid;
  }
  return chatJid || ownerStandardJid;
}

/**
 * Check if a JID belongs to a group chat.
 * @param {string} jid
 * @returns {boolean}
 */
export function isGroupJid(jid) {
  if (!jid) return false;
  return jid.endsWith('@g.us');
}

/**
 * Check if a JID is a status broadcast.
 * @param {string} jid
 * @returns {boolean}
 */
export function isStatusBroadcast(jid) {
  if (!jid) return false;
  return jid === 'status@broadcast';
}

/**
 * Trim and lowercase a command string for matching.
 * @param {string} text
 * @returns {string}
 */
export function normalizeCommand(text) {
  if (!text || typeof text !== 'string') return '';
  return text.trim().toLowerCase();
}

/**
 * Validate that a string is a valid menu command.
 * Valid: 0, 1, 1a, 1b, 2a, 2e, 3a, 4a, 4e, 5a, etc.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isValidMenuCommand(cmd) {
  if (!cmd) return false;
  return /^[0-7]([a-z][0-9]?)?$/.test(cmd);
}

/**
 * Sanitize text for safe display (strip control characters).
 * @param {string} text
 * @returns {string}
 */
export function sanitizeDisplayText(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove zero-width and control characters but keep newlines and tabs
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
}

/**
 * Check if a sender JID matches the configured owner.
 * Works for both private chats (sender = chat JID) and
 * group messages (sender = participant JID).
 * @param {string} senderNumber - extracted phone number
 * @param {string} ownerNumber - configured owner number
 * @returns {boolean}
 */
export function isOwner(senderNumber, ownerNumber) {
  if (!senderNumber || !ownerNumber) return false;
  const s = normalizePhoneNumber(senderNumber);
  const o = normalizePhoneNumber(ownerNumber);
  if (!s || !o) return false;
  if (s === o) return true;

  // Handle leading zero differences and country code prefixes
  const sTrim = s.replace(/^0+/, '');
  const oTrim = o.replace(/^0+/, '');
  if (sTrim === oTrim) return true;

  // Match suffixes if at least 7 digits (e.g. 254746278212 matches 0746278212 / 746278212)
  if (sTrim.length >= 7 && oTrim.length >= 7) {
    if (sTrim.endsWith(oTrim) || oTrim.endsWith(sTrim)) return true;
  }
  return false;
}
