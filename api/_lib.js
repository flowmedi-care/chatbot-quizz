const { createClient } = require("@supabase/supabase-js");

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variaveis de ambiente do Vercel.");
  }
  return createClient(url, key);
}

function pickTargetGroupJid() {
  const raw = process.env.TARGET_GROUP_JIDS || "";
  const first = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || null;
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = { getClient, pickTargetGroupJid, applyCors };
