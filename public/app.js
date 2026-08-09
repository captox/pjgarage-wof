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

const shortLinkMatch = location.pathname.match(/^\/s\/([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})\/?$/i);
// The API field is still named `token` for backward compatibility, but it can
// now contain either a short invite code or an older signed token.
const token = shortLinkMatch ? shortLinkMatch[1].toUpperCase() : new URLSearchParams(location.search).get("t");
let prizes = [];
let rotation = 0;

// Visual order around the wheel, starting at the fixed 12 o'clock pointer
// and moving clockwise.
const VISUAL_ORDER = [
  "none",
  "p5000",
  "p1000",
  "p200",
  "p100",
  "p50",
  "p20",
  "p10"
];

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

  const visualPrizes = VISUAL_ORDER.map(id => prizes.find(p => p.id === id)).filter(Boolean);
  const sectorSize = 360 / visualPrizes.length;
  const radius = 33; // percent of wheel diameter from center

  visualPrizes.forEach((p, i) => {
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

    const visualIndex = VISUAL_ORDER.indexOf(data.prizeId);
    if (visualIndex < 0) throw new Error("Prize result could not be mapped to the wheel.");

    // The visible wheel order is:
    // Try Again → ₱5,000 → ₱1,000 → ₱200 → ₱100 → ₱50 → ₱20 → ₱10
    // starting at the 12 o'clock pointer and moving clockwise.
    //
    // A wedge centered at visual angle A needs a wheel rotation of (360 - A)
    // to bring that wedge back under the fixed pointer.
    const sectorSize = 45;
    const visualAngle = visualIndex * sectorSize;

    // Small visual variation, while staying safely inside the selected wedge.
    const safeOffset = (Math.random() - 0.5) * 10; // ±5°
    const desiredModulo = ((360 - visualAngle) + safeOffset + 360) % 360;

    // Spin CLOCKWISE for at least six full turns, then finish on the
    // server-selected visual wedge.
    const currentModulo = ((rotation % 360) + 360) % 360;
    const forwardDelta = ((desiredModulo - currentModulo) % 360 + 360) % 360;
    rotation += 2160 + forwardDelta;

    statusEl.textContent = "Spinning…";
    wheel.dataset.serverPrize = data.prizeId;
    wheel.dataset.serverIndex = String(visualIndex);
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
