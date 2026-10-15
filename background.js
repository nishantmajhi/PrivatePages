/**
 * PrivatePages - background.js (MV3 service worker, classic script)
 *
 * Plumbing only. Every decision this file makes is made by a function in
 * lib/policy.js, lib/rules.js or lib/domain.js, none of which know what a
 * chrome.* API is; what is left here is storage, listeners, and keeping the
 * two in step.
 *
 * Responsibilities:
 *  - Own the PIN / recovery-key setup, verification, and lockout state.
 *  - Own the locked-sites list, and keep a copy of it in memory so that a
 *    navigation can be judged without awaiting storage first.
 *  - Keep declarativeNetRequest rules in sync with that list, which is what
 *    actually stops a locked page loading (see lib/rules.js for why), and
 *    swap the tab to blocked.html so the user sees an explanation.
 *  - Continuously purge cookies/cache for locked sites so a locked site's
 *    session cannot survive - see the NOTE below on why this replaces an
 *    "on uninstall" cleanup, which Chrome does not allow extensions to do.
 */

importScripts("lib/crypto.js", "lib/domain.js", "lib/policy.js", "lib/rules.js");

const PURGE_ALARM = "pp-purge-locked";
const UNLOCK_EXPIRY_ALARM = "pp-unlock-expiry";

/* The sweep is a backstop, not the mechanism: chrome.cookies.onChanged strips
 * a locked site's cookies the moment they are written, in real time. The sweep
 * exists to catch whatever was already on disk. Running it every minute meant
 * clearing cache, cacheStorage, service workers, IndexedDB and localStorage
 * across a dozen origins per locked domain, once a minute, forever — real
 * battery and disk churn for a belt-and-braces pass. A quarter of an hour is
 * plenty for something nothing depends on. */
const PURGE_PERIOD_MINUTES = 15;
const DEFAULT_TEMP_UNLOCK_MINUTES = 5;

/* -------------------------------------------------------------------- */
/* Storage helpers                                                       */
/* -------------------------------------------------------------------- */

async function ppGetLocal(keys) {
  return chrome.storage.local.get(keys);
}
async function ppSetLocal(obj) {
  return chrome.storage.local.set(obj);
}

async function ppGetLockedSites() {
  const { lockedSites } = await ppGetLocal({ lockedSites: [] });
  return lockedSites || [];
}

async function ppGetUnlockMap() {
  const { unlockedUntil } = await chrome.storage.session.get({ unlockedUntil: {} });
  return unlockedUntil || {};
}
async function ppSetUnlockMap(map) {
  await chrome.storage.session.set({ unlockedUntil: map });
}

/* -------------------------------------------------------------------- */
/* The in-memory view                                                    */
/*                                                                        */
/* A navigation cannot be paused while we go and ask storage what to do.  */
/* onBeforeNavigate is an observer; the request is already in flight when  */
/* it fires, and each await gives the locked page more time to arrive and  */
/* start running scripts. So the state a decision needs is kept here, in   */
/* the worker's own memory, refreshed from storage.onChanged - and the     */
/* decision itself (ppDecideNavigation) is synchronous.                    */
/*                                                                        */
/* An MV3 worker is torn down when idle, so this cache is cold on the      */
/* first event after a wake-up. ppReady covers that window by awaiting the */
/* initial load, and the declarativeNetRequest rules cover it properly:    */
/* they are enforced by the browser whether this worker is running or not. */
/* -------------------------------------------------------------------- */

let ppState = { lockedSites: [], unlockMap: {}, setupComplete: false };

const ppReady = (async function ppPrimeState() {
  const { lockedSites = [], setupComplete = false } = await ppGetLocal({
    lockedSites: [],
    setupComplete: false,
  });
  ppState = { lockedSites, unlockMap: await ppGetUnlockMap(), setupComplete };
  await ppSyncBlockRules();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.lockedSites) ppState.lockedSites = changes.lockedSites.newValue || [];
    if (changes.setupComplete) ppState.setupComplete = !!changes.setupComplete.newValue;
  } else if (area === "session" && changes.unlockedUntil) {
    ppState.unlockMap = changes.unlockedUntil.newValue || {};
  }
});

/* -------------------------------------------------------------------- */
/* Enforcement: declarativeNetRequest                                    */
/* -------------------------------------------------------------------- */

/**
 * Replace the dynamic rule set with the one the current state calls for.
 *
 * Rules are rebuilt wholesale rather than diffed. Dynamic rules survive
 * service-worker restarts and extension updates, so a rule added and never
 * removed is a rule that outlives the reason for it; clearing every id we find
 * and re-adding from scratch cannot drift.
 */
async function ppSyncBlockRules() {
  try {
    const now = Date.now();
    const desired = ppBuildBlockRules(ppState, now);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: desired,
    });

    const overflow = ppBlockRuleOverflow(ppState, now);
    if (overflow > 0) {
      console.warn(
        `PrivatePages: ${overflow} locked domain(s) exceed the dynamic rule limit and are ` +
          "blocked only by the navigation handler, which cannot stop a request that is already in flight."
      );
    }

    /* A temporary unlock has an expiry, and a rule does not. Wake up when the
     * soonest one runs out so the rule goes back in place then, rather than
     * whenever the next sweep happens to come round. */
    const next = ppNextUnlockExpiry(ppState.unlockMap, now);
    if (next === null) await chrome.alarms.clear(UNLOCK_EXPIRY_ALARM);
    else chrome.alarms.create(UNLOCK_EXPIRY_ALARM, { when: next });
  } catch (e) {
    console.warn("PrivatePages: could not update blocking rules:", e);
  }
}

/* -------------------------------------------------------------------- */
/* Lockout / rate limiting for PIN and recovery-key attempts             */
/* -------------------------------------------------------------------- */

async function ppCheckLockout() {
  const { lockoutUntil = 0 } = await ppGetLocal({ lockoutUntil: 0 });
  const remaining = lockoutUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

async function ppRecordFailedAttempt() {
  const { failedAttempts = 0 } = await ppGetLocal({ failedAttempts: 0 });
  const next = failedAttempts + 1;
  const duration = ppLockoutDurationMs(next);
  const lockoutUntil = duration > 0 ? Date.now() + duration : 0;
  await ppSetLocal({ failedAttempts: next, lockoutUntil });
  return { failedAttempts: next, lockoutUntil };
}

async function ppRecordSuccess() {
  await ppSetLocal({ failedAttempts: 0, lockoutUntil: 0 });
}

/** The reply every refused-because-locked-out action gives. */
function ppLockoutResponse(lockoutRemaining) {
  return { ok: false, lockedOut: true, lockoutRemaining };
}

/* -------------------------------------------------------------------- */
/* Cookie / cache purging                                                */
/*                                                                        */
/* NOTE ON "DELETE COOKIES IF THE EXTENSION IS REMOVED":                 */
/* Chrome does not let an extension run privileged code after it has     */
/* been uninstalled - there is no hook for that. Instead, PrivatePages   */
/* keeps locked sites permanently logged out WHILE IT IS ACTIVE: any     */
/* cookie written for a locked domain is stripped immediately, and a     */
/* sweep runs periodically as a backstop. Net effect for the user is     */
/* the same as the original request - a locked site never holds a valid  */
/* session, so removing the extension (or forgetting the PIN/recovery    */
/* key) still leaves the user logged out and required to sign in again.  */
/* -------------------------------------------------------------------- */

async function ppPurgeDomain(domain) {
  /* Hostnames seen in the cookie jar tell us which subdomains this profile has
   * really used, which is a better list to clear storage for than any fixed
   * set of guesses. Collected here, filtered in ppOriginsToPurge. */
  const observedHosts = [];

  try {
    const cookies = await chrome.cookies.getAll({ domain });
    await Promise.all(
      cookies.map((cookie) => {
        const protocol = cookie.secure ? "https://" : "http://";
        const cookieDomain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
        observedHosts.push(cookieDomain);
        const url = `${protocol}${cookieDomain}${cookie.path}`;
        return chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }).catch(() => {});
      })
    );
  } catch (e) {
    // cookies API best-effort
  }

  try {
    await chrome.browsingData.remove(
      { origins: ppOriginsToPurge(domain, observedHosts) },
      { cache: true, cacheStorage: true, serviceWorkers: true, indexedDB: true, localStorage: true }
    );
  } catch (e) {
    // browsingData API best-effort
  }
}

async function ppPurgeAllLocked() {
  await Promise.all(ppEffectivelyLocked(ppState, Date.now()).map(ppPurgeDomain));
}

async function ppCleanExpiredUnlocks() {
  const { map, changed } = ppPruneUnlockMap(await ppGetUnlockMap(), Date.now());
  if (changed) {
    await ppSetUnlockMap(map);
    ppState.unlockMap = map;
  }
  return changed;
}

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (changeInfo.removed) return;
  await ppReady;
  const cookieDomain = changeInfo.cookie.domain.startsWith(".")
    ? changeInfo.cookie.domain.slice(1)
    : changeInfo.cookie.domain;
  const match = ppFindMatchingLockedDomain(cookieDomain, ppState.lockedSites);
  if (!match) return;
  if (ppUnlockIsActive(ppState.unlockMap, match, Date.now())) return;
  const protocol = changeInfo.cookie.secure ? "https://" : "http://";
  const url = `${protocol}${cookieDomain}${changeInfo.cookie.path}`;
  chrome.cookies
    .remove({ url, name: changeInfo.cookie.name, storeId: changeInfo.cookie.storeId })
    .catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PURGE_ALARM) {
    await ppReady;
    await ppCleanExpiredUnlocks();
    await ppSyncBlockRules();
    await ppPurgeAllLocked();
  } else if (alarm.name === UNLOCK_EXPIRY_ALARM) {
    await ppReady;
    await ppCleanExpiredUnlocks();
    await ppSyncBlockRules();
  }
});

/**
 * Make sure the sweep alarm exists, without restarting its clock.
 *
 * Alarms survive a service-worker teardown, so this is normally a no-op — but
 * it was previously only called from onInstalled and onStartup, which means an
 * alarm lost to a crash or a cleared profile would never have come back until
 * the next browser restart. Creating it unconditionally on every wake-up is
 * the other failure: `alarms.create` replaces an existing alarm of the same
 * name and resets its period, so a worker that wakes often would push a
 * 15-minute sweep out forever. Checking first avoids both.
 */
async function ppEnsureAlarm() {
  try {
    const existing = await chrome.alarms.get(PURGE_ALARM);
    if (!existing) chrome.alarms.create(PURGE_ALARM, { periodInMinutes: PURGE_PERIOD_MINUTES });
  } catch (e) {
    chrome.alarms.create(PURGE_ALARM, { periodInMinutes: PURGE_PERIOD_MINUTES });
  }
}

/* Every path into this worker goes through a wake-up, so this runs whether the
 * entry point was a navigation, a message or the alarm itself. */
ppEnsureAlarm();

/* -------------------------------------------------------------------- */
/* Navigation: showing the block page                                    */
/*                                                                        */
/* The declarativeNetRequest rules above are what stop the page loading.  */
/* This part is presentation: it replaces whatever Chrome would show for  */
/* a blocked request with a page that explains itself and takes a PIN.    */
/* -------------------------------------------------------------------- */

const PP_BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");

/**
 * Where each blocked tab was going, so the block page can send the user back
 * after a successful unlock.
 *
 * The original passed the full original URL in the block page's query string,
 * which put the path and query of the locked page into the tab's address bar
 * and into browsing history in plaintext — legible to anyone glancing at the
 * screen, which is the precise thing this extension exists to prevent.
 *
 * It is held twice: in memory, because writing it must not delay the redirect,
 * and in chrome.storage.session, because the service worker can be torn down
 * between blocking the tab and the user typing their PIN. Session storage is
 * wiped on browser restart, which is the right lifetime for it.
 */
let ppBlockedReturn = {};

function ppRememberReturn(tabId, domain, url) {
  ppBlockedReturn[String(tabId)] = { domain, url };
  /* Deliberately not awaited: the redirect goes out first. */
  chrome.storage.session
    .get({ blockedReturn: {} })
    .then(({ blockedReturn = {} }) => {
      blockedReturn[String(tabId)] = { domain, url };
      return chrome.storage.session.set({ blockedReturn });
    })
    .catch(() => {});
}

/**
 * Swap a tab to the block page.
 *
 * Nothing is awaited before `tabs.update`. The decision that got us here was
 * made synchronously from memory for the same reason: every await between the
 * navigation starting and the tab being taken away is time the locked page
 * spends loading and running scripts.
 */
function ppShowBlockPage(tabId, domain, url) {
  ppRememberReturn(tabId, domain, url);
  return chrome.tabs.update(tabId, { url: PP_BLOCKED_PAGE }).catch(() => {});
}

/**
 * Decide and act on a navigation.
 *
 * Only top-level navigations are considered. A locked site inside an iframe is
 * stopped by the block rule, which is the right place for it: taking the whole
 * tab away from a page the user is allowed to be on, because something on it
 * embedded a locked domain, would be a worse outcome than the one being
 * prevented.
 */
async function ppHandleNavigation(details) {
  if (details.frameId !== 0) return;
  if (!ppState.setupComplete) await ppReady; // cold worker; normally a no-op
  const decision = ppDecideNavigation(ppState, details.url, Date.now());
  if (!decision.block) return;
  return ppShowBlockPage(details.tabId, decision.domain, details.url);
}

chrome.webNavigation.onBeforeNavigate.addListener(ppHandleNavigation, {
  url: [{ schemes: ["http", "https"] }],
});

/* A single-page app changes route without issuing a navigation request, so
 * onBeforeNavigate never fires and no rule is consulted. This is the event
 * that does fire. It matters when a domain is locked, or an unlock expires,
 * while the user is already sitting on it. */
chrome.webNavigation.onHistoryStateUpdated.addListener(ppHandleNavigation, {
  url: [{ schemes: ["http", "https"] }],
});

/**
 * Send any tab already sitting on `domain` to the block page.
 *
 * Locking a site used to purge its cookies and leave the open tabs exactly
 * where they were, fully rendered and fully interactive — so locking
 * facebook.com while facebook.com was open did nothing at all until the next
 * navigation.
 */
async function ppRedirectOpenTabs(domain) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab || !tab.url || typeof tab.id !== "number") return;
        let hostname;
        try {
          const parsed = new URL(tab.url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
          hostname = parsed.hostname.toLowerCase();
        } catch (e) {
          return;
        }
        if (!ppHostMatchesDomain(hostname, domain)) return;
        return ppShowBlockPage(tab.id, domain, tab.url);
      })
    );
  } catch (e) {
    console.warn("PrivatePages: could not redirect open tabs:", e);
  }
}

/* -------------------------------------------------------------------- */
/* Install / startup                                                     */
/* -------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  await ppEnsureAlarm();
  await ppReady;
  await ppSyncBlockRules();
  if (details.reason === "install") {
    const { setupComplete } = await ppGetLocal({ setupComplete: false });
    if (!setupComplete) {
      chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ppEnsureAlarm();
  await ppReady;
  /* storage.session is wiped on browser restart, so every temporary unlock is
   * gone and every locked domain is locked again. Rebuild from that. */
  await ppSyncBlockRules();
});

/* -------------------------------------------------------------------- */
/* Messaging API used by popup / options / setup / blocked pages         */
/* -------------------------------------------------------------------- */

async function ppHandleMessage(msg, sender) {
  const action = msg && msg.action;

  /* THE LOCKOUT IS ENFORCED HERE, ONCE, FOR EVERY ACTION THAT CHECKS A
   * SECRET. It used to be enforced inside individual handlers, which meant it
   * was enforced on two of the six — and not on unlockDomainTemporary, the one
   * the block page calls, which is where guesses actually happen. The block
   * page would display "Too many attempts, try again in 27s" while the service
   * worker went on verifying every PIN submitted to it. Any new action that
   * verifies a secret must be added to PP_SECRET_VERIFYING_ACTIONS in
   * lib/policy.js; putting the check in one place is what makes that the only
   * thing there is to remember. */
  if (ppActionVerifiesSecret(action)) {
    const lockoutRemaining = await ppCheckLockout();
    if (lockoutRemaining > 0) return ppLockoutResponse(lockoutRemaining);
  }

  switch (action) {
    case "getSetupStatus": {
      const { setupComplete = false } = await ppGetLocal({ setupComplete: false });
      return { setupComplete };
    }

    case "setupPin": {
      const { setupComplete = false } = await ppGetLocal({ setupComplete: false });
      if (setupComplete) return { ok: false, error: "Already set up." };
      if (!/^\d{6}$/.test(msg.pin)) return { ok: false, error: "PIN must be exactly 6 digits." };
      const pinRecord = await ppHashSecret(msg.pin);
      const recoveryKey = ppGenerateRecoveryKey();
      const recoveryRecord = await ppHashSecret(ppNormalizeRecoveryKey(recoveryKey));
      await ppSetLocal({
        pinRecord,
        recoveryRecord,
        setupComplete: true,
        lockedSites: [],
        failedAttempts: 0,
        lockoutUntil: 0,
      });
      return { ok: true, recoveryKey };
    }

    case "verifyPin": {
      const { pinRecord } = await ppGetLocal({ pinRecord: null });
      if (!(await ppVerifySecret(msg.pin, pinRecord))) return ppFailedAttemptResponse();
      await ppRecordSuccess();
      return { ok: true };
    }

    case "changePin": {
      const { pinRecord } = await ppGetLocal({ pinRecord: null });
      if (!(await ppVerifySecret(msg.oldPin, pinRecord))) {
        return ppFailedAttemptResponse("Current PIN is incorrect.");
      }
      if (!/^\d{6}$/.test(msg.newPin)) return { ok: false, error: "New PIN must be exactly 6 digits." };
      const newRecord = await ppHashSecret(msg.newPin);
      await ppSetLocal({ pinRecord: newRecord });
      await ppRecordSuccess();
      return { ok: true };
    }

    case "useRecoveryKey": {
      const { recoveryRecord } = await ppGetLocal({ recoveryRecord: null });
      const normalized = ppNormalizeRecoveryKey(msg.key);
      if (!(await ppVerifySecret(normalized, recoveryRecord))) {
        return ppFailedAttemptResponse("Recovery key is incorrect.");
      }
      /* The key checked out, so the attempt counter is cleared even if the new
       * PIN turns out to be malformed — the person holding the recovery key is
       * the owner, and a typo in the replacement PIN should not count against
       * them. The key itself is only spent once a replacement is actually
       * stored, below. */
      await ppRecordSuccess();
      if (!/^\d{6}$/.test(msg.newPin)) return { ok: false, error: "New PIN must be exactly 6 digits." };
      const newPinRecord = await ppHashSecret(msg.newPin);
      const newRecoveryKey = ppGenerateRecoveryKey();
      const newRecoveryRecord = await ppHashSecret(ppNormalizeRecoveryKey(newRecoveryKey));
      await ppSetLocal({ pinRecord: newPinRecord, recoveryRecord: newRecoveryRecord });
      return { ok: true, recoveryKey: newRecoveryKey };
    }

    case "regenerateRecoveryKey": {
      const { pinRecord } = await ppGetLocal({ pinRecord: null });
      if (!(await ppVerifySecret(msg.pin, pinRecord))) return ppFailedAttemptResponse("PIN is incorrect.");
      const newRecoveryKey = ppGenerateRecoveryKey();
      const newRecoveryRecord = await ppHashSecret(ppNormalizeRecoveryKey(newRecoveryKey));
      await ppSetLocal({ recoveryRecord: newRecoveryRecord });
      await ppRecordSuccess();
      return { ok: true, recoveryKey: newRecoveryKey };
    }

    case "getLockedSites": {
      const lockedSites = await ppGetLockedSites();
      return { lockedSites };
    }

    case "lockDomain": {
      /* Locking needs no PIN — making it harder to protect a site than to stop
       * protecting one would be backwards. Unlocking is what needs the PIN. */
      const domain = ppNormalizeDomainInput(msg.domain);
      if (!domain) return { ok: false, error: "Enter a valid domain, e.g. facebook.com" };
      const lockedSites = await ppGetLockedSites();
      if (!lockedSites.includes(domain)) {
        lockedSites.push(domain);
        await ppSetLocal({ lockedSites });
      }
      ppState.lockedSites = lockedSites;

      /* A standing temporary unlock would otherwise survive re-locking, so the
       * site would stay reachable for the rest of its five minutes. */
      const unlockMap = await ppGetUnlockMap();
      if (unlockMap[domain]) {
        delete unlockMap[domain];
        await ppSetUnlockMap(unlockMap);
        ppState.unlockMap = unlockMap;
      }

      await ppSyncBlockRules();
      await ppRedirectOpenTabs(domain);
      ppPurgeDomain(domain);
      return { ok: true, lockedSites };
    }

    case "unlockDomainPermanent": {
      const { pinRecord } = await ppGetLocal({ pinRecord: null });
      if (!(await ppVerifySecret(msg.pin, pinRecord))) return ppFailedAttemptResponse("PIN is incorrect.");
      await ppRecordSuccess();
      const domain = ppNormalizeDomainInput(msg.domain);
      const lockedSites = (await ppGetLockedSites()).filter((d) => d !== domain);
      await ppSetLocal({ lockedSites });
      ppState.lockedSites = lockedSites;
      await ppSyncBlockRules();
      return { ok: true, lockedSites };
    }

    case "unlockDomainTemporary": {
      const { pinRecord } = await ppGetLocal({ pinRecord: null });
      if (!(await ppVerifySecret(msg.pin, pinRecord))) return ppFailedAttemptResponse();
      await ppRecordSuccess();

      /* Resolve to the domain that is actually on the locked list before using
       * it as a key. The popup unlocks whatever the active tab is on, which on
       * `m.facebook.com` is `m.facebook.com` — but every lookup, here and in
       * ppDecideNavigation, is by the canonical locked domain. Keying the map
       * by the host instead wrote an entry nothing would ever read: the popup
       * said "unlocked", and the next navigation was blocked exactly as
       * before. */
      const requested = ppNormalizeDomainInput(msg.domain);
      const domain = ppFindMatchingLockedDomain(requested, await ppGetLockedSites());
      if (!domain) {
        /* Nothing to unlock. The PIN was right, so this is not a failed
         * attempt — it is a request about a site that is not locked. */
        return { ok: true, unlockedUntil: null };
      }

      const minutes = Number(msg.minutes) > 0 ? Number(msg.minutes) : DEFAULT_TEMP_UNLOCK_MINUTES;
      const map = await ppGetUnlockMap();
      map[domain] = Date.now() + minutes * 60 * 1000;
      await ppSetUnlockMap(map);
      ppState.unlockMap = map;
      await ppSyncBlockRules();
      return { ok: true, unlockedUntil: map[domain] };
    }

    case "getBlockedReturn": {
      /* Where this tab was headed when it was blocked. Keyed by tab id and
       * read from the sender's own tab, so one tab cannot ask about another. */
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== "number") return { domain: null, url: null };
      let entry = ppBlockedReturn[String(tabId)];
      if (!entry) {
        /* Not in memory: this worker has been torn down and restarted since
         * the tab was blocked, which is entirely normal in MV3. */
        const { blockedReturn = {} } = await chrome.storage.session.get({ blockedReturn: {} });
        entry = blockedReturn[String(tabId)];
        if (entry) ppBlockedReturn[String(tabId)] = entry;
      }
      return entry ? { domain: entry.domain, url: entry.url } : { domain: null, url: null };
    }

    case "getActiveTabDomain": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return { domain: null };
      let hostname = null;
      try {
        const parsed = new URL(tab.url);
        /* chrome://extensions parses, and its "hostname" is `extensions` —
         * which the popup would then offer to lock, and which nothing could
         * ever match. Only web pages have a domain worth locking. */
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          hostname = parsed.hostname.toLowerCase();
        }
      } catch (e) {}
      return { domain: hostname ? ppNormalizeDomainInput(hostname) : null, url: tab.url };
    }

    default:
      return { ok: false, error: "Unknown action: " + String(action) };
  }
}

/** Record a miss and describe it the same way for every caller. */
async function ppFailedAttemptResponse(error) {
  const { lockoutUntil } = await ppRecordFailedAttempt();
  const lockoutRemaining = Math.max(0, lockoutUntil - Date.now());
  const res = { ok: false, lockedOut: lockoutRemaining > 0, lockoutRemaining };
  if (error) res.error = error;
  return res;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ppHandleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // async response
});
