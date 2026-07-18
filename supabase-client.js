const { createClient } = require("@supabase/supabase-js");
const DATABASE_REQUEST_TIMEOUT_MS = 12_000;

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
      fetch: fetchWithTimeout,
    },
  });
}

async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DATABASE_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

module.exports = { DATABASE_REQUEST_TIMEOUT_MS, createServerSupabaseClient, fetchWithTimeout, getSupabaseConfig };
