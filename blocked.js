function ppSend(msg) {
  return chrome.runtime.sendMessage(msg);
}

/* Which site was blocked, and where the user was going, are held in
 * chrome.storage.session under this tab's id rather than passed in the query
 * string. A query string would put the path of the locked page into the
 * address bar and into browsing history in plaintext — the opposite of the
 * point. The service worker only answers for the asking tab. */
let site = "";
let returnUrl = "";

const ppReturnKnown = (async function ppLoadReturn() {
  try {
    const res = await ppSend({ action: "getBlockedReturn" });
    site = (res && res.domain) || "";
    returnUrl = (res && res.url) || "";
  } catch (e) {
    // The block page still works without it; it just cannot offer a way back.
  }
  document.getElementById("pp-blocked-domain").textContent = site || "This site";
})();

document.getElementById("pp-back-btn").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "https://www.google.com";
});

const ppPinInput = document.getElementById("pp-pin");
const ppUnlockBtn = document.getElementById("pp-unlock-btn");
ppPinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ppUnlockBtn.click();
  }
});

ppUnlockBtn.addEventListener("click", async () => {
  const pinInput = document.getElementById("pp-pin");
  const errorEl = document.getElementById("pp-error");
  const pin = pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    errorEl.textContent = "Enter your 6-digit PIN.";
    return;
  }
  await ppReturnKnown;
  if (!site) {
    errorEl.textContent = "This tab's block record has expired. Open the site again.";
    return;
  }
  const res = await ppSend({ action: "unlockDomainTemporary", domain: site, pin, minutes: 5 });
  if (res.ok) {
    location.href = returnUrl || `https://${site}`;
  } else if (res.lockedOut) {
    const secs = Math.ceil(res.lockoutRemaining / 1000);
    errorEl.textContent = `Too many attempts. Try again in ${secs}s.`;
  } else {
    errorEl.textContent = res.error || "Incorrect PIN.";
  }
});

document.getElementById("pp-forgot-btn").addEventListener("click", () => {
  document.getElementById("pp-recovery-section").classList.remove("pp-hidden");
});

const ppRecoveryInput = document.getElementById("pp-recovery-input");
const ppNewPinInput = document.getElementById("pp-new-pin");
const ppRecoverySubmit = document.getElementById("pp-recovery-submit");
[ppRecoveryInput, ppNewPinInput].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ppRecoverySubmit.click();
    }
  });
});

ppRecoverySubmit.addEventListener("click", async () => {
  const key = document.getElementById("pp-recovery-input").value.trim();
  const newPin = document.getElementById("pp-new-pin").value.trim();
  const errorEl = document.getElementById("pp-recovery-error");
  if (!key) {
    errorEl.textContent = "Enter your recovery key.";
    return;
  }
  if (!/^\d{6}$/.test(newPin)) {
    errorEl.textContent = "New PIN must be exactly 6 digits.";
    return;
  }
  const res = await ppSend({ action: "useRecoveryKey", key, newPin });
  if (res.ok) {
    alert(
      "Your PIN has been reset. Here is your NEW recovery key — save it now, it will not be shown again:\n\n" +
        res.recoveryKey
    );
    location.reload();
  } else if (res.lockedOut) {
    const secs = Math.ceil(res.lockoutRemaining / 1000);
    errorEl.textContent = `Too many attempts. Try again in ${secs}s.`;
  } else {
    errorEl.textContent = res.error || "Recovery key is incorrect.";
  }
});
