function ppSend(msg) {
  return chrome.runtime.sendMessage(msg);
}

let pendingRemoveDomain = null;

async function ppRenderSiteList() {
  const { lockedSites } = await ppSend({ action: "getLockedSites" });
  const container = document.getElementById("pp-site-list");
  container.innerHTML = "";
  if (!lockedSites || lockedSites.length === 0) {
    container.innerHTML = '<div class="pp-empty-state">No sites locked yet.</div>';
    return;
  }
  for (const domain of lockedSites) {
    const row = document.createElement("div");
    row.className = "pp-site-row";
    const name = document.createElement("span");
    name.className = "pp-site-name";
    name.textContent = domain;
    const removeBtn = document.createElement("button");
    removeBtn.className = "pp-site-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => ppOpenRemoveModal(domain));
    row.appendChild(name);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }
}

function ppOpenRemoveModal(domain) {
  pendingRemoveDomain = domain;
  document.getElementById("pp-modal-error").textContent = "";
  document.getElementById("pp-modal-pin").value = "";
  document.getElementById("pp-pin-modal-overlay").classList.remove("pp-hidden");
}
function ppCloseRemoveModal() {
  pendingRemoveDomain = null;
  document.getElementById("pp-pin-modal-overlay").classList.add("pp-hidden");
}

async function ppInit() {
  const { setupComplete } = await ppSend({ action: "getSetupStatus" });
  if (!setupComplete) {
    document.getElementById("pp-needs-setup").classList.remove("pp-hidden");
    document.getElementById("pp-goto-setup").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
    });
    return;
  }
  document.getElementById("pp-main").classList.remove("pp-hidden");
  await ppRenderSiteList();

  const addDomainInput = document.getElementById("pp-add-domain");
  const addBtn = document.getElementById("pp-add-btn");
  addDomainInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  });
  addBtn.addEventListener("click", async () => {
    const input = document.getElementById("pp-add-domain");
    const errorEl = document.getElementById("pp-add-error");
    errorEl.textContent = "";
    const res = await ppSend({ action: "lockDomain", domain: input.value });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not add site.";
      return;
    }
    input.value = "";
    ppRenderSiteList();
  });

  const modalPinInput = document.getElementById("pp-modal-pin");
  const modalConfirmBtn = document.getElementById("pp-modal-confirm");
  modalPinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      modalConfirmBtn.click();
    }
  });
  document.getElementById("pp-modal-cancel").addEventListener("click", ppCloseRemoveModal);
  modalConfirmBtn.addEventListener("click", async () => {
    const pin = document.getElementById("pp-modal-pin").value.trim();
    const errorEl = document.getElementById("pp-modal-error");
    if (!/^\d{6}$/.test(pin)) {
      errorEl.textContent = "Enter your 6-digit PIN.";
      return;
    }
    const res = await ppSend({ action: "unlockDomainPermanent", domain: pendingRemoveDomain, pin });
    if (!res.ok) {
      errorEl.textContent = res.lockedOut ? "Too many attempts. Try again shortly." : res.error || "Incorrect PIN.";
      return;
    }
    ppCloseRemoveModal();
    ppRenderSiteList();
  });

  const oldPinInput = document.getElementById("pp-old-pin");
  const newPin1Input = document.getElementById("pp-new-pin1");
  const newPin2Input = document.getElementById("pp-new-pin2");
  const changePinBtn = document.getElementById("pp-changepin-btn");
  [oldPinInput, newPin1Input, newPin2Input].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        changePinBtn.click();
      }
    });
  });
  changePinBtn.addEventListener("click", async () => {
    const oldPin = document.getElementById("pp-old-pin").value.trim();
    const newPin1 = document.getElementById("pp-new-pin1").value.trim();
    const newPin2 = document.getElementById("pp-new-pin2").value.trim();
    const errorEl = document.getElementById("pp-changepin-error");
    const successEl = document.getElementById("pp-changepin-success");
    errorEl.textContent = "";
    successEl.textContent = "";
    if (!/^\d{6}$/.test(oldPin) || !/^\d{6}$/.test(newPin1)) {
      errorEl.textContent = "PINs must be exactly 6 digits.";
      return;
    }
    if (newPin1 !== newPin2) {
      errorEl.textContent = "New PINs do not match.";
      return;
    }
    const res = await ppSend({ action: "changePin", oldPin, newPin: newPin1 });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not change PIN.";
      return;
    }
    successEl.textContent = "PIN updated.";
    document.getElementById("pp-old-pin").value = "";
    document.getElementById("pp-new-pin1").value = "";
    document.getElementById("pp-new-pin2").value = "";
  });

  const regenPinInput = document.getElementById("pp-regen-pin");
  const regenBtn = document.getElementById("pp-regen-btn");
  regenPinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      regenBtn.click();
    }
  });
  regenBtn.addEventListener("click", async () => {
    const pin = document.getElementById("pp-regen-pin").value.trim();
    const errorEl = document.getElementById("pp-regen-error");
    const keyEl = document.getElementById("pp-regen-key");
    errorEl.textContent = "";
    if (!/^\d{6}$/.test(pin)) {
      errorEl.textContent = "Enter your 6-digit PIN.";
      return;
    }
    const res = await ppSend({ action: "regenerateRecoveryKey", pin });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not regenerate key.";
      return;
    }
    keyEl.textContent = res.recoveryKey;
    keyEl.classList.remove("pp-hidden");
    document.getElementById("pp-regen-pin").value = "";
  });
}

document.addEventListener("DOMContentLoaded", ppInit);
