/**
 * roles.js — the ONLY module that decides what an authenticated person may do.
 *
 * Deliberately separate from auth.js. auth.js answers "who is this?" using the
 * company IdP; roles.js answers "what are they allowed to do here?" using
 * grants stored in KV. Keeping them apart is what lets the admin panel manage
 * access without becoming an identity provider:
 *
 *   - Identity stays in Entra / Cloudflare Access. Offboarding someone there
 *     removes their access here, immediately and without anyone remembering to.
 *   - Authorization lives here. Granting "admin" to an address does not create
 *     a login; it upgrades an identity the IdP already vouches for.
 *
 * Adding a user store with its own passwords would break the first property,
 * which is the one that actually keeps a departed employee out.
 *
 * Roles:
 *   admin   Full use, plus the admin panel.
 *   rep     Full use of the assistant.
 *   denied  Authenticated but blocked. Distinct from "unknown" so an
 *           explicit revocation survives a permissive DEFAULT_ROLE.
 */

export const ROLES = ['admin', 'rep', 'denied'];

/** Bootstrap admins from config, normalised. */
function bootstrapAdmins(cfg) {
  return (cfg.BOOTSTRAP_ADMINS || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/**
 * Resolve the effective role for an authenticated user.
 *
 * Precedence, highest first:
 *   1. BOOTSTRAP_ADMINS from config — always admin. This solves the cold-start
 *      problem: with an empty KV nobody could otherwise reach the panel to
 *      grant the first role. Config beats storage, so a botched grant can
 *      always be recovered by redeploying rather than by editing KV by hand.
 *   2. An explicit grant in storage.
 *   3. DEFAULT_ROLE for anyone the IdP authenticated but nobody has graded.
 *
 * @param {{ email: string }} user
 * @param {import('./storage.js').Storage} storage
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @returns {Promise<{ role: string, source: 'bootstrap'|'grant'|'default' }>}
 */
export async function resolveRole(user, storage, cfg) {
  const email = String(user?.email || '').toLowerCase();

  if (email && bootstrapAdmins(cfg).includes(email)) {
    return { role: 'admin', source: 'bootstrap' };
  }

  const record = await storage.getUser(email).catch(() => null);
  if (record && ROLES.includes(record.role)) {
    return { role: record.role, source: 'grant' };
  }

  const fallback = ROLES.includes(cfg.DEFAULT_ROLE) ? cfg.DEFAULT_ROLE : 'denied';
  return { role: fallback, source: 'default' };
}

/** May this role use the assistant at all? */
export function canUseAssistant(role) {
  return role === 'admin' || role === 'rep';
}

/** May this role reach the admin panel? */
export function canAdminister(role) {
  return role === 'admin';
}

/**
 * Guard against removing the last administrator.
 *
 * Losing every admin is only recoverable by redeploying with a
 * BOOTSTRAP_ADMINS change, which is a bad afternoon. Bootstrap admins do not
 * count toward the total, because they cannot be revoked here anyway — if the
 * only admins are bootstrap admins, granted admins are free to come and go.
 *
 * @returns {Promise<boolean>} true when the change is safe to apply.
 */
export async function wouldLeaveNoAdmin(targetEmail, newRole, storage, cfg) {
  if (newRole === 'admin') return false;

  const email = String(targetEmail).toLowerCase();

  // A bootstrap admin's grant record is decorative; config still makes them
  // an admin, so changing it cannot orphan the system.
  if (bootstrapAdmins(cfg).includes(email)) return false;
  if (bootstrapAdmins(cfg).length > 0) return false;

  const users = await storage.listUsers();
  const admins = users.filter((u) => u.role === 'admin').map((u) => u.email);

  return admins.length <= 1 && admins.includes(email);
}
