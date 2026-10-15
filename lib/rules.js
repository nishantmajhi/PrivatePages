/**
 * PrivatePages - rules.js
 *
 * Turns the locked-sites list into declarativeNetRequest rules.
 *
 * WHY THERE ARE RULES AT ALL. `chrome.webNavigation.onBeforeNavigate` is an
 * observer: it is told that a navigation is starting, it cannot stop one.
 * Manifest V3 removed the blocking form of `webRequest` precisely so that
 * extensions could not sit in the middle of every request, and gave them
 * declarativeNetRequest instead — rules handed to the browser in advance and
 * evaluated in the network stack, before the request leaves. That is the only
 * mechanism here that actually stops a locked page from loading. It also keeps
 * working while the service worker is asleep, which matters, because an MV3
 * worker is asleep most of the time and a navigation is exactly the kind of
 * event that arrives before it has finished waking up.
 *
 * WHY `block` AND NOT `redirect`. A redirect rule would land the user straight
 * on blocked.html with no flicker, but redirecting to an extension page
 * requires listing that page in `web_accessible_resources`, which makes it
 * reachable — and probeable — by every website. Blocking the request costs a
 * moment of Chrome's own error page in the rare case the service worker loses
 * the race, and costs nothing at all the rest of the time, because the
 * navigation handler has normally already swapped the tab to blocked.html. A
 * lost race shows an ugly page; it does not show the locked site.
 *
 * Loaded as a plain script; the module.exports tail is for the test runner.
 */

/* Dynamic rule ids are ours to choose, but they persist across service-worker
 * restarts and across extension updates, so they have to be picked from a
 * range we can recognise and clear wholesale. */
const PP_RULE_ID_BASE = 1;

/* Blocking is scoped to documents. Blocking every resource type would also
 * strip a locked site's images and fonts out of unrelated pages that embed
 * them, which is a different and much broader promise than the one the README
 * makes. `sub_frame` is included so a locked site cannot be reached by putting
 * it in an iframe — the hole the old frameId check left open. */
const PP_BLOCKED_RESOURCE_TYPES = ["main_frame", "sub_frame"];

/* Chrome caps how many dynamic rules an extension may hold. A personal
 * blocklist will not come close, but silently dropping domains past the cap
 * would be a hole, so the cap is explicit and the overflow is reported. The
 * navigation handler still covers anything that overflows — advisory rather
 * than enforced, which is the old behaviour, not a new failure. */
const PP_MAX_BLOCK_RULES = 4000;

/**
 * The rule set for a given state, at a given moment.
 *
 * `state` is `{ lockedSites, unlockMap, setupComplete }`. Domains holding an
 * unexpired temporary unlock get no rule, which is how an unlock takes effect
 * at the network level; the caller is responsible for rebuilding when that
 * unlock expires.
 *
 * Nothing is blocked before setup is complete, for the same reason
 * ppDecideNavigation does not block then: there would be no way back in.
 */
function ppBuildBlockRules(state, now) {
  if (!state || !state.setupComplete) return [];
  const domains = ppEffectivelyLocked(state, now).slice(0, PP_MAX_BLOCK_RULES);
  return domains.map((domain, i) => ({
    id: PP_RULE_ID_BASE + i,
    priority: 1,
    action: { type: "block" },
    condition: {
      /* requestDomains matches the domain and every subdomain of it, and
       * nothing else — the same rule ppHostMatchesDomain implements, enforced
       * by the browser rather than by us. In particular it does not match
       * `notfacebook.com` or `facebook.com.evil.example`. */
      requestDomains: [domain],
      resourceTypes: PP_BLOCKED_RESOURCE_TYPES.slice(),
    },
  }));
}

/** How many locked domains did not fit under the cap. */
function ppBlockRuleOverflow(state, now) {
  if (!state || !state.setupComplete) return 0;
  return Math.max(0, ppEffectivelyLocked(state, now).length - PP_MAX_BLOCK_RULES);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PP_RULE_ID_BASE,
    PP_BLOCKED_RESOURCE_TYPES,
    PP_MAX_BLOCK_RULES,
    ppBuildBlockRules,
    ppBlockRuleOverflow,
  };
}
