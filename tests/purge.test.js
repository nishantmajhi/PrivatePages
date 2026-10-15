/* Cookie and storage purging for locked sites.
 *
 * node --test tests/
 *
 * The extension cannot run code after it is uninstalled — Chrome has no such
 * hook — so instead it keeps locked sites logged out while it is installed.
 * That only works if the purge actually covers the hostnames the blocking rule
 * covers. It did not: blocking matched any subdomain, while the storage purge
 * enumerated a fixed list of five guesses, so `business.facebook.com` kept its
 * localStorage and its IndexedDB indefinitely.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, loadLib, seededLocal } = require("./harness.js");

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/* ── Which origins a purge should cover ──────────────────────────────── */

test("ppOriginsToPurge covers the bare domain and the common variants", () => {
  const { ppOriginsToPurge } = loadLib("domain.js");

  const origins = ppOriginsToPurge("facebook.com", []);

  for (const host of ["facebook.com", "www.facebook.com", "m.facebook.com"]) {
    assert.ok(origins.includes(`https://${host}`), `missing https://${host}`);
    assert.ok(origins.includes(`http://${host}`), `missing http://${host}`);
  }
});

test("ppOriginsToPurge picks up subdomains that were actually observed", () => {
  /* The guessed list can never be complete. Hostnames seen in the cookie jar
   * are not guesses — they are subdomains this browser has really talked to,
   * which is exactly the set whose storage is worth clearing. */
  const { ppOriginsToPurge } = loadLib("domain.js");

  const origins = ppOriginsToPurge("facebook.com", ["business.facebook.com", ".developers.facebook.com"]);

  assert.ok(origins.includes("https://business.facebook.com"));
  assert.ok(origins.includes("https://developers.facebook.com"), "a leading dot should be stripped");
});

test("ppOriginsToPurge refuses hostnames outside the domain", () => {
  /* An observed hostname reaches this function from the cookie jar, and the
   * result is handed to browsingData.remove. Clearing another site's storage
   * because its name happened to be in the list would be a real bug. */
  const { ppOriginsToPurge } = loadLib("domain.js");

  const origins = ppOriginsToPurge("facebook.com", [
    "evil.example",
    "facebook.com.evil.example",
    "notfacebook.com",
  ]);

  assert.ok(!origins.some((o) => o.includes("evil.example")), origins.join(" "));
  assert.ok(!origins.some((o) => o.includes("notfacebook")), origins.join(" "));
});

test("ppOriginsToPurge does not repeat itself", () => {
  const { ppOriginsToPurge } = loadLib("domain.js");

  const origins = ppOriginsToPurge("facebook.com", ["www.facebook.com", "www.facebook.com", "facebook.com"]);

  assert.equal(new Set(origins).size, origins.length);
});

/* ── The purge itself ────────────────────────────────────────────────── */

test("locking a domain clears its cookies, including on subdomains", async () => {
  const h = loadBackground({ local: await seededLocal() });
  h.setCookies([
    { domain: "facebook.com", name: "a", path: "/", secure: true, storeId: "0" },
    { domain: ".facebook.com", name: "b", path: "/", secure: true, storeId: "0" },
    { domain: "business.facebook.com", name: "c", path: "/x", secure: false, storeId: "0" },
    { domain: "example.com", name: "d", path: "/", secure: true, storeId: "0" },
  ]);
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  const removed = h.calls.cookieRemovals.map((c) => c.name).sort();
  assert.deepEqual(removed, ["a", "b", "c"], "example.com's cookie should be untouched");

  const byName = Object.fromEntries(h.calls.cookieRemovals.map((c) => [c.name, c.url]));
  assert.equal(byName.a, "https://facebook.com/");
  assert.equal(byName.b, "https://facebook.com/", "a leading dot is not part of the URL");
  assert.equal(byName.c, "http://business.facebook.com/x", "an insecure cookie needs an http:// URL");
});

test("a purge clears storage for subdomains seen in the cookie jar", async () => {
  const h = loadBackground({ local: await seededLocal() });
  h.setCookies([{ domain: "business.facebook.com", name: "c", path: "/", secure: true, storeId: "0" }]);
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  const origins = h.calls.browsingDataRemovals.flatMap((r) => r.scope.origins);
  assert.ok(
    origins.includes("https://business.facebook.com"),
    "a subdomain with cookies kept its localStorage: " + origins.join(" ")
  );
});

test("a new cookie on a locked domain is removed as it is written", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onCookieChanged.emit({
    removed: false,
    cookie: { domain: ".facebook.com", name: "session", path: "/", secure: true, storeId: "0" },
  });
  await settle();

  assert.equal(h.calls.cookieRemovals.length, 1);
  assert.equal(h.calls.cookieRemovals[0].name, "session");
});

test("a new cookie on an unlocked domain is left alone", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onCookieChanged.emit({
    removed: false,
    cookie: { domain: "example.com", name: "session", path: "/", secure: true, storeId: "0" },
  });
  await settle();

  assert.deepEqual(h.calls.cookieRemovals, []);
});

test("cookies survive while the domain is temporarily unlocked", async () => {
  /* Otherwise the unlock is useless: you would be signed out of the site you
   * just proved you were allowed to visit. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();
  await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  await settle();
  h.calls.cookieRemovals.length = 0;

  await h.events.onCookieChanged.emit({
    removed: false,
    cookie: { domain: "facebook.com", name: "session", path: "/", secure: true, storeId: "0" },
  });
  await h.events.onAlarm.emit({ name: "pp-purge-locked" });
  await settle();

  assert.deepEqual(h.calls.cookieRemovals, []);
});

test("the sweep skips domains that are temporarily unlocked and purges the rest", async () => {
  const h = loadBackground({
    local: await seededLocal("123456", { lockedSites: ["facebook.com", "reddit.com"] }),
  });
  await settle();
  await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  await settle();
  h.calls.browsingDataRemovals.length = 0;

  await h.events.onAlarm.emit({ name: "pp-purge-locked" });
  await settle();

  const origins = h.calls.browsingDataRemovals.flatMap((r) => r.scope.origins);
  assert.ok(origins.some((o) => o.includes("reddit.com")));
  assert.ok(!origins.some((o) => o.includes("facebook.com")));
});

test("a cookie removal event does not trigger another removal", async () => {
  /* chrome.cookies.onChanged fires for removals as well as writes. Acting on
   * one would have the extension respond to its own purge, forever. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onCookieChanged.emit({
    removed: true,
    cookie: { domain: "facebook.com", name: "session", path: "/", secure: true, storeId: "0" },
  });
  await settle();

  assert.deepEqual(h.calls.cookieRemovals, []);
});

test("the sweep runs far less often than once a minute", async () => {
  /* Clearing cache, cacheStorage, service workers, IndexedDB and localStorage
   * across ten origins per locked domain, once a minute, forever, is real
   * battery and disk churn for what is only a backstop: the cookie listener
   * already handles the case that matters, in real time. */
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  const purge = h.calls.alarmsCreated.filter((a) => a.name === "pp-purge-locked");
  assert.ok(purge.length > 0, "the sweep alarm was never created");
  assert.ok(
    purge.every((a) => a.info.periodInMinutes >= 15),
    "expected a sweep period of at least 15 minutes, got " + JSON.stringify(purge.map((a) => a.info))
  );
});
