function ppSend(msg) {
  return chrome.runtime.sendMessage(msg);
}

document.addEventListener("DOMContentLoaded", () => {
  const stepPin = document.getElementById("pp-step-pin");
  const stepRecovery = document.getElementById("pp-step-recovery");
  const stepDone = document.getElementById("pp-step-done");

  const pin1 = document.getElementById("pp-pin1");
  const pin2 = document.getElementById("pp-pin2");
  const errorEl = document.getElementById("pp-pin-error");
  const createBtn = document.getElementById("pp-create-btn");

  pin1.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pin2.focus();
    }
  });
  pin2.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createBtn.click();
    }
  });

  createBtn.addEventListener("click", async () => {
    errorEl.textContent = "";
    const a = pin1.value.trim();
    const b = pin2.value.trim();
    if (!/^\d{6}$/.test(a)) {
      errorEl.textContent = "PIN must be exactly 6 digits.";
      return;
    }
    if (a !== b) {
      errorEl.textContent = "PINs do not match.";
      return;
    }
    const res = await ppSend({ action: "setupPin", pin: a });
    if (!res.ok) {
      errorEl.textContent = res.error || "Something went wrong.";
      return;
    }
    document.getElementById("pp-recovery-key").textContent = res.recoveryKey;
    stepPin.classList.add("pp-hidden");
    stepRecovery.classList.remove("pp-hidden");
  });

  const confirmBox = document.getElementById("pp-recovery-confirm");
  const finishBtn = document.getElementById("pp-finish-btn");
  confirmBox.addEventListener("change", () => {
    finishBtn.disabled = !confirmBox.checked;
  });
  finishBtn.addEventListener("click", () => {
    stepRecovery.classList.add("pp-hidden");
    stepDone.classList.remove("pp-hidden");
  });

  document.getElementById("pp-open-options-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
