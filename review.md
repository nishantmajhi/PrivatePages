# PrivatePages — review and remediation record

First reviewed 2026-09-04. Remediated 2026-09-17 on branch `cleanup/2026-09-17`.
This file was a to-do list; it is now a record of what was done, what was
deliberately left, and what the next person should know.

## What this project is

An MV3 extension that locks chosen websites behind a six-digit PIN, with a
base32 recovery key, escalating lockouts after failed attempts, and continuous
cookie and cache purging for locked domains.

## Verdict, unchanged

This is the most security-conscious code in the archive and the crypto is done
correctly — PBKDF2 with a random per-secret salt, 150,000 iterations, hashes
only, a length-checked constant-time comparison, and 128 bits of entropy in the
recovery key. `lib/crypto.js` was not changed except to delete a redundant
alias and improve a comment; it now has 18 tests, all of which passed against
the original file. The README was already unusually honest about its own
limits, and the rewrite keeps that and extends it.

The two things that undercut it are both fixed.

## Tests

```sh
node --test "tests/*.test.js"
```

107 tests, no dependencies. **29 of them fail against commit `adfc623`** (the
original code) and pass now. The suite was written before the fixes and each
failure was confirmed against the unfixed code first; the list of 29 is in the
commit message.

`tests/harness.js` is the piece worth understanding. `background.js` is a
service worker: it registers listeners against `chrome.*` at load time and
every decision it makes is reached through one of them, so there was no way to
call into it at all. The harness stands up enough of the `chrome` namespace —
storage with change events, tabs, cookies, alarms, webNavigation,
declarativeNetRequest — inside a `node:vm` context and loads the real
`background.js` into it. The tests drive the code that ships. Values crossing
the vm boundary are serialised, which is what Chrome does to extension messages
and DNR rules anyway.

## Fixed

### P1 — the lockout was not enforced on the path users hit

`ppCheckLockout()` was called by `verifyPin` and `useRecoveryKey` and by
nothing else. `unlockDomainTemporary` (the handler the block page calls),
`changePin`, `regenerateRecoveryKey` and `unlockDomainPermanent` each recorded
a failure and then went on verifying. The block page displayed "Too many
attempts. Try again in 27s" while the service worker cheerfully checked the
next guess, at whatever rate PBKDF2 allowed.

The check now happens once, in `ppHandleMessage`, before the switch, for every
action in `PP_SECRET_VERIFYING_ACTIONS` (`lib/policy.js`). The list is written
out by hand rather than inferred, so adding a seventh action that checks a
secret means adding it there — which is the only thing left to remember.

One note on how this was tested, because it nearly went wrong. The obvious test
— send a wrong PIN during a lockout, expect failure — **passes against the
broken code**, since the wrong PIN fails on its own merits. Each action
therefore has a second test that sends the *correct* secret during a lockout
and asserts it is refused and that nothing changed underneath. That is the test
that fails against the original.

### P1 — blocking was advisory and racy

`chrome.webNavigation.onBeforeNavigate` is an observer; MV3 removed blocking
`webRequest` precisely so extensions could not sit in the middle of requests.
The handler then performed three sequential `await`s on `chrome.storage` before
redirecting, and in that window the locked page was already in flight and
frequently already executing scripts.

Two changes, as the review asked:

- **`declarativeNetRequest` rules**, one per locked domain, rebuilt wholesale
  whenever the state changes (`lib/rules.js`, `ppSyncBlockRules`). Enforced in
  the network stack, and enforced while the service worker is asleep — which
  matters, because under MV3 it usually is.
- **An in-memory copy of the state**, refreshed via `chrome.storage.onChanged`,
  so `ppDecideNavigation` is synchronous and nothing between the event and
  `tabs.update` waits on storage.

**Deviation from the review, deliberate.** The review said to use a *redirect*
rule. I used a *block* rule. Redirecting to an extension page requires listing
`blocked.html` in `web_accessible_resources`, which makes it reachable and
probeable by every website on the internet — a real cost for a cosmetic gain.
Blocking the request stops the page unconditionally; the `webNavigation`
listener still swaps the tab to `blocked.html` and normally wins, and when it
loses the user sees Chrome's error page rather than the locked site. The
failure mode is ugly, not open. `lib/rules.js` documents this at the top.

The rule condition uses `requestDomains`, which matches a domain and its
subdomains and nothing else — the same rule `ppHostMatchesDomain` implements,
enforced by the browser instead of by us.

### P2 — tabs already open were never redirected

Locking a domain purged its cookies and left the open tabs fully rendered and
fully interactive, so locking `facebook.com` while `facebook.com` was open did
nothing until the next navigation. `ppRedirectOpenTabs` now enumerates tabs on
`lockDomain` and sends the matching ones to the block page.

### P2 — the two honest limits are now in the README

The 10^6 PIN keyspace against an attacker holding the storage file, and the
fact that anyone can disable the extension in two clicks. Both are under "What
it does not protect against", along with two more (incognito/profile scoping,
and a plain statement that this is self-discipline tooling rather than a
security boundary). The README was rewritten from first principles.

### P3 — sub-frames and in-page navigation

Sub-frames are covered by the DNR rule (`sub_frame` is in its resource types),
which closes the iframe hole the old `frameId !== 0` check left open. The tab
is deliberately *not* redirected for a sub-frame — taking the user off a page
they are allowed to be on, because something on it embedded a locked domain,
is worse than the thing being prevented. `onHistoryStateUpdated` is now handled
too, which matters for a single-page app when a domain is locked, or an unlock
expires, while the user is sitting on it.

### P3 — sweep frequency and the return URL

The sweep is now every 15 minutes rather than every minute. It is a backstop:
`chrome.cookies.onChanged` handles the case that matters in real time, and
clearing cache, cacheStorage, service workers, IndexedDB and localStorage
across a dozen origins per domain once a minute forever was real battery and
disk churn for belt-and-braces.

The block page no longer carries the original URL in its query string — that
put the path of the locked page into the address bar and browsing history in
plaintext. It is kept in `chrome.storage.session` keyed by tab id, held in
memory as well so that writing it cannot delay the redirect, and read back
through a new `getBlockedReturn` action that only answers about the asking
tab's own id.

### P3 — the redundant alias, and a LICENSE

`ppNormalizeRecoveryKeyForHash` deleted; its three callers use
`ppNormalizeRecoveryKey` directly. MIT `LICENSE` added, matching the other
projects in the archive, and stated in the README.

### The purge did not cover what the block covered

The review flagged this as a correctness detail. `ppHostMatchesDomain` matches
any subdomain; `ppCommonVariantOrigins` cleared storage for the bare domain
plus four guesses, so `business.facebook.com` kept its localStorage, IndexedDB
and service worker indefinitely while being treated as locked.

`chrome.browsingData` genuinely has no wildcard — this cannot be closed
completely. `ppOriginsToPurge` now adds the hostnames observed in the cookie
jar for that domain, which are subdomains this profile has actually talked to,
and filters anything outside the locked domain before handing the list to
`browsingData.remove`. The residual limit (a subdomain that has never set a
cookie) is stated in the README.

## Found during remediation — not in the first review

### The popup's unlock silently did nothing on any subdomain

`unlockDomainTemporary` keyed the unlock map by whatever domain it was handed.
The popup hands it the active tab's host. So on `m.facebook.com`, with
`facebook.com` locked, it wrote `unlockMap["m.facebook.com"]` — a key nothing
ever reads, because every lookup is by the canonical locked domain. The popup
reported success and the next navigation was blocked exactly as before.

The handler now resolves the requested domain to the matching locked domain
before using it as a key. Unlocking a domain that is not locked returns `ok`
with `unlockedUntil: null` and records nothing — the PIN was correct, so it is
not a failed attempt.

### `popup.js` had its own copy of the matching rule

`lockedSites.some((d) => domain === d || domain.endsWith("." + d))` — correct
as written, but a second copy of a rule that must not drift, in a file that
did not load `lib/domain.js`. It now loads it and calls
`ppFindMatchingLockedDomain`.

### `getActiveTabDomain` offered to lock `chrome://` pages

`new URL("chrome://extensions").hostname` is `"extensions"`, which passed
straight through normalisation. The popup would show `extensions` as the
current domain and offer to lock it — producing a list entry that nothing could
ever match. Now restricted to `http:` and `https:`.

### The sweep alarm was only created from `onInstalled` and `onStartup`

Alarms survive a service-worker teardown, so this normally worked, but an alarm
lost to a crash or a cleared profile would not have come back until the next
browser restart. It is now ensured on every worker wake-up — via
`chrome.alarms.get` first, because `alarms.create` replaces an existing alarm
and resets its period, and a worker that wakes often would otherwise push a
15-minute sweep out forever.

### `setup.html` loaded `lib/crypto.js` and never used it

`setup.js` only sends messages; the hashing happens in the service worker.
Removed.

## Deliberately not done

- **`failedAttempts` does not decay over time.** The review said "consider".
  `ppRecordSuccess` already resets it, so the counter only bites within a bad
  streak, and decaying it over time would mean an attacker who is willing to
  wait gets their budget back. Left as is on purpose.
- **The 150,000 iteration count was not changed**, and neither was anything
  else in `lib/crypto.js` beyond the alias and a comment. It is correct. The
  test suite now pins the iteration count so lowering it has to be deliberate.
- **No UI or UX changes.** Per the archive's standing constraint. The block
  page, popup, options and setup pages look and behave as they did; what
  changed behind them is where their data comes from. `blocked.js` reads the
  site name asynchronously now rather than from the query string, which is a
  data-flow change, not a presentation one.
- **Not loaded in a real Chrome.** Everything here is tested against the
  harness. The DNR rule shape, the `requestDomains` semantics and the
  `web_accessible_resources` reasoning are from the Chrome documentation, not
  from observation. See below.

## Notes for a future session

**The one thing that has not been verified in a browser** is that the
`declarativeNetRequest` rules behave as intended once loaded. The rule
*objects* are tested; Chrome's treatment of them is not, because there is no
Chrome automation set up in this archive. If you have a Chrome to hand, this is
a ten-minute check worth doing:

1. Load unpacked, complete setup, lock a domain.
2. `chrome://extensions` → Service Worker → Inspect → console:
   `chrome.declarativeNetRequest.getDynamicRules().then(console.log)` — expect
   one rule per locked domain, `action.type === "block"`.
3. Visit the locked domain. Expect the block page, with no flash of the site.
4. Visit a subdomain, and a lookalike (`not<domain>`), to confirm the match.
5. Unlock temporarily; confirm the rule disappears and the site loads; wait for
   the expiry and confirm it comes back.

No build step; load unpacked; `minimum_chrome_version` is 116, and nothing
added here needs newer. The riskiest edit surface is still `ppHandleMessage` —
every case is reachable from any extension page, so treat each as an
authentication boundary, and if you add one that checks a secret, add it to
`PP_SECRET_VERIFYING_ACTIONS`.

The crypto in `lib/crypto.js` is correct — do not "improve" it without a
specific reason. If you ever change the iteration count, note that stored
records carry their own `iterations` field, so old PINs keep verifying.

## Original action checklist

- [x] **P1** Enforce `ppCheckLockout()` on every secret-verifying action, centrally.
- [x] **P1** Move blocking to `declarativeNetRequest`; cache the locked list in memory.
      (Block rules rather than redirect rules — see above.)
- [x] **P2** Redirect already-open tabs when a domain is locked.
- [x] **P2** Add the two honest limits (PIN keyspace, extension can be disabled) to the README.
- [x] **P3** Handle sub-frames and history-state navigations, or document that they are out of scope.
- [x] **P3** Reduce the purge sweep frequency; move the return URL out of the query string.
- [x] **P3** Delete the redundant recovery-key normalisation alias; add a `LICENSE`.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same. Anything above that
calls the licence an open question, or calls the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the 107 node checks on `ubuntu-latest`.
Nothing has been pushed, so it has not run on GitHub yet. Every job was run
before committing, from a fresh clone of this branch, the way a runner would
run it: Linux jobs in a throwaway Ubuntu 24.04 (the image `ubuntu-latest`
uses) with the same tool versions. 107.
