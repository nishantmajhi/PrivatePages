/* Blocking: deciding it, enforcing it, and not losing the race.
 *
 * node --test tests/
 *
 * The original code decided whether to block inside an
 * `onBeforeNavigate` handler, after three sequential awaits on
 * `chrome.storage`. `onBeforeNavigate` is an observer — it cannot hold a
 * request — so by the time those awaits resolved the locked page was already
 * on its way and often already running scripts. These tests pin down three
 * separate things:
 *
 *   1. the decision itself, as a pure function of state (policy.js);
 *   2. that the decision is reached from memory, without awaiting storage;
 *   3. that a declarativeNetRequest rule is in place, so the block holds even
 *      when the service worker is asleep and no handler runs at all.
 *
 * (3) is the one that matters. (1) and (2) make the block page appear instead
 * of Chrome's error page; (3) is what actually stops the bytes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, loadLib, seededLocal } = require("./harness.js");

const BLOCKED_PAGE = "chrome-extension://ppfake/blocked.html";

/** Let the worker's own startup priming settle before asserting on it. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/* ── The decision, as a pure function ────────────────────────────────── */

test("ppDecideNavigation blocks a locked domain and its subdomains", () => {
  const { ppDecideNavigation } = loadLib("domain.js", "policy.js");
  const state = { lockedSites: ["facebook.com"], unlockMap: {}, setupComplete: true };
  const now = 1000;

  for (const url of [
    "https://facebook.com/",
    "https://www.facebook.com/",
    "https://m.facebook.com/feed",
    "https://business.facebook.com/x?y=z",
    "http://facebook.com:8080/",
  ]) {
    assert.equal(ppDecideNavigation(state, url, now).block, true, url);
  }
});

test("ppDecideNavigation leaves lookalike domains alone", () => {
  const { ppDecideNavigation } = loadLib("domain.js", "policy.js");
  const state = { lockedSites: ["facebook.com"], unlockMap: {}, setupComplete: true };

  for (const url of [
    "https://notfacebook.com/",
    "https://facebook.com.evil.example/",
    "https://xfacebook.com/",
    "https://example.com/facebook.com",
  ]) {
    assert.equal(ppDecideNavigation(state, url, 1000).block, false, url);
  }
});

test("ppDecideNavigation does not block before setup, or while unlocked", () => {
  const { ppDecideNavigation } = loadLib("domain.js", "policy.js");
  const locked = ["facebook.com"];

  assert.equal(
    ppDecideNavigation({ lockedSites: locked, unlockMap: {}, setupComplete: false }, "https://facebook.com/", 1000).block,
    false,
    "nothing should be blocked before a PIN exists — there would be no way back in"
  );
  assert.equal(
    ppDecideNavigation(
      { lockedSites: locked, unlockMap: { "facebook.com": 5000 }, setupComplete: true },
      "https://facebook.com/",
      1000
    ).block,
    false,
    "an unexpired temporary unlock should let the page through"
  );
  assert.equal(
    ppDecideNavigation(
      { lockedSites: locked, unlockMap: { "facebook.com": 500 }, setupComplete: true },
      "https://facebook.com/",
      1000
    ).block,
    true,
    "an expired temporary unlock should not"
  );
});

test("ppDecideNavigation ignores things that are not http(s) URLs", () => {
  const { ppDecideNavigation } = loadLib("domain.js", "policy.js");
  const state = { lockedSites: ["facebook.com"], unlockMap: {}, setupComplete: true };

  for (const url of ["", "not a url", "about:blank", "chrome://extensions", "javascript:0"]) {
    assert.equal(ppDecideNavigation(state, url, 1000).block, false, JSON.stringify(url));
  }
});

/* ── Enforcement: declarativeNetRequest ──────────────────────────────── */

test("locking a domain installs a network-level block rule for it", async () => {
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  const rules = h.getDynamicRules();
  assert.equal(rules.length, 1, "expected exactly one rule for one locked domain");
  const [rule] = rules;
  assert.equal(rule.action.type, "block");
  assert.deepEqual(rule.condition.requestDomains, ["facebook.com"]);
  assert.deepEqual(rule.condition.resourceTypes.sort(), ["main_frame", "sub_frame"]);
});

test("the block rule covers sub-frames, so a locked site cannot be iframed in", async () => {
  /* The old handler returned early on `details.frameId !== 0`, so embedding a
   * locked site in an iframe rendered it normally. A request-level rule has no
   * such hole as long as sub_frame is in its resource types. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  const rules = h.getDynamicRules();
  assert.ok(rules.length > 0, "a domain locked before startup should still get a rule");
  assert.ok(rules.every((r) => r.condition.resourceTypes.includes("sub_frame")));
});

test("a temporary unlock removes the rule, and its expiry brings it back", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();
  assert.equal(h.getDynamicRules().length, 1);

  await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  await settle();
  assert.equal(h.getDynamicRules().length, 0, "an unlocked domain should not be blocked in the network stack");

  /* Expire it by hand and run the sweep the alarm runs. */
  await h.storage.session.set({ unlockedUntil: { "facebook.com": Date.now() - 1 } });
  await h.events.onAlarm.emit({ name: "pp-purge-locked" });
  await settle();

  assert.equal(h.getDynamicRules().length, 1, "the rule should return when the unlock expires");
});

test("removing a domain permanently removes its rule", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.send({ action: "unlockDomainPermanent", domain: "facebook.com", pin: "123456" });
  await settle();

  assert.deepEqual(h.getDynamicRules(), []);
});

test("rule ids are reused rather than accumulating", async () => {
  /* Dynamic rules persist across service-worker restarts and there is a hard
   * cap on how many an extension may hold. Rebuilding the set must replace it,
   * not append to it, or a few hundred lock/unlock cycles exhaust the quota. */
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  for (let i = 0; i < 5; i++) {
    await h.send({ action: "lockDomain", domain: `site${i}.example` });
    await settle();
  }

  const rules = h.getDynamicRules();
  assert.equal(rules.length, 5);
  assert.equal(new Set(rules.map((r) => r.id)).size, 5, "rule ids must be unique");
  assert.ok(
    rules.every((r) => Number.isInteger(r.id) && r.id > 0),
    "DNR rule ids must be positive integers"
  );
});

/* ── The navigation handler: presentation, and no storage in the path ── */

test("navigating to a locked site swaps the tab to the block page", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 7, url: "https://m.facebook.com/feed" });
  await settle();

  assert.equal(h.calls.tabUpdates.length, 1);
  assert.equal(h.calls.tabUpdates[0].tabId, 7);
  assert.ok(h.calls.tabUpdates[0].url.startsWith(BLOCKED_PAGE));
});

test("the block page URL does not carry the page you were visiting", async () => {
  /* The original put the full original URL in the query string, which put the
   * path and query of the locked page into the tab's address bar and into
   * history — visible to anyone glancing at the screen, which is the exact
   * thing the extension exists to prevent. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onBeforeNavigate.emit({
    frameId: 0,
    tabId: 7,
    url: "https://facebook.com/messages/t/some-private-thread",
  });
  await settle();

  const shown = h.calls.tabUpdates[0].url;
  assert.ok(!shown.includes("some-private-thread"), `leaked the path: ${shown}`);
  assert.ok(!shown.includes("messages"), `leaked the path: ${shown}`);

  /* It has to be kept somewhere, or the block page cannot send you back. */
  const back = await h.send({ action: "getBlockedReturn" }, { tab: { id: 7 } });
  assert.equal(back.url, "https://facebook.com/messages/t/some-private-thread");
  assert.equal(back.domain, "facebook.com");
});

test("the navigation handler decides without awaiting storage", async () => {
  /* This is the race, stated as a test.
   *
   * Storage is made to hang — every read returns a promise that never settles.
   * That is not a thing Chrome does, but it is the sharp version of a thing
   * Chrome does constantly: storage reads take time, and onBeforeNavigate
   * cannot hold the request while they do. If the redirect still happens with
   * storage stopped dead, then nothing between the event arriving and the tab
   * being taken away is waiting on it. If it does not, there is an await on
   * that path, and in production that await is measured against a page that is
   * already loading. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  const never = () => new Promise(() => {});
  h.chrome.storage.local.get = never;
  h.chrome.storage.session.get = never;

  /* Not awaited: a handler that does wait on storage never returns here, and
   * the point of the test is to notice that rather than to hang on it. */
  h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 3, url: "https://facebook.com/" });
  await settle();

  assert.equal(h.calls.tabUpdates.length, 1, "the redirect waited on storage");
  assert.equal(h.calls.tabUpdates[0].tabId, 3);
});

test("the in-memory view follows storage changes made elsewhere", async () => {
  /* Two extension pages can be open at once, and options.js writes the locked
   * list through its own message. The cached copy has to track that or it goes
   * stale the first time anything else writes. */
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  await h.storage.local.set({ lockedSites: ["facebook.com"] });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 3, url: "https://facebook.com/" });
  await settle();

  assert.equal(h.calls.tabUpdates.length, 1);
});

test("in-page navigations on a locked domain are caught too", async () => {
  /* A single-page app changes route without a network request, so
   * onBeforeNavigate never fires. onHistoryStateUpdated does. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onHistoryStateUpdated.emit({ frameId: 0, tabId: 4, url: "https://facebook.com/feed" });
  await settle();

  assert.equal(h.calls.tabUpdates.length, 1);
  assert.ok(h.calls.tabUpdates[0].url.startsWith(BLOCKED_PAGE));
});

test("a sub-frame navigation does not hijack the whole tab", async () => {
  /* The request-level rule blocks the frame. Redirecting the top-level tab
   * because of an iframe would take the user off a page they are allowed to
   * be on. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 3, tabId: 5, url: "https://facebook.com/plugins/like" });
  await settle();

  assert.deepEqual(h.calls.tabUpdates, []);
});

test("the block page is not redirected to itself", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 6, url: BLOCKED_PAGE });
  await settle();

  assert.deepEqual(h.calls.tabUpdates, []);
});

/* ── Tabs that are already open when a domain is locked ──────────────── */

test("locking a domain redirects tabs already sitting on it", async () => {
  /* Locking facebook.com while facebook.com is open in three tabs used to
   * purge its cookies and leave the pages on screen, fully interactive. */
  const h = loadBackground({ local: await seededLocal() });
  h.setTabs([
    { id: 1, url: "https://facebook.com/feed", active: true },
    { id: 2, url: "https://m.facebook.com/", active: false },
    { id: 3, url: "https://example.com/", active: false },
    { id: 4, url: "chrome://extensions", active: false },
  ]);
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  const redirected = h.calls.tabUpdates.map((u) => u.tabId).sort();
  assert.deepEqual(redirected, [1, 2], "expected the two facebook tabs and nothing else");
  assert.ok(h.calls.tabUpdates.every((u) => u.url.startsWith(BLOCKED_PAGE)));
});

test("locking a domain does not disturb tabs on other sites", async () => {
  const h = loadBackground({ local: await seededLocal() });
  h.setTabs([{ id: 1, url: "https://example.com/", active: true }]);
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  assert.deepEqual(h.calls.tabUpdates, []);
});

/* ── Domain normalisation on the way in ──────────────────────────────── */

test("a domain is stored canonically however it was typed", async () => {
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  for (const typed of ["FaceBook.com", "www.facebook.com", "https://www.facebook.com/x?y=1", "facebook.com:443"]) {
    await h.storage.local.set({ lockedSites: [] });
    const res = await h.send({ action: "lockDomain", domain: typed });
    assert.deepEqual(res.lockedSites, ["facebook.com"], typed);
  }
});

test("garbage is refused rather than stored", async () => {
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  for (const typed of ["", "   ", "http://"]) {
    const res = await h.send({ action: "lockDomain", domain: typed });
    assert.equal(res.ok, false, JSON.stringify(typed));
  }
  assert.deepEqual(h.storage.local._dump().lockedSites, []);
});

test("locking the same domain twice does not duplicate it", async () => {
  const h = loadBackground({ local: await seededLocal() });
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  const res = await h.send({ action: "lockDomain", domain: "www.facebook.com" });

  assert.deepEqual(res.lockedSites, ["facebook.com"]);
});
