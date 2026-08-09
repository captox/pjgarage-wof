const { loadEnv } = require("../env");
const { signSpinToken } = require("../lib");
loadEnv();

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: npm run create-link -- USER_ID");
  process.exit(1);
}
const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const secret = process.env.TOKEN_SECRET || "dev-token-secret-change-me";
const token = signSpinToken(userId, secret);
console.log(`${base}/?t=${encodeURIComponent(token)}`);
