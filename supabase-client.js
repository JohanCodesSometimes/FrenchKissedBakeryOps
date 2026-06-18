const { createClient } = require("@supabase/supabase-js");

function getSupabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || "").trim();
  const anonKey = String(env.SUPABASE_ANON_KEY || "").trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const configuredValues = [url, anonKey, serviceRoleKey].filter(Boolean).length;

  return {
    enabled: configuredValues === 3,
    partial: configuredValues > 0 && configuredValues < 3,
    url,
    anonKey,
    serviceRoleKey,
  };
}

function createServerSupabaseClient(config) {
  if (!config.enabled) throw new Error("Supabase configuration is incomplete");
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "X-Client-Info": "bakeryops-ai-server" },
    },
  });
}

module.exports = { getSupabaseConfig, createServerSupabaseClient };
