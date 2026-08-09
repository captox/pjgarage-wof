const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");
const { loadEnv } = require("./env");
const { signSpinToken, verifySpinToken, choosePrize, makeClaimCode, publicPrizePool } = require("./lib");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "dev-token-secret-change-me";
const BOT_SECRET = process.env.BOT_SECRET || "dev-bot-secret-change-me";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const PUBLIC_DIR = path.join(__dirname, "public");

const dbPath = path.join(__dirname, "data", "spins.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    user_id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    free_credit_granted INTEGER NOT NULL DEFAULT 0 CHECK(free_credit_granted IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS spin_credits (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    prize_id TEXT NOT NULL,
    prize_label TEXT NOT NULL,
    amount INTEGER NOT NULL,
    claim_code TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invite_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    label TEXT,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const rateBuckets = new Map();
function allowSpin(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 15;
  const current = rateBuckets.get(ip) || { start: now, count: 0 };
  if (now - current.start >= windowMs) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  rateBuckets.set(ip, current);
  return current.count <= limit;
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, value] of rateBuckets) if (value.start < cutoff) rateBuckets.delete(key);
}, 5 * 60_000).unref();

function safeEqualString(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }));
  res.end(body);
}

function html(res, status, body, extra = {}) {
  res.writeHead(status, securityHeaders({ "Content-Type": "text/html; charset=utf-8", ...extra }));
  res.end(body);
}

function text(res, status, body, extra = {}) {
  res.writeHead(status, securityHeaders({ "Content-Type": "text/plain; charset=utf-8", ...extra }));
  res.end(body);
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'",
    ...extra
  };
}

async function readBody(req, maxBytes = 50_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function adminAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return safeEqualString(decoded.slice(0, colon), ADMIN_USERNAME) && safeEqualString(decoded.slice(colon + 1), ADMIN_PASSWORD);
}

function requireAdmin(req, res) {
  if (adminAuthorized(req)) return true;
  text(res, 401, "Authentication required", { "WWW-Authenticate": 'Basic realm="Spin Admin"' });
  return false;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>\"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

function serveStatic(urlPath, res) {
  const map = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "application/javascript; charset=utf-8"]
  };
  const item = map[urlPath];
  if (!item) return false;
  const file = path.join(PUBLIC_DIR, item[0]);
  const body = fs.readFileSync(file);
  res.writeHead(200, securityHeaders({ "Content-Type": item[1], "Content-Length": body.length, "Cache-Control": urlPath === "/" ? "no-store" : "public, max-age=300" }));
  res.end(body);
  return true;
}

async function sendMessengerSpinButton(psid) {
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;
  const graphVersion = process.env.META_GRAPH_VERSION;
  if (!pageToken || !pageId || !graphVersion) {
    throw new Error("META_PAGE_ACCESS_TOKEN, META_PAGE_ID and META_GRAPH_VERSION must be configured.");
  }

  const token = signSpinToken(psid, TOKEN_SECRET);
  const spinUrl = `${PUBLIC_BASE_URL}/?t=${encodeURIComponent(token)}`;
  const endpoint = `https://graph.facebook.com/${graphVersion}/${pageId}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${pageToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "🎁 Your PJ GARAGE PROMO SPIN profile is ready. Tap below and enter your name. Credits are added by the administrator.",
            buttons: [{ type: "web_url", url: spinUrl, title: "🎡 Spin Now", webview_height_ratio: "tall" }]
          }
        }
      }
    })
  });
  if (!response.ok) throw new Error(`Meta API ${response.status}: ${await response.text()}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = u.pathname;

    if (req.method === "GET" && serveStatic(pathname, res)) return;

    if (req.method === "GET" && pathname === "/api/prizes") {
      return json(res, 200, { prizes: publicPrizePool() });
    }

    if (req.method === "POST" && pathname === "/api/status") {
      try {
        const body = await readJson(req);
        const payload = verifySpinToken(body.token, TOKEN_SECRET);
        const customer = db.prepare("SELECT first_name, last_name FROM customers WHERE user_id = ?").get(payload.sub);
        const row = db.prepare("SELECT balance FROM spin_credits WHERE user_id = ?").get(payload.sub);
        return json(res, 200, {
          registered: Boolean(customer),
          firstName: customer?.first_name || null,
          lastName: customer?.last_name || null,
          spinsRemaining: Number(row?.balance || 0)
        });
      } catch {
        return json(res, 400, { error: "This spin link is invalid or expired." });
      }
    }


    if (req.method === "POST" && pathname === "/api/register") {
      try {
        const body = await readJson(req);
        const payload = verifySpinToken(body.token, TOKEN_SECRET);
        const userId = payload.sub;
        const firstName = String(body.firstName || "").trim().replace(/\s+/g, " ");
        const lastName = String(body.lastName || "").trim().replace(/\s+/g, " ");
        const validName = value => /^[\p{L}\p{M} .'-]{1,60}$/u.test(value);
        if (!validName(firstName) || !validName(lastName)) {
          return json(res, 400, { error: "Please enter a valid first and last name." });
        }

        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = db.prepare("SELECT first_name, last_name FROM customers WHERE user_id = ?").get(userId);
          if (!existing) {
            db.prepare("INSERT INTO customers (user_id, first_name, last_name, free_credit_granted) VALUES (?, ?, ?, 0)").run(userId, firstName, lastName);
            db.prepare(`INSERT INTO spin_credits (user_id, balance) VALUES (?, 0)
              ON CONFLICT(user_id) DO NOTHING`).run(userId);
          } else {
            db.prepare("UPDATE customers SET first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(firstName, lastName, userId);
          }
          const credit = db.prepare("SELECT balance FROM spin_credits WHERE user_id = ?").get(userId);
          const customer = db.prepare("SELECT first_name, last_name FROM customers WHERE user_id = ?").get(userId);
          db.exec("COMMIT");
          return json(res, 200, { registered: true, firstName: customer.first_name, lastName: customer.last_name, spinsRemaining: Number(credit?.balance || 0) });
        } catch (err) {
          try { db.exec("ROLLBACK"); } catch {}
          throw err;
        }
      } catch {
        return json(res, 400, { error: "This spin link is invalid or expired." });
      }
    }

    if (req.method === "POST" && pathname === "/api/spin") {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (!allowSpin(ip)) return json(res, 429, { error: "Too many requests. Please try again shortly." });
      try {
        const body = await readJson(req);
        const payload = verifySpinToken(body.token, TOKEN_SECRET);
        const userId = payload.sub;
        const customer = db.prepare("SELECT user_id FROM customers WHERE user_id = ?").get(userId);
        if (!customer) return json(res, 409, { error: "Please enter your name first." });
        db.exec("BEGIN IMMEDIATE");
        try {
          const credit = db.prepare("SELECT balance FROM spin_credits WHERE user_id = ?").get(userId);
          const balance = Number(credit?.balance || 0);
          if (balance <= 0) {
            db.exec("ROLLBACK");
            return json(res, 409, { error: "No PJ Garage Promo Spin credits remaining.", spinsRemaining: 0 });
          }

          db.prepare("UPDATE spin_credits SET balance = balance - 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance > 0").run(userId);
          db.prepare("INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, -1, ?)").run(userId, "PJ Garage Promo Spin used");

          const prize = choosePrize();
          const claimCode = prize.amount > 0 ? makeClaimCode() : null;
          db.prepare("INSERT INTO spins (user_id, prize_id, prize_label, amount, claim_code) VALUES (?, ?, ?, ?, ?)").run(userId, prize.id, prize.label, prize.amount, claimCode);
          const left = db.prepare("SELECT balance FROM spin_credits WHERE user_id = ?").get(userId);
          db.exec("COMMIT");
          return json(res, 200, { prizeId: prize.id, prizeLabel: prize.label, amount: prize.amount, claimCode, spinsRemaining: Number(left?.balance || 0) });
        } catch (err) {
          try { db.exec("ROLLBACK"); } catch {}
          throw err;
        }
      } catch {
        return json(res, 400, { error: "This spin link is invalid or expired." });
      }
    }

    if (req.method === "POST" && pathname === "/api/create-spin-link") {
      if (!safeEqualString(req.headers["x-bot-secret"], BOT_SECRET)) return json(res, 401, { error: "Unauthorized" });
      const body = await readJson(req);
      const userId = String(body.userId || "").trim();
      if (!userId || userId.length > 200) return json(res, 400, { error: "A valid userId is required." });
      const token = signSpinToken(userId, TOKEN_SECRET);
      return json(res, 200, { url: `${PUBLIC_BASE_URL}/?t=${encodeURIComponent(token)}` });
    }

    if (req.method === "GET" && pathname === "/webhook") {
      if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === process.env.META_VERIFY_TOKEN) {
        return text(res, 200, u.searchParams.get("hub.challenge") || "");
      }
      return text(res, 403, "Forbidden");
    }

    if (req.method === "POST" && pathname === "/webhook") {
      const body = await readJson(req);
      text(res, 200, "EVENT_RECEIVED");
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event.sender?.id;
          const messageText = event.message?.text?.trim()?.toLowerCase();
          if (psid && messageText === "spin") {
            sendMessengerSpinButton(psid).catch(err => console.error("Messenger send failed:", err.message));
          }
        }
      }
      return;
    }


    if (req.method === "GET" && pathname === "/admin") {
      if (!requireAdmin(req, res)) return;
      const invites = db.prepare(`SELECT i.id, i.user_id, i.label, i.token, i.created_at, cu.first_name, cu.last_name
        FROM invite_links i LEFT JOIN customers cu ON cu.user_id = i.user_id
        ORDER BY i.id DESC LIMIT 200`).all();
      const customers = db.prepare(`SELECT cu.user_id, cu.first_name, cu.last_name, cu.created_at, COALESCE(sc.balance,0) AS balance,
        (SELECT COUNT(*) FROM spins s2 WHERE s2.user_id = cu.user_id) AS spin_count
        FROM customers cu LEFT JOIN spin_credits sc ON sc.user_id = cu.user_id
        ORDER BY cu.created_at DESC LIMIT 2000`).all();
      const rows = db.prepare(`SELECT s.*, COALESCE(c.balance,0) AS balance, cu.first_name, cu.last_name
        FROM spins s
        LEFT JOIN spin_credits c ON c.user_id = s.user_id
        LEFT JOIN customers cu ON cu.user_id = s.user_id
        ORDER BY s.id DESC LIMIT 1000`).all();
      const customerCount = db.prepare("SELECT COUNT(*) AS count FROM customers").get();
      const totals = db.prepare(`SELECT COUNT(*) AS spins, SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS winners, COALESCE(SUM(amount),0) AS payout, COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL THEN amount ELSE 0 END),0) AS claimed FROM spins`).get();
      const creditTotal = db.prepare("SELECT COALESCE(SUM(balance),0) AS available FROM spin_credits").get();
      const inviteRows = invites.map(i => {
        const spinUrl = `${PUBLIC_BASE_URL}/?t=${encodeURIComponent(i.token)}`;
        const registeredName = [i.first_name, i.last_name].filter(Boolean).join(" ");
        return `<tr><td>${i.id}</td><td>${esc(i.label || "-")}</td><td>${esc(registeredName || "Not registered")}</td><td>${esc(i.user_id)}</td><td><input class="linkbox" value="${esc(spinUrl)}" readonly onclick="this.select()"></td><td>${esc(i.created_at)}</td></tr>`;
      }).join("");
      const customerRows = customers.map(c => `<tr><td>${esc([c.first_name,c.last_name].filter(Boolean).join(" "))}</td><td>${esc(c.user_id)}</td><td>${c.balance}</td><td>${c.spin_count}</td><td><form class="grant" method="post" action="/admin/grant"><input type="hidden" name="userId" value="${esc(c.user_id)}"><input name="credits" inputmode="numeric" type="number" min="1" max="100" value="1" required><button>Add credits</button></form></td><td>${esc(c.created_at)}</td></tr>`).join("");
      const bodyRows = rows.map(r => `<tr><td>${r.id}</td><td>${esc([r.first_name,r.last_name].filter(Boolean).join(" ") || "-")}</td><td>${esc(r.user_id)}</td><td>${r.balance}</td><td>${esc(r.prize_label)}</td><td>₱${r.amount}</td><td>${esc(r.claim_code || "-")}</td><td>${esc(r.created_at)}</td><td>${r.claimed_at ? `Claimed ${esc(r.claimed_at)}` : (r.amount > 0 ? `<form method="post" action="/admin/claim/${r.id}"><button>Mark claimed</button></form>` : "-")}</td></tr>`).join("");
      return html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spin Admin</title><style>body{font-family:system-ui;margin:20px;background:#f6f7fb;color:#1d2330}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:white;padding:16px;border-radius:14px;box-shadow:0 4px 18px #0001;min-width:140px}.panel{background:white;padding:16px;border-radius:14px;box-shadow:0 4px 18px #0001;margin-top:16px}.wrap{overflow:auto;background:white;border-radius:14px;margin-top:16px}table{width:100%;border-collapse:collapse;font-size:14px;min-width:800px}th,td{padding:10px;border-bottom:1px solid #e7e9ef;text-align:left}th{background:#fff;position:sticky;top:0}.grant,.create{display:flex;gap:6px;flex-wrap:wrap}.grant input{width:64px}.create input{min-width:260px;flex:1}.grant input,.create input,.linkbox{padding:8px;border:1px solid #ccd1da;border-radius:8px}.linkbox{width:360px;max-width:70vw}button{padding:9px 12px;border-radius:8px;border:1px solid #ccd1da;background:white;cursor:pointer}h2{margin-top:28px}.hint{color:#616a78}</style></head><body><h1>Promotional Spin Admin</h1><div class="cards"><div class="card"><b>${customerCount.count}</b><br>Registered customers</div><div class="card"><b>${totals.spins}</b><br>Completed spins</div><div class="card"><b>${creditTotal.available}</b><br>Unused credits</div><div class="card"><b>${totals.winners || 0}</b><br>Winners</div><div class="card"><b>₱${totals.payout}</b><br>Total awarded</div><div class="card"><b>₱${totals.claimed}</b><br>Claimed</div></div><div class="panel"><h2 style="margin-top:0">Create customer link</h2><form class="create" method="post" action="/admin/create-link"><input name="label" maxlength="80" placeholder="Optional label, e.g. Messenger Aug 9 #42"><button>Generate secure link</button></form><p class="hint"><small>Each generated link has its own customer ID. Send the link to one person. They register their name with 0 credits, then you grant credits below.</small></p></div><h2>Recent generated links</h2><div class="wrap"><table><thead><tr><th>#</th><th>Label</th><th>Registered name</th><th>User ID</th><th>Personal link</th><th>Created</th></tr></thead><tbody>${inviteRows || '<tr><td colspan="6">No links generated yet.</td></tr>'}</tbody></table></div><p class="hint"><small>Click inside a link field, then Ctrl+C to copy it.</small></p><h2>Customers & credit grants</h2><div class="wrap"><table><thead><tr><th>Name</th><th>User ID</th><th>Credits</th><th>Spins</th><th>Grant</th><th>Registered</th></tr></thead><tbody>${customerRows || '<tr><td colspan="6">No registered customers yet.</td></tr>'}</tbody></table></div><h2>Spin history</h2><div class="wrap"><table><thead><tr><th>ID</th><th>Name</th><th>User ID</th><th>Credits left</th><th>Result</th><th>Amount</th><th>Claim code</th><th>Time</th><th>Status</th></tr></thead><tbody>${bodyRows || '<tr><td colspan="9">No spins yet.</td></tr>'}</tbody></table></div></body></html>`);
    }

    if (req.method === "POST" && pathname === "/admin/create-link") {
      if (!requireAdmin(req, res)) return;
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      const label = String(form.get("label") || "").trim().slice(0, 80);
      const userId = `C-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
      const token = signSpinToken(userId, TOKEN_SECRET);
      db.prepare("INSERT INTO invite_links (user_id, label, token) VALUES (?, ?, ?)").run(userId, label || null, token);
      res.writeHead(303, securityHeaders({ Location: "/admin" }));
      return res.end();
    }

    if (req.method === "POST" && pathname === "/admin/grant") {
      if (!requireAdmin(req, res)) return;
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      const userId = String(form.get("userId") || "").trim();
      const credits = Number.parseInt(String(form.get("credits") || ""), 10);
      if (!userId || !Number.isInteger(credits) || credits < 1 || credits > 100) return text(res, 400, "Invalid credit grant");
      const customer = db.prepare("SELECT user_id FROM customers WHERE user_id = ?").get(userId);
      if (!customer) return text(res, 404, "Customer not found");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO spin_credits (user_id, balance) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET balance = spin_credits.balance + excluded.balance, updated_at = CURRENT_TIMESTAMP`).run(userId, credits);
        db.prepare("INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)").run(userId, credits, "Manual admin promotional credit grant");
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
      res.writeHead(303, securityHeaders({ Location: "/admin" }));
      return res.end();
    }

    const claimMatch = pathname.match(/^\/admin\/claim\/(\d+)$/);
    if (req.method === "POST" && claimMatch) {
      if (!requireAdmin(req, res)) return;
      db.prepare("UPDATE spins SET claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP) WHERE id = ? AND amount > 0").run(Number(claimMatch[1]));
      res.writeHead(303, securityHeaders({ Location: "/admin" }));
      return res.end();
    }

    return text(res, 404, "Not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return json(res, 500, { error: "Internal server error" });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Free Spin Wheel running at ${PUBLIC_BASE_URL}`);
  if (TOKEN_SECRET.includes("change-me") || ADMIN_PASSWORD === "change-me") console.warn("WARNING: replace development secrets before deploying publicly.");
});
