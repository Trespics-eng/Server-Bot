import path from 'path';

const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/**
 * Validates that an account ID contains only safe alphanumeric/UUID characters
 * and does not allow directory traversal.
 * @param {string} accountId
 * @returns {boolean}
 */
export function isValidAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string') return false;
  // Accept standard UUIDs, alphanumeric with hyphens/underscores
  return /^[a-zA-Z0-9_-]{1,64}$/.test(accountId);
}

/**
 * Sanitize a filename to prevent path traversal.
 * @param {string} filename
 * @returns {string} safe filename
 */
export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'unnamed';
  let safe = path.basename(filename);
  safe = safe.replace(UNSAFE_FILENAME_CHARS, '_');
  safe = safe.replace(/^\.+/, '');
  safe = safe.replace(/_+/g, '_').trim();
  if (!safe || safe === '_') return 'unnamed';
  if (safe.length > 200) {
    const ext = path.extname(safe);
    const name = path.basename(safe, ext);
    safe = name.substring(0, 200 - ext.length) + ext;
  }
  return safe;
}

/**
 * Builds a path guaranteed to be strictly inside baseDir.
 * Throws an error if a path traversal attempt is detected.
 * @param {string} baseDir
 * @param {string} subPath
 * @returns {string} resolved safe path
 */
export function buildSandboxedPath(baseDir, subPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(baseDir, subPath);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(`Security violation: Access outside sandbox directory is prohibited (${subPath})`);
  }

  return resolvedTarget;
}
