/**
 * PrivatePages - domain.js
 * Strict domain matching: locking "facebook.com" blocks facebook.com,
 * www.facebook.com, m.facebook.com, business.facebook.com/anything, etc.
 * Matching is on hostname only, so any path/query under the domain is
 * automatically covered - there is nothing extra to do for "facebook.com/profile.php".
 */

/**
 * Extract a lowercased hostname (no port) from either a bare domain
 * ("facebook.com"), a domain with a leading www., or a full URL.
 */
function ppExtractHostname(input) {
  if (!input) return "";
  let str = input.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str)) {
    str = "http://" + str;
  }
  try {
    const url = new URL(str);
    return url.hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

/**
 * Normalize a user-entered site (URL or bare domain) into the canonical
 * form we store in the locked list: lowercase, no leading "www.", no port,
 * no path.
 */
function ppNormalizeDomainInput(input) {
  const hostname = ppExtractHostname(input);
  if (!hostname) return "";
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/**
 * True if `hostname` is the locked domain itself or any subdomain of it
 * (front match), regardless of path (back match is implicit - path is not
 * part of hostname matching at all).
 */
function ppHostMatchesDomain(hostname, lockedDomain) {
  if (!hostname || !lockedDomain) return false;
  const h = hostname.toLowerCase();
  const d = lockedDomain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

/**
 * True if `hostname` matches any domain in `lockedList`.
 * Returns the matched canonical domain, or null.
 */
function ppFindMatchingLockedDomain(hostname, lockedList) {
  if (!hostname || !Array.isArray(lockedList)) return null;
  for (const domain of lockedList) {
    if (ppHostMatchesDomain(hostname, domain)) return domain;
  }
  return null;
}

/** A handful of common subdomain variants worth pre-clearing cache for, best-effort. */
function ppCommonVariantOrigins(domain) {
  const variants = ["", "www.", "m.", "mobile.", "web."];
  const origins = [];
  for (const v of variants) {
    origins.push(`https://${v}${domain}`);
    origins.push(`http://${v}${domain}`);
  }
  return origins;
}

/**
 * The origins a purge of `domain` should cover.
 *
 * There is an asymmetry in Chrome's APIs that this function exists to narrow.
 * `chrome.cookies` matches a domain and all its subdomains, the same way
 * `ppHostMatchesDomain` does. `chrome.browsingData` does not: it takes a list
 * of exact origins and has no wildcard, so there is no way to say "clear
 * localStorage for facebook.com and everything under it". The original code
 * guessed five common subdomains and stopped there, which left
 * `business.facebook.com` holding its localStorage, its IndexedDB and its
 * service worker indefinitely, while the blocking rule went on treating it as
 * locked.
 *
 * Guesses cannot be made complete, so this adds the hostnames the browser has
 * actually seen — `observedHosts` comes from the cookie jar for this domain.
 * Those are subdomains this profile has really talked to, which is exactly the
 * set whose storage is worth clearing. Anything outside the locked domain is
 * discarded: this list is handed to `browsingData.remove`, and clearing an
 * unrelated site's storage because its name turned up nearby would be a real
 * bug, not a conservative one.
 */
function ppOriginsToPurge(domain, observedHosts) {
  const origins = ppCommonVariantOrigins(domain);
  for (const raw of observedHosts || []) {
    const host = (raw || "").replace(/^\./, "").toLowerCase();
    if (!ppHostMatchesDomain(host, domain)) continue;
    origins.push(`https://${host}`);
    origins.push(`http://${host}`);
  }
  return Array.from(new Set(origins));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ppExtractHostname,
    ppNormalizeDomainInput,
    ppHostMatchesDomain,
    ppFindMatchingLockedDomain,
    ppCommonVariantOrigins,
    ppOriginsToPurge,
  };
}
