function ppSend(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function ppInit() {
  const { setupComplete } = await ppSend({ action: "getSetupStatus" });
  const notSetup = document.getElementById("pp-not-setup");
  const setupOk = document.getElementById("pp-setup-ok");
  const subtitle = document.getElementById("pp-subtitle");

  if (!setupComplete) {
    notSetup.classList.remove("pp-hidden");
    subtitle.textContent = "Setup required";
    document.getElementById("pp-goto-setup").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
      window.close();
    });
    return;
  }

  subtitle.textContent = "Protecting your browsing";
  setupOk.classList.remove("pp-hidden");

  const { domain } = await ppSend({ action: "getActiveTabDomain" });
  const domainEl = document.getElementById("pp-domain");
  const stateUnlocked = document.getElementById("pp-state-unlocked");
  const stateLocked = document.getElementById("pp-state-locked");

  if (!domain) {
    domainEl.textContent = "N/A";
    return;
  }
  domainEl.textContent = domain;

  const { lockedSites } = await ppSend({ action: "getLockedSites" });
  /* ppFindMatchingLockedDomain, from lib/domain.js, rather than a second copy
   * of the matching rule written out here. The copy that used to live on this
   * line matched `notfacebook.com` against `facebook.com`, because `endsWith`
   * on its own does not check that the character before the suffix is a dot. */
  const isLocked = ppFindMatchingLockedDomain(domain, lockedSites) !== null;

  if (isLocked) {
    stateLocked.classList.remove("pp-hidden");
    const pinInput = document.getElementById("pp-unlock-pin");
    const errorEl = document.getElementById("pp-unlock-error");
    const unlockBtn = document.getElementById("pp-unlock-btn");
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        unlockBtn.click();
      }
    });
    unlockBtn.addEventListener("click", async () => {
      const pin = pinInput.value.trim();
      if (!/^\d{6}$/.test(pin)) {
        errorEl.textContent = "Enter your 6-digit PIN.";
        return;
      }
      const res = await ppSend({ action: "unlockDomainTemporary", domain, pin, minutes: 5 });
      if (res.ok) {
        window.close();
      } else if (res.lockedOut) {
        errorEl.textContent = "Too many attempts. Try again shortly.";
      } else {
        errorEl.textContent = res.error || "Incorrect PIN.";
      }
    });
  } else {
    stateUnlocked.classList.remove("pp-hidden");
    document.getElementById("pp-lock-btn").addEventListener("click", async () => {
      await ppSend({ action: "lockDomain", domain });
      window.close();
    });
  }

  document.getElementById("pp-open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

document.addEventListener("DOMContentLoaded", ppInit);
