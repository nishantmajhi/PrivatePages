/**
 * PrivatePages - policy.js
 *
 * The decisions, with none of the plumbing: how long a lockout lasts, which
 * actions are authentication boundaries, and whether a given navigation should
 * be blocked. Nothing in this file touches chrome.*, storage, or the network,
 * which is what makes it testable — and what makes it possible to answer the
 * navigation question synchronously, from a state object the caller already
 * holds, instead of after three awaits that the page being blocked does not
 * wait for.
 *
 * Loaded as a plain (non-module) script via <script> / importScripts, so every
 * function below lands on the global scope of whatever context loads it. The
 * module.exports tail at the bottom is inert in a browser and is what lets the
 * test runner load the same file.
 */

/* -------------------------------------------------------------------- */
/* Lockout schedule                                                      */
/* -------------------------------------------------------------------- */

/**
 * How long to refuse attempts after `failCount` consecutive failures.
 *
 * The first two mistakes cost nothing, because two mistakes is a typo. From
 * the third the delay grows fast enough that guessing the 10^6 keyspace stops
 * being a thing a person or a script does in an afternoon.
 */
function ppLockoutDurationMs(failCount) {
  if (failCount >= 12) return 60 * 60 * 1000; // 60 min
  if (failCount >= 8) return 30 * 60 * 1000; // 30 min
  if (failCount >= 5) return 5 * 60 * 1000; // 5 min
  if (failCount >= 3) return 30 * 1000; // 30 sec
  return 0;
}

/**
 * The actions that check a PIN or a recovery key.
 *
 * This list is the enforcement point for rate limiting. It is written out
 * rather than inferred, because the original code enforced the lockout inside
 * two of these six handlers and quietly left the other four — including the
 * one the block page calls — to verify as fast as PBKDF2 would allow. Adding a
 * seventh action that checks a secret means adding it here; forgetting to is
 * the bug this list exists to make hard to repeat.
 */
const PP_SECRET_VERIFYING_ACTIONS = [
  "verifyPin",
  "changePin",
  "useRecoveryKey",
  "regenerateRecoveryKey",
  "unlockDomainPermanent",
  "unlockDomainTemporary",
];

function ppActionVerifiesSecret(action) {
  return PP_SECRET_VERIFYING_ACTIONS.indexOf(action) !== -1;
}

/* -------------------------------------------------------------------- */
/* The navigation decision                                               */
/* -------------------------------------------------------------------- */

/**
 * Should a navigation to `url` be stopped?
 *
 * `state` is `{ lockedSites, unlockMap, setupComplete }` — the caller's own
 * in-memory copy. Returns `{ block, domain, reason }`; `domain` is the
 * canonical locked domain that matched, which is the key the unlock map and
 * the purge are both indexed by.
 *
 * Nothing is blocked before setup is complete. That is deliberate: without a
 * PIN there is no way to unlock anything, so blocking would lock the user out
 * of their own browser with no route back in.
 */
function ppDecideNavigation(state, url, now) {
  const miss = (reason) => ({ block: false, domain: null, reason });

  if (!state || !state.setupComplete) return miss("setup-incomplete");

  let hostname;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return miss("not-web");
    hostname = parsed.hostname.toLowerCase();
  } catch (e) {
    return miss("unparseable");
  }
  if (!hostname) return miss("no-hostname");

  const domain = ppFindMatchingLockedDomain(hostname, state.lockedSites || []);
  if (!domain) return miss("not-locked");

  if (ppUnlockIsActive(state.unlockMap, domain, now)) {
    return { block: false, domain, reason: "temporarily-unlocked" };
  }
  return { block: true, domain, reason: "locked" };
}

/** True while `domain` holds an unexpired temporary unlock. */
function ppUnlockIsActive(unlockMap, domain, now) {
  if (!unlockMap) return false;
  const expiry = unlockMap[domain];
  return typeof expiry === "number" && now < expiry;
}

/** The locked domains that are not currently unlocked. */
function ppEffectivelyLocked(state, now) {
  if (!state || !Array.isArray(state.lockedSites)) return [];
  return state.lockedSites.filter((d) => !ppUnlockIsActive(state.unlockMap, d, now));
}

/** The soonest unlock expiry still in the future, or null if there is none. */
function ppNextUnlockExpiry(unlockMap, now) {
  let soonest = null;
  for (const domain of Object.keys(unlockMap || {})) {
    const expiry = unlockMap[domain];
    if (typeof expiry !== "number" || expiry <= now) continue;
    if (soonest === null || expiry < soonest) soonest = expiry;
  }
  return soonest;
}

/** Drop expired entries. Returns a new map and whether anything was dropped. */
function ppPruneUnlockMap(unlockMap, now) {
  const kept = {};
  let changed = false;
  for (const domain of Object.keys(unlockMap || {})) {
    if (ppUnlockIsActive(unlockMap, domain, now)) kept[domain] = unlockMap[domain];
    else changed = true;
  }
  return { map: kept, changed };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ppLockoutDurationMs,
    ppActionVerifiesSecret,
    PP_SECRET_VERIFYING_ACTIONS,
    ppDecideNavigation,
    ppUnlockIsActive,
    ppEffectivelyLocked,
    ppNextUnlockExpiry,
    ppPruneUnlockMap,
  };
}
