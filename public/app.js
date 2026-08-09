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

    // Fixed visual landing map. The wheel artwork is eight equal 45° wedges:
    // 0 Try Again, 1 ₱10, 2 ₱20, 3 ₱50, 4 ₱100, 5 ₱200, 6 ₱1,000, 7 ₱5,000.
    // Each value is the wheel rotation needed to put that wedge center at
    // the fixed 12 o'clock pointer. Using explicit values avoids coordinate
    // normalization/orientation drift between browsers.
    const landingAngles = [0, 315, 270, 225, 180, 135, 90, 45];
    const sectorSize = 45;

    // Small visual variation, but always safely inside the selected wedge.
    const safeOffset = (Math.random() - 0.5) * 10; // ±5°, wedge half-width is 22.5°
    const desiredModulo = landingAngles[index] + safeOffset;

    // Always move forward at least six complete turns from the current angle.
    // Then finish at the exact modulo angle assigned to the server result.
    const currentModulo = ((rotation % 360) + 360) % 360;
    let forwardDelta = ((desiredModulo - currentModulo) % 360 + 360) % 360;
    rotation += 2160 + forwardDelta;

    statusEl.textContent = "Spinning…";
    wheel.dataset.serverPrize = data.prizeId;
    wheel.dataset.serverIndex = String(index);
    wheel.style.transform = `rotate(${rotation}deg)`;

    // transitionend is the authoritative moment. A timeout is kept only as
    // a fallback for browsers that suppress transition events.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      showResult(data);
    };
    wheel.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 5600);
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
