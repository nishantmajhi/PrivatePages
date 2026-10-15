/* Hostname matching in lib/domain.js.
 *
 * node --test tests/
 *
 * Everything else in the extension asks this file one question: is this
 * hostname covered by a domain on the list? Get it slightly wrong in one
 * direction and a locked site is reachable; slightly wrong in the other and
 * an unrelated site is blocked and has its cookies deleted. Both failures are
 * silent, so the suffix cases below are worth more than their line count
 * suggests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadLib } = require("./harness.js");

const D = loadLib("domain.js");

/* ── Normalising what the user typed ─────────────────────────────────── */

test("a bare domain is already canonical", () => {
  assert.equal(D.ppNormalizeDomainInput("facebook.com"), "facebook.com");
});

test("case, whitespace, scheme, port, path and www. are all stripped", () => {
  const cases = {
    "FACEBOOK.COM": "facebook.com",
    "  facebook.com  ": "facebook.com",
    "www.facebook.com": "facebook.com",
    "WWW.Facebook.com": "facebook.com",
    "https://facebook.com": "facebook.com",
    "https://www.facebook.com/profile.php?id=1": "facebook.com",
    "http://facebook.com:8080/x": "facebook.com",
    "facebook.com/profile.php": "facebook.com",
    "facebook.com:443": "facebook.com",
  };

  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(D.ppNormalizeDomainInput(input), expected, input);
  }
});

test("only a leading www. is stripped, and only once", () => {
  assert.equal(D.ppNormalizeDomainInput("m.facebook.com"), "m.facebook.com");
  assert.equal(D.ppNormalizeDomainInput("www.www.facebook.com"), "www.facebook.com");
  assert.equal(D.ppNormalizeDomainInput("wwwfacebook.com"), "wwwfacebook.com");
});

test("input that is not a hostname comes back empty", () => {
  for (const input of ["", "   ", null, undefined, "http://", "https://", "///"]) {
    assert.equal(D.ppNormalizeDomainInput(input), "", JSON.stringify(input));
  }
});

/* ── Matching a hostname against a locked domain ─────────────────────── */

test("a locked domain matches itself and any subdomain", () => {
  for (const host of [
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "business.facebook.com",
    "a.b.c.facebook.com",
  ]) {
    assert.equal(D.ppHostMatchesDomain(host, "facebook.com"), true, host);
  }
});

test("a locked domain does not match a domain that merely ends with its name", () => {
  /* The failure mode a naive `endsWith` produces. `notfacebook.com` ends with
   * `facebook.com`; it is a different site owned by different people. */
  for (const host of ["notfacebook.com", "xfacebook.com", "myfacebook.com"]) {
    assert.equal(D.ppHostMatchesDomain(host, "facebook.com"), false, host);
  }
});

test("a locked domain does not match a site that has put its name in front", () => {
  /* The other direction: anyone can register `facebook.com.evil.example` and
   * a front-anchored match would let it through — or, worse, a broad match
   * would block a legitimate site whose name happens to contain another. */
  for (const host of ["facebook.com.evil.example", "facebook.com.au"]) {
    assert.equal(D.ppHostMatchesDomain(host, "facebook.com"), false, host);
  }
});

test("matching is case-insensitive in both arguments", () => {
  assert.equal(D.ppHostMatchesDomain("WWW.FaceBook.COM", "facebook.com"), true);
  assert.equal(D.ppHostMatchesDomain("www.facebook.com", "FACEBOOK.COM"), true);
});

test("empty arguments match nothing", () => {
  assert.equal(D.ppHostMatchesDomain("", "facebook.com"), false);
  assert.equal(D.ppHostMatchesDomain("facebook.com", ""), false);
  assert.equal(D.ppHostMatchesDomain(null, null), false);
});

test("a subdomain can be locked on its own without locking the parent", () => {
  assert.equal(D.ppHostMatchesDomain("m.facebook.com", "m.facebook.com"), true);
  assert.equal(D.ppHostMatchesDomain("facebook.com", "m.facebook.com"), false);
  assert.equal(D.ppHostMatchesDomain("www.facebook.com", "m.facebook.com"), false);
});

/* ── Finding the match in a list ─────────────────────────────────────── */

test("the matching domain is returned, not just a boolean", () => {
  /* Callers need the canonical domain: it is the key the unlock map and the
   * purge are both indexed by. */
  const list = ["reddit.com", "facebook.com"];

  assert.equal(D.ppFindMatchingLockedDomain("m.facebook.com", list), "facebook.com");
  assert.equal(D.ppFindMatchingLockedDomain("old.reddit.com", list), "reddit.com");
  assert.equal(D.ppFindMatchingLockedDomain("example.com", list), null);
});

test("a missing or malformed list matches nothing", () => {
  assert.equal(D.ppFindMatchingLockedDomain("facebook.com", null), null);
  assert.equal(D.ppFindMatchingLockedDomain("facebook.com", undefined), null);
  assert.equal(D.ppFindMatchingLockedDomain("facebook.com", []), null);
  assert.equal(D.ppFindMatchingLockedDomain("", ["facebook.com"]), null);
});

test("hostnames are extracted from whole URLs the same way", () => {
  assert.equal(D.ppExtractHostname("https://m.facebook.com/feed"), "m.facebook.com");
  assert.equal(D.ppExtractHostname("m.facebook.com"), "m.facebook.com");
  assert.equal(D.ppExtractHostname("M.FaceBook.com:99/x"), "m.facebook.com");
  assert.equal(D.ppExtractHostname(""), "");
});
