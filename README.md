# PrivatePages

A Chrome extension that puts a 6-digit PIN in front of websites you have
decided you visit too often.

It is a speed bump, on purpose. Read [What it does not
protect against](#what-it-does-not-protect-against) before you rely on it for
anything that matters — that section is the honest part, and it is the reason
this README is longer than the feature list needs it to be.

## Install

There is no build step and no package manager. The repository is the extension.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked**, and select this folder
4. A setup tab opens. Choose a PIN, and write down the recovery key it shows
   you — it is displayed once and is not recoverable afterwards.

Chrome 116 or newer.

## How it works

### Locking a site

Click the toolbar icon while you are on a site and choose **Lock this site**,
or type a domain into Settings. Locking needs no PIN; unlocking does. Making it
harder to protect a site than to stop protecting one would be backwards.

Matching is on the hostname, and covers subdomains. Locking `facebook.com`
covers `www.facebook.com`, `m.facebook.com` and `business.facebook.com`, and
every path under any of them — the path is not part of the match at all, so
there is nothing extra to configure for `facebook.com/profile.php`.

It does **not** cover `notfacebook.com` or `facebook.com.example`. Those are
different sites owned by different people, and the distinction is the sort of
thing that is easy to get subtly wrong, so it is tested directly in
`tests/domain.test.js`.

### How the block is actually enforced

Two mechanisms, doing two different jobs.

**A `declarativeNetRequest` rule per locked domain** is what stops the page.
These are handed to Chrome in advance and evaluated inside the network stack,
before the request leaves the browser, and they keep working while the
extension's service worker is asleep — which, under Manifest V3, is most of the
time.

**A `webNavigation` listener** swaps the tab to the block page, so you get an
explanation and a PIN box instead of Chrome's generic error. This part is
cosmetic. `webNavigation` can only observe a navigation, not hold one, so it is
in a race it does not always win; when it loses you see Chrome's error page.
That is why the rule exists. The listener decides from an in-memory copy of the
locked list, refreshed through `chrome.storage.onChanged`, precisely so there
is no storage read between the navigation starting and the tab being redirected.

Sub-frames are covered by the rule, so a locked site cannot be reached by
embedding it in an iframe. The tab itself is left alone in that case:
navigating you away from a page you are allowed to be on, because something on
it embedded a locked domain, would be worse than the thing being prevented.

### Unlocking

Entering the correct PIN on the block page or in the popup grants **temporary**
access to that domain — five minutes by default. The unlock is held in
`chrome.storage.session`, which Chrome wipes when the browser restarts, so a
restart re-locks everything. That is deliberate.

Removing a domain from the list permanently is a separate action in Settings,
and also needs the PIN.

### Brute-force protection

Wrong PINs and wrong recovery keys are counted, and after the third consecutive
miss the extension refuses to check anything at all for a while: 30 seconds,
then 5 minutes after five misses, 30 minutes after eight, an hour after twelve.
A correct entry resets the counter. Refusals during a lockout do not extend it.

The check is applied centrally, in one place, to every action that verifies a
secret. It is listed action by action in `lib/policy.js` and tested action by
action in `tests/lockout.test.js`, because the interesting failure mode here is
not a wrong delay — it is a handler that forgets to ask.

### Keeping locked sites logged out

Chrome gives an extension no way to run code after it has been uninstalled —
by design, since an extension that could act after removal would be a serious
hole. So "delete the cookies if the extension is removed" cannot be built
literally.

What is built instead gets to the same place: **while a site is locked, it is
never allowed to hold a session.** Any cookie written for a locked domain is
deleted as it is written, via `chrome.cookies.onChanged`. A sweep every 15
minutes catches whatever was already on disk, and clears cache, cacheStorage,
service workers, IndexedDB and localStorage for the domain as well.

So if you forget the PIN, lose the recovery key, or just uninstall the
extension to get around it, you land on a logged-out site and have to sign in
again — which was the actual goal.

The storage purge has a limitation worth knowing. `chrome.cookies` matches a
domain and all its subdomains; `chrome.browsingData` does not — it takes exact
origins and has no wildcard. The purge therefore covers the bare domain, four
common variants (`www.`, `m.`, `mobile.`, `web.`), and every subdomain the
browser has actually been seen talking to, taken from the cookie jar. An
untouched subdomain that has never set a cookie can retain localStorage.
Cookie clearing — the part that actually ends a session — has no such limit.

### Where your secrets live

Nothing is stored in plaintext. The PIN and the recovery key are each kept as a
PBKDF2-SHA256 hash with its own 16-byte random salt, at 150,000 iterations,
compared in constant time. Each record carries the iteration count it was made
with, so the count can be raised later without invalidating PINs already set.

The recovery key is 128 bits of `crypto.getRandomValues`, base32-encoded, shown
once and never written down by the extension. Using it resets the PIN and
issues a new recovery key, invalidating the old one.

The block page does not put the URL you were visiting in its query string. The
address bar and browsing history would otherwise record the path of the page
you were blocked from, in plaintext, which is the opposite of the point; it is
kept in session storage keyed by tab id instead.

## What it does not protect against

**Anyone can turn the extension off.** Two clicks on `chrome://extensions`.
Nothing here prevents that and nothing can — an extension cannot stop the
browser from disabling it. If you are considering this as a parental control,
this is the paragraph that matters.

**A 6-digit PIN is one million possibilities.** The lockout makes online
guessing impractical, and 150,000 PBKDF2 iterations is the right choice for
what this is. But against someone holding the extension's storage file and a
GPU, the entire keyspace falls quickly. The stored hash protects against
someone glancing at your disk, not against someone who takes a copy of it.

**Incognito and other profiles are separate.** The extension is not enabled in
incognito unless you enable it, and another Chrome profile knows nothing about
your locked list.

**This is self-discipline tooling.** It is good at making a habit take a
deliberate act instead of a reflex. It is not a security boundary, and it is
not built to be one.

## Layout

```
manifest.json      MV3 manifest
background.js      Service worker. Plumbing only: storage, listeners, and
                   keeping the two in step. Every decision it makes is made
                   by a function in lib/.
lib/crypto.js      PBKDF2 hashing, constant-time comparison, base32 recovery
                   keys. No external crypto libraries.
lib/domain.js      Hostname matching and the origins a purge should cover.
lib/policy.js      The decisions: lockout schedule, which actions are
                   authentication boundaries, whether to block a navigation.
lib/rules.js       Builds the declarativeNetRequest rule set from the locked
                   list. Explains, at the top, why the rules block rather
                   than redirect.
popup.*            Toolbar popup: lock the current site, or unlock it.
options.*          Settings: manage the list, change the PIN, regenerate the
                   recovery key.
setup.*            First run: create a PIN, show the recovery key once.
blocked.*          The page shown in place of a locked site.
tests/             See below.
```

`lib/policy.js`, `lib/rules.js` and `lib/domain.js` contain no `chrome.*` calls
at all. That is what makes them testable, and it is what lets the navigation
decision be synchronous — which is the whole reason the block page appears
before the locked page does.

## Tests

```sh
node --test "tests/*.test.js"
```

107 tests, no dependencies and nothing to install: Node's own test runner and
Node's own Web Crypto. `tests/harness.js` stands up enough of the `chrome`
namespace in a `node:vm` context to load and drive the real `background.js`, so
the tests exercise the service worker that ships rather than a paraphrase of
it — including its listeners, its alarms, and the storage underneath.

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
