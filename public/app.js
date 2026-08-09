const registerPanel = document.getElementById("registerPanel");
const registerForm = document.getElementById("registerForm");
const registerStatus = document.getElementById("registerStatus");
const firstNameInput = document.getElementById("firstName");
const lastNameInput = document.getElementById("lastName");
const wheelPanel = document.getElementById("wheelPanel");
const welcome = document.getElementById("welcome");
const wheel = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const resultTitle = document.getElementById("resultTitle");
const resultIcon = document.getElementById("resultIcon");
const claimWrap = document.getElementById("claimWrap");
const claimCode = document.getElementById("claimCode");
const prizePoolEl = document.getElementById("prizePool");
const balanceEl = document.getElementById("balance");

const token = new URLSearchParams(location.search).get("t");
let prizes = [];
let rotation = 0;

async function init() {
  const r = await fetch("/api/prizes");
  const data = await r.json();
  prizes = data.prizes;
  renderWheelLabels();
  prizePoolEl.innerHTML = `<div class="prize-grid">${prizes.filter(p => p.amount > 0).map(p => `<span>${escapeHtml(p.shortLabel)}</span>`).join("")}</div>`;

  if (!token) {
    registerPanel.classList.remove("hidden");
    registerForm.classList.add("hidden");
    registerStatus.textContent = "Open your personal spin link to continue.";
    return;
  }

  await refreshStatus();
}

async function refreshStatus() {
  const response = await fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const data = await response.json();
  if (!response.ok) {
    registerPanel.classList.remove("hidden");
    registerForm.classList.add("hidden");
    registerStatus.textContent = data.error || "Could not verify this spin link.";
    return;
  }

  if (!data.registered) {
    wheelPanel.classList.add("hidden");
    registerPanel.classList.remove("hidden");
    registerForm.classList.remove("hidden");
    registerStatus.textContent = "";
    return;
  }

  showWheel(data);
}

registerForm.addEventListener("submit", async event => {
  event.preventDefault();
  const firstName = firstNameInput.value.trim();
  const lastName = lastNameInput.value.trim();
  if (!firstName || !lastName) return;

  const button = registerForm.querySelector("button");
  button.disabled = true;
  registerStatus.textContent = "Creating your spin profile…";
  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, firstName, lastName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Registration failed");
    showWheel(data);
  } catch (err) {
    registerStatus.textContent = err.message;
    button.disabled = false;
  }
});

function showWheel(data) {
  registerPanel.classList.add("hidden");
  wheelPanel.classList.remove("hidden");
  welcome.textContent = data.firstName ? `Welcome, ${data.firstName}. Your spin profile is ready.` : "Your spin profile is ready.";
  updateBalance(data.spinsRemaining);
}

function renderWheelLabels() {
  document.querySelectorAll(".wheel-label").forEach(x => x.remove());
  const sectorSize = 360 / prizes.length;
  const radius = 33; // percent of wheel diameter from center

  prizes.forEach((p, i) => {
    // Angle 0 is the fixed pointer at 12 o'clock; angles increase clockwise.
    const angle = i * sectorSize;
    const rad = angle * Math.PI / 180;
    const x = 50 + radius * Math.sin(rad);
    const y = 50 - radius * Math.cos(rad);

    const label = document.createElement("div");
    label.className = "wheel-label";
    label.style.left = `${x}%`;
    label.style.top = `${y}%`;
    label.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    label.textContent = p.shortLabel;
    wheel.appendChild(label);
  });
}

spinBtn.addEventListener("click", async () => {
  if (!token) return;
  spinBtn.disabled = true;
  resultEl.classList.add("hidden");
  statusEl.textContent = "Checking your spin…";

  try {
    const response = await fetch("/api/spin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Spin failed");

    const index = prizes.findIndex(p => p.id === data.prizeId);
    if (index < 0) throw new Error("Prize result could not be mapped to the wheel.");

    const sectorSize = 360 / prizes.length;

    // The wheel artwork is drawn with prize index 0 centered exactly under
    // the pointer (0 degrees). Each following prize center is +45 degrees
    // clockwise. To bring the selected prize under the fixed pointer, rotate
    // the wheel by the negative of that center angle.
    const selectedCenter = index * sectorSize;

    // Keep the final stop safely inside the selected wedge.
    const safeOffset = (Math.random() - 0.5) * sectorSize * 0.30;
    const desiredAngle = -(selectedCenter + safeOffset);
    const targetNormalized = ((desiredAngle % 360) + 360) % 360;
    const currentNormalized = ((rotation % 360) + 360) % 360;
    const delta = ((targetNormalized - currentNormalized + 360) % 360) + 360 * 6;
    rotation += delta;

    statusEl.textContent = "Spinning…";
    wheel.style.transform = `rotate(${rotation}deg)`;
    setTimeout(() => showResult(data), 5250);
  } catch (err) {
    statusEl.textContent = err.message;
    spinBtn.disabled = false;
  }
});

function showResult(data) {
  statusEl.textContent = "Spin complete.";
  updateBalance(data.spinsRemaining);
  resultEl.classList.remove("hidden");
  resultTitle.textContent = data.prizeLabel;
  resultIcon.textContent = data.amount > 0 ? "🎉" : "🍀";
  if (data.claimCode) {
    claimCode.textContent = data.claimCode;
    claimWrap.classList.remove("hidden");
  } else {
    claimWrap.classList.add("hidden");
  }
  spinBtn.disabled = Number(data.spinsRemaining || 0) <= 0;
}

function updateBalance(count) {
  const n = Number(count || 0);
  balanceEl.textContent = `${n} PJ Garage Promo Spin credit${n === 1 ? "" : "s"} remaining`;
  spinBtn.disabled = n <= 0;
  if (n <= 0) statusEl.textContent = "No spin credits available yet.";
  else statusEl.textContent = "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
}

init().catch(() => {
  registerPanel.classList.remove("hidden");
  registerStatus.textContent = "Could not load the game.";
  spinBtn.disabled = true;
});
