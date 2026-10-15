/* The message API, end to end.
 *
 * node --test tests/
 *
 * Every one of these actions is reachable from any extension page, so each is
 * an authentication boundary and each gets exercised here through
 * `chrome.runtime.onMessage` exactly as the popup, the options page and the
 * block page reach it. The lockout rules live in lockout.test.js; this file is
 * about whether the flows themselves do what they say — that a recovery key is
 * single-use, that changing a PIN actually changes it, that a temporary unlock
 * expires.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, loadConfigured, seededLocal } = require("./harness.js");

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/* ── First-run setup ─────────────────────────────────────────────────── */

test("setup stores a hash, never the PIN", async () => {
  const h = await loadConfigured("123456");

  const stored = JSON.stringify(h.storage.local._dump());
  assert.ok(!stored.includes("123456"), "the PIN is in storage in the clear");
  assert.ok(!stored.includes(h.recoveryKey.replace(/-/g, "")), "the recovery key is in storage in the clear");
  assert.ok(!stored.includes(h.recoveryKey), "the recovery key is in storage in the clear");
});

test("setup returns the recovery key exactly once", async () => {
  const h = await loadConfigured("123456");

  assert.match(h.recoveryKey, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);

  const again = await h.send({ action: "setupPin", pin: "654321" });
  assert.equal(again.ok, false, "setup ran a second time");
  assert.equal(again.recoveryKey, undefined);
});

test("setup refuses a PIN that is not six digits", async () => {
  for (const pin of ["12345", "1234567", "12345a", "", "      ", null, "12 456"]) {
    const h = loadBackground();
    const res = await h.send({ action: "setupPin", pin });
    assert.equal(res.ok, false, JSON.stringify(pin));
    assert.equal(h.storage.local._dump().setupComplete, undefined);
  }
});

test("a second setup cannot overwrite an existing PIN", async () => {
  /* setup.html is a normal extension page: anything that can open it can send
   * this message. If it were not refused, forgetting the PIN would be
   * unnecessary — you would just re-run setup. */
  const h = await loadConfigured("123456");
  const before = h.storage.local._dump().pinRecord;

  await h.send({ action: "setupPin", pin: "999999" });

  assert.deepEqual(h.storage.local._dump().pinRecord, before);
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, true);
  assert.equal((await h.send({ action: "verifyPin", pin: "999999" })).ok, false);
});

test("getSetupStatus reports what it should before and after", async () => {
  const fresh = loadBackground();
  assert.deepEqual(await fresh.send({ action: "getSetupStatus" }), { setupComplete: false });

  const done = await loadConfigured("123456");
  assert.deepEqual(await done.send({ action: "getSetupStatus" }), { setupComplete: true });
});

/* ── Changing the PIN ────────────────────────────────────────────────── */

test("changePin swaps the PIN over", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  const res = await h.send({ action: "changePin", oldPin: "123456", newPin: "654321" });

  assert.equal(res.ok, true);
  assert.equal((await h.send({ action: "verifyPin", pin: "654321" })).ok, true);
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, false);
});

test("changePin needs the current PIN", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  const res = await h.send({ action: "changePin", oldPin: "000000", newPin: "654321" });

  assert.equal(res.ok, false);
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, true, "the PIN changed anyway");
});

test("changePin rejects a malformed new PIN without changing anything", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  for (const newPin of ["1234", "abcdef", ""]) {
    const res = await h.send({ action: "changePin", oldPin: "123456", newPin });
    assert.equal(res.ok, false, JSON.stringify(newPin));
  }
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, true);
});

test("changing the PIN does not invalidate the recovery key", async () => {
  /* They are separate secrets. Someone who changes their PIN has not lost the
   * piece of paper in their desk drawer. */
  const h = loadBackground({ local: await seededLocal("123456") });

  await h.send({ action: "changePin", oldPin: "123456", newPin: "654321" });
  const res = await h.send({
    action: "useRecoveryKey",
    key: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    newPin: "111111",
  });

  assert.equal(res.ok, true);
});

/* ── The recovery key ────────────────────────────────────────────────── */

test("the recovery key resets the PIN and is then spent", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });
  const key = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";

  const first = await h.send({ action: "useRecoveryKey", key, newPin: "654321" });
  assert.equal(first.ok, true);
  assert.equal((await h.send({ action: "verifyPin", pin: "654321" })).ok, true);
  assert.match(first.recoveryKey, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
  assert.notEqual(first.recoveryKey, key);

  const second = await h.send({ action: "useRecoveryKey", key, newPin: "111111" });
  assert.equal(second.ok, false, "the old recovery key still worked");
  assert.equal((await h.send({ action: "verifyPin", pin: "654321" })).ok, true);
});

test("the replacement recovery key works", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  const first = await h.send({
    action: "useRecoveryKey",
    key: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    newPin: "654321",
  });
  const second = await h.send({ action: "useRecoveryKey", key: first.recoveryKey, newPin: "111111" });

  assert.equal(second.ok, true);
  assert.equal((await h.send({ action: "verifyPin", pin: "111111" })).ok, true);
});

test("the recovery key is accepted however it was typed", async () => {
  for (const typed of [
    "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    "aaaaa-bbbbb-ccccc-ddddd-eeeee",
    "AAAAABBBBBCCCCCDDDDDEEEEE",
    "  AAAAA BBBBB CCCCC DDDDD EEEEE  ",
  ]) {
    const h = loadBackground({ local: await seededLocal("123456") });
    const res = await h.send({ action: "useRecoveryKey", key: typed, newPin: "654321" });
    assert.equal(res.ok, true, typed);
  }
});

test("a wrong recovery key changes nothing", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  const res = await h.send({
    action: "useRecoveryKey",
    key: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ",
    newPin: "654321",
  });

  assert.equal(res.ok, false);
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, true);
});

test("a correct recovery key with a malformed new PIN leaves the old PIN working", async () => {
  /* The key is checked before the new PIN is validated, so this path bails out
   * after a successful verification. It must not half-apply: the old PIN has
   * to keep working and the recovery key must not be spent. */
  const h = loadBackground({ local: await seededLocal("123456") });
  const key = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";

  const res = await h.send({ action: "useRecoveryKey", key, newPin: "abc" });

  assert.equal(res.ok, false);
  assert.equal((await h.send({ action: "verifyPin", pin: "123456" })).ok, true);
  assert.equal((await h.send({ action: "useRecoveryKey", key, newPin: "654321" })).ok, true);
});

test("regenerateRecoveryKey needs the PIN and invalidates the old key", async () => {
  const h = loadBackground({ local: await seededLocal("123456") });

  assert.equal((await h.send({ action: "regenerateRecoveryKey", pin: "000000" })).ok, false);

  const res = await h.send({ action: "regenerateRecoveryKey", pin: "123456" });
  assert.equal(res.ok, true);
  assert.match(res.recoveryKey, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);

  const old = await h.send({
    action: "useRecoveryKey",
    key: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
    newPin: "654321",
  });
  assert.equal(old.ok, false, "the superseded recovery key still worked");

  const fresh = await h.send({ action: "useRecoveryKey", key: res.recoveryKey, newPin: "654321" });
  assert.equal(fresh.ok, true);
});

/* ── Temporary unlocks ───────────────────────────────────────────────── */

test("a temporary unlock expires", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  const res = await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  assert.equal(res.ok, true);
  assert.ok(res.unlockedUntil > Date.now());
  assert.ok(res.unlockedUntil <= Date.now() + 5 * 60 * 1000);

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 1, url: "https://facebook.com/" });
  await settle();
  assert.deepEqual(h.calls.tabUpdates, [], "an unlocked domain was blocked");

  await h.storage.session.set({ unlockedUntil: { "facebook.com": Date.now() - 1 } });
  await settle();
  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 1, url: "https://facebook.com/" });
  await settle();
  assert.equal(h.calls.tabUpdates.length, 1, "an expired unlock did not re-block");
});

test("an unlock is scoped to the domain it was granted for", async () => {
  const h = loadBackground({
    local: await seededLocal("123456", { lockedSites: ["facebook.com", "reddit.com"] }),
  });
  await settle();

  await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 1, url: "https://reddit.com/" });
  await settle();

  assert.equal(h.calls.tabUpdates.length, 1, "reddit.com should still be blocked");
});

test("an unlock request with a silly duration falls back to the default", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  for (const minutes of [0, -5, "abc", null, undefined]) {
    const res = await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes });
    assert.equal(res.ok, true, JSON.stringify(minutes));
    assert.ok(res.unlockedUntil > Date.now(), JSON.stringify(minutes));
    assert.ok(res.unlockedUntil <= Date.now() + 5 * 60 * 1000 + 50, JSON.stringify(minutes));
  }
});

test("locking a domain cancels an unlock it already had", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();
  await h.send({ action: "unlockDomainTemporary", domain: "facebook.com", pin: "123456", minutes: 5 });
  await settle();

  await h.send({ action: "lockDomain", domain: "facebook.com" });
  await settle();

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 1, url: "https://facebook.com/" });
  await settle();
  assert.ok(
    h.calls.tabUpdates.some((u) => u.tabId === 1),
    "re-locking should revoke the standing unlock"
  );
});

/* ── Reading state ───────────────────────────────────────────────────── */

test("getLockedSites returns the list", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["a.example", "b.example"] }) });

  assert.deepEqual((await h.send({ action: "getLockedSites" })).lockedSites, ["a.example", "b.example"]);
});

test("getActiveTabDomain reports the active tab, canonically", async () => {
  const h = loadBackground({ local: await seededLocal() });
  h.setTabs([
    { id: 1, url: "https://www.facebook.com/feed", active: true },
    { id: 2, url: "https://example.com/", active: false },
  ]);

  assert.equal((await h.send({ action: "getActiveTabDomain" })).domain, "facebook.com");
});

test("getActiveTabDomain copes with a tab that has no usable URL", async () => {
  const h = loadBackground({ local: await seededLocal() });

  h.setTabs([]);
  assert.equal((await h.send({ action: "getActiveTabDomain" })).domain, null);

  h.setTabs([{ id: 1, url: "chrome://extensions", active: true }]);
  assert.equal((await h.send({ action: "getActiveTabDomain" })).domain, null);
});

test("unlocking from a subdomain unlocks the domain that is actually locked", async () => {
  /* The popup unlocks whatever domain the active tab is on. On
   * `m.facebook.com` with `facebook.com` locked, the original keyed the unlock
   * map by `m.facebook.com` — a key nothing ever reads, because every lookup
   * is by the canonical locked domain. The popup reported success, the unlock
   * had no effect, and the next navigation was blocked again. */
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  const res = await h.send({ action: "unlockDomainTemporary", domain: "m.facebook.com", pin: "123456", minutes: 5 });
  assert.equal(res.ok, true);

  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 1, url: "https://m.facebook.com/feed" });
  await settle();
  assert.deepEqual(h.calls.tabUpdates, [], "the unlock the popup reported did not take effect");

  /* And it is the locked domain that was unlocked, not just that one host. */
  await h.events.onBeforeNavigate.emit({ frameId: 0, tabId: 2, url: "https://www.facebook.com/" });
  await settle();
  assert.deepEqual(h.calls.tabUpdates, []);
});

test("unlocking a domain that is not locked at all changes nothing", async () => {
  const h = loadBackground({ local: await seededLocal("123456", { lockedSites: ["facebook.com"] }) });
  await settle();

  const res = await h.send({ action: "unlockDomainTemporary", domain: "example.com", pin: "123456", minutes: 5 });

  assert.equal(res.ok, true, "the PIN was correct, so this is not a failed attempt");
  assert.deepEqual(h.storage.session._dump().unlockedUntil || {}, {}, "an unlock was recorded for an unlocked site");
});
