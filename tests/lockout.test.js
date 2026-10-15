/* The brute-force lockout.
 *
 * node --test tests/
 *
 * The extension's whole claim is that guessing the PIN gets slower and then
 * stops. That claim is made by `ppCheckLockout`, and it is only worth anything
 * if every action that verifies a secret consults it. These tests go through
 * `chrome.runtime.onMessage` — the surface any extension page can reach — and
 * check each such action individually, because the original code enforced the
 * lockout on two of the six and the two it chose were not the ones users hit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, loadLib, seededLocal } = require("./harness.js");

/* Every action that checks a secret before doing something. Each one is an
 * authentication boundary, so each one is listed here by hand rather than
 * read out of the implementation — a test that asks the code what it should
 * be testing tests nothing. */
const SECRET_ACTIONS = [
  { action: "verifyPin", wrong: { pin: "000000" } },
  { action: "changePin", wrong: { oldPin: "000000", newPin: "222222" } },
  { action: "useRecoveryKey", wrong: { key: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", newPin: "222222" } },
  { action: "regenerateRecoveryKey", wrong: { pin: "000000" } },
  { action: "unlockDomainPermanent", wrong: { pin: "000000", domain: "example.com" } },
  { action: "unlockDomainTemporary", wrong: { pin: "000000", domain: "example.com", minutes: 5 } },
];

/** A worker whose stored state says: currently locked out for another minute. */
async function lockedOutWorker() {
  const local = await seededLocal("123456", {
    failedAttempts: 5,
    lockoutUntil: Date.now() + 60 * 1000,
    lockedSites: ["example.com"],
  });
  return loadBackground({ local });
}

/* ── The lockout is refused on every secret-verifying action ─────────── */

for (const { action, wrong } of SECRET_ACTIONS) {
  test(`${action} refuses to verify anything while locked out`, async () => {
    const h = await lockedOutWorker();

    const res = await h.send(Object.assign({ action }, wrong));

    assert.equal(res.ok, false, `${action} should not succeed while locked out`);
    assert.equal(res.lockedOut, true, `${action} should report the lockout`);
    assert.ok(res.lockoutRemaining > 0, `${action} should say how long is left`);
  });

  test(`${action} refuses the CORRECT secret while locked out`, async () => {
    /* The wrong-secret case can pass by accident: the attempt fails anyway, so
     * a handler that never checks still returns ok:false. The honest question
     * is whether the lockout stops work from happening, and the only way to
     * ask it is with a secret that would otherwise be accepted. */
    const h = await lockedOutWorker();
    const right = {
      verifyPin: { pin: "123456" },
      changePin: { oldPin: "123456", newPin: "222222" },
      useRecoveryKey: { key: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", newPin: "222222" },
      regenerateRecoveryKey: { pin: "123456" },
      unlockDomainPermanent: { pin: "123456", domain: "example.com" },
      unlockDomainTemporary: { pin: "123456", domain: "example.com", minutes: 5 },
    }[action];

    const res = await h.send(Object.assign({ action }, right));

    assert.equal(res.ok, false, `${action} accepted a secret during a lockout`);
    assert.equal(res.lockedOut, true);

    /* And nothing should have changed underneath. */
    const after = h.storage.local._dump();
    assert.deepEqual(after.lockedSites, ["example.com"], `${action} modified the locked list`);
    assert.deepEqual(await h.storage.session._dump(), {}, `${action} granted an unlock`);
  });
}

/* ── The attempt counter escalates the way the README says ───────────── */

test("lockout duration escalates 30s, 5min, 30min, 60min", () => {
  const { ppLockoutDurationMs } = loadLib("policy.js");

  assert.equal(ppLockoutDurationMs(0), 0);
  assert.equal(ppLockoutDurationMs(2), 0);
  assert.equal(ppLockoutDurationMs(3), 30 * 1000);
  assert.equal(ppLockoutDurationMs(4), 30 * 1000);
  assert.equal(ppLockoutDurationMs(5), 5 * 60 * 1000);
  assert.equal(ppLockoutDurationMs(7), 5 * 60 * 1000);
  assert.equal(ppLockoutDurationMs(8), 30 * 60 * 1000);
  assert.equal(ppLockoutDurationMs(11), 30 * 60 * 1000);
  assert.equal(ppLockoutDurationMs(12), 60 * 60 * 1000);
  assert.equal(ppLockoutDurationMs(500), 60 * 60 * 1000);
});

test("repeated wrong PINs on the block page reach a lockout and stay there", async () => {
  /* unlockDomainTemporary is the handler the block page calls, so this is the
   * path a person actually guesses against. Three misses should be enough to
   * stop the fourth from being evaluated at all. */
  const local = await seededLocal("123456", { lockedSites: ["example.com"] });
  const h = loadBackground({ local });

  for (let i = 0; i < 3; i++) {
    const res = await h.send({ action: "unlockDomainTemporary", domain: "example.com", pin: "000000" });
    assert.equal(res.ok, false);
  }

  const stored = h.storage.local._dump();
  assert.equal(stored.failedAttempts, 3);
  assert.ok(stored.lockoutUntil > Date.now(), "three misses should have started a lockout");

  const fourth = await h.send({ action: "unlockDomainTemporary", domain: "example.com", pin: "123456" });
  assert.equal(fourth.ok, false, "the correct PIN was accepted during the lockout");
  assert.equal(fourth.lockedOut, true);
});

test("a refused attempt during a lockout does not extend the lockout", async () => {
  /* Otherwise a lockout can never end while anything is still retrying: each
   * refusal would push the deadline further out. The counter should only move
   * when a secret was actually checked and actually wrong. */
  const local = await seededLocal("123456", {
    failedAttempts: 5,
    lockoutUntil: Date.now() + 60 * 1000,
  });
  const h = loadBackground({ local });
  const before = h.storage.local._dump();

  await h.send({ action: "verifyPin", pin: "000000" });
  await h.send({ action: "unlockDomainTemporary", domain: "example.com", pin: "000000" });

  const after = h.storage.local._dump();
  assert.equal(after.failedAttempts, before.failedAttempts);
  assert.equal(after.lockoutUntil, before.lockoutUntil);
});

test("a successful unlock clears the attempt counter", async () => {
  const local = await seededLocal("123456", { failedAttempts: 2, lockedSites: ["example.com"] });
  const h = loadBackground({ local });

  const res = await h.send({ action: "unlockDomainTemporary", domain: "example.com", pin: "123456" });

  assert.equal(res.ok, true);
  assert.equal(h.storage.local._dump().failedAttempts, 0);
});

test("an expired lockout lets verification happen again", async () => {
  const local = await seededLocal("123456", {
    failedAttempts: 3,
    lockoutUntil: Date.now() - 1000,
  });
  const h = loadBackground({ local });

  const res = await h.send({ action: "verifyPin", pin: "123456" });

  assert.equal(res.ok, true);
});

/* ── Unknown and malformed messages ──────────────────────────────────── */

test("an unknown action is refused rather than falling through", async () => {
  const h = loadBackground({ local: await seededLocal() });

  const res = await h.send({ action: "definitelyNotAnAction" });

  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown action/);
});

test("a message with no action at all does not throw", async () => {
  const h = loadBackground({ local: await seededLocal() });

  const res = await h.send({});

  assert.equal(res.ok, false);
});
