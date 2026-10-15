/* A fake Chrome extension host, enough of one to run background.js.
 *
 * background.js is a service worker: it registers listeners against the
 * `chrome` namespace at load time, and every decision it makes is reached
 * through one of them. There is no way to call into it from outside without
 * standing up that namespace, so this file does — in a `node:vm` context, the
 * same way a service worker gets a fresh global — and hands back the things
 * the tests need to drive: the message handler, the navigation listeners, the
 * alarm listeners, and the storage underneath it all.
 *
 * The point is that the tests exercise the real background.js, not a
 * paraphrase of it. A test that passes here is a statement about the code that
 * ships.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

/* Values that cross a realm boundary come back carrying the vm context's own
 * prototypes, which node:assert/strict correctly refuses to call equal to an
 * ordinary object. Serialising them is not a workaround for that: Chrome
 * serialises extension messages and declarativeNetRequest rules for real, so a
 * test that sees plain data is seeing what the browser would see — including
 * the fact that anything unserialisable would not survive the trip. */
function marshal(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** A listener registry that looks like `chrome.something.onEvent`. */
function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    /** Call every listener and wait for any promises they return. */
    async emit(...args) {
      return Promise.all(listeners.map((fn) => fn(...args)));
    },
    get count() {
      return listeners.length;
    },
  };
}

/* chrome.storage.local and .session both behave like this: a plain object
 * store whose get() takes either a key, a list of keys, or an object of
 * defaults. The defaults form is the only one background.js uses, but the
 * others are cheap to support and expensive to discover missing later. */
function makeStorageArea(onChanged) {
  let data = {};
  return {
    _dump: () => JSON.parse(JSON.stringify(data)),
    _seed: (obj) => {
      data = JSON.parse(JSON.stringify(obj));
    },
    async get(request) {
      if (request === null || request === undefined) return JSON.parse(JSON.stringify(data));
      if (typeof request === "string") {
        return request in data ? { [request]: data[request] } : {};
      }
      if (Array.isArray(request)) {
        const out = {};
        for (const k of request) if (k in data) out[k] = data[k];
        return JSON.parse(JSON.stringify(out));
      }
      const out = {};
      for (const [k, fallback] of Object.entries(request)) {
        out[k] = k in data ? data[k] : fallback;
      }
      return JSON.parse(JSON.stringify(out));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = JSON.parse(JSON.stringify(v));
      }
      if (onChanged) await onChanged(changes);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of list) {
        changes[k] = { oldValue: data[k], newValue: undefined };
        delete data[k];
      }
      if (onChanged) await onChanged(changes);
    },
  };
}

/**
 * Load background.js (and, through its importScripts, the lib files) into a
 * fresh context with a fake `chrome`. Returns the handles the tests use.
 */
function loadBackground(options = {}) {
  const storageChanged = makeEvent();

  const local = makeStorageArea((changes) => storageChanged.emit(changes, "local"));
  const session = makeStorageArea((changes) => storageChanged.emit(changes, "session"));

  if (options.local) local._seed(options.local);
  if (options.session) session._seed(options.session);

  /* Everything the fake host recorded, so a test can assert on what the
   * extension tried to do and not only on what it returned. */
  const calls = {
    tabUpdates: [],
    tabsCreated: [],
    cookieRemovals: [],
    browsingDataRemovals: [],
    alarmsCreated: [],
    alarmsCleared: [],
    dnrUpdates: [],
  };

  let dynamicRules = [];
  const alarms = {};
  let tabs = options.tabs || [];
  let cookies = options.cookies || [];

  const onMessage = makeEvent();
  const onInstalled = makeEvent();
  const onStartup = makeEvent();
  const onAlarm = makeEvent();
  const onBeforeNavigate = makeEvent();
  const onHistoryStateUpdated = makeEvent();
  const onCookieChanged = makeEvent();

  const chrome = {
    runtime: {
      onMessage,
      onInstalled,
      onStartup,
      getURL: (p) => "chrome-extension://ppfake/" + p,
      lastError: undefined,
    },
    storage: {
      local,
      session,
      onChanged: storageChanged,
    },
    tabs: {
      async query(q) {
        if (q && q.active) return tabs.filter((t) => t.active);
        return tabs.slice();
      },
      async update(tabId, props) {
        calls.tabUpdates.push(marshal(Object.assign({ tabId }, props)));
        return Object.assign({ id: tabId }, props);
      },
      async create(props) {
        calls.tabsCreated.push(marshal(props));
        return Object.assign({ id: 999 }, props);
      },
    },
    cookies: {
      onChanged: onCookieChanged,
      async getAll(q) {
        if (!q || !q.domain) return cookies.slice();
        const d = q.domain;
        return cookies.filter((c) => {
          const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
          return host === d || host.endsWith("." + d);
        });
      },
      async remove(details) {
        calls.cookieRemovals.push(marshal(details));
        return details;
      },
    },
    browsingData: {
      async remove(scope, types) {
        calls.browsingDataRemovals.push(marshal({ scope, types }));
      },
    },
    alarms: {
      onAlarm,
      create(name, info) {
        calls.alarmsCreated.push(marshal({ name, info }));
        alarms[name] = { name, scheduledTime: Date.now() };
      },
      async get(name) {
        return alarms[name] || undefined;
      },
      async clear(name) {
        calls.alarmsCleared.push(name);
        const had = name in alarms;
        delete alarms[name];
        return had;
      },
    },
    webNavigation: {
      onBeforeNavigate,
      onHistoryStateUpdated,
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return dynamicRules.slice();
      },
      async updateDynamicRules(update) {
        const removeRuleIds = (update && update.removeRuleIds) || [];
        const addRules = (update && update.addRules) || [];
        const added = marshal(addRules.slice());
        calls.dnrUpdates.push({ removeRuleIds: marshal(removeRuleIds.slice()), addRules: added });
        dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(added);
      },
    },
  };

  const sandbox = {
    chrome,
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    setTimeout,
    clearTimeout,
    Date,
    importScripts(...files) {
      for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox.__ctx, { filename: f });
      }
    },
  };
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  sandbox.__ctx = ctx;

  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, {
    filename: "background.js",
  });

  /** Send a message the way popup/options/blocked do, and get the reply. */
  function send(msg, sender = {}) {
    return new Promise((resolve, reject) => {
      if (onMessage.count === 0) {
        reject(new Error("background.js registered no onMessage listener"));
        return;
      }
      let settled = false;
      const sendResponse = (res) => {
        if (settled) return;
        settled = true;
        resolve(marshal(res));
      };
      onMessage.emit(msg, sender, sendResponse).catch(reject);
    });
  }

  return {
    chrome,
    ctx,
    calls,
    storage: { local, session },
    send,
    events: {
      onMessage,
      onInstalled,
      onStartup,
      onAlarm,
      onBeforeNavigate,
      onHistoryStateUpdated,
      onCookieChanged,
    },
    getDynamicRules: () => dynamicRules.slice(),
    setTabs: (t) => {
      tabs = t;
    },
    setCookies: (c) => {
      cookies = c;
    },
    /** Read a value out of the service worker's global scope. */
    global: (name) => sandbox[name],
  };
}

/**
 * Stand up a worker that has already been through setup, with a known PIN.
 * Returns the harness plus the recovery key setup handed back.
 */
async function loadConfigured(pin = "123456", options = {}) {
  const h = loadBackground(options);
  const res = await h.send({ action: "setupPin", pin });
  if (!res || !res.ok) throw new Error("setupPin failed: " + JSON.stringify(res));
  return Object.assign({}, h, { recoveryKey: res.recoveryKey });
}

/** Load one of the lib/*.js files on its own, for testing the pure helpers. */
function loadLib(...files) {
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    Date,
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"), ctx, { filename: f });
  }
  return sandbox;
}

/**
 * Build a stored secret record by hand, at a low iteration count.
 *
 * Setup hashes at 150,000 iterations, which is the right number for the
 * product and the wrong one for a test that wants to make fifteen failed
 * attempts. Stored records carry their own `iterations`, so seeding one with a
 * small count verifies through exactly the same code path in a fraction of the
 * time — and incidentally proves that the per-record count is honoured.
 */
async function makeSecretRecord(secret, iterations = 100) {
  const lib = loadLib("crypto.js");
  const salt = lib.ppGenerateSaltB64();
  const hash = await lib.ppPbkdf2Hash(secret, salt, iterations);
  return { hash, salt, iterations };
}

/** Storage as it looks after setup, without paying for setup's real hashing. */
async function seededLocal(pin = "123456", extra = {}) {
  return Object.assign(
    {
      pinRecord: await makeSecretRecord(pin),
      recoveryRecord: await makeSecretRecord("AAAAABBBBBCCCCCDDDDDEEEEE"),
      setupComplete: true,
      lockedSites: [],
      failedAttempts: 0,
      lockoutUntil: 0,
    },
    extra
  );
}

module.exports = {
  loadBackground,
  loadConfigured,
  loadLib,
  makeEvent,
  makeStorageArea,
  makeSecretRecord,
  seededLocal,
};
