function b64bytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function bytesB64(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

async function cryptoKey(env) {
  if (!env.OAUTH_ENCRYPTION_KEY) throw new Error("OAUTH_ENCRYPTION_KEY is required");
  const raw = b64bytes(env.OAUTH_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("OAUTH_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(text, env) {
  const key = await cryptoKey(env), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return `${bytesB64(iv)}.${bytesB64(ciphertext)}`;
}

async function decrypt(value, env) {
  const [iv, ciphertext] = value.split(".");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64bytes(iv) }, await cryptoKey(env), b64bytes(ciphertext));
  return new TextDecoder().decode(clear);
}

async function saveRefreshToken(db, token, env) {
  const ciphertext = await encrypt(token, env);
  await db.prepare("INSERT INTO oauth_state (name, encrypted_value, updated_at) VALUES ('zendesk_refresh_token', ?, datetime('now')) ON CONFLICT(name) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at")
    .bind(ciphertext).run();
}

export async function getAccessToken(env, fetchImpl = fetch) {
  const db = env.REPORTING_DB;
  if (!db || !env.ZENDESK_SUBDOMAIN || !env.ZENDESK_OAUTH_CLIENT_ID || !env.ZENDESK_OAUTH_CLIENT_SECRET) {
    throw new Error("Zendesk OAuth Worker secrets and REPORTING_DB are not configured");
  }
  const stored = await db.prepare("SELECT encrypted_value FROM oauth_state WHERE name='zendesk_refresh_token'").first();
  const storedToken = stored?.encrypted_value ? await decrypt(stored.encrypted_value, env) : null;
  const candidates = [...new Set([storedToken, env.ZENDESK_REFRESH_TOKEN].filter(Boolean))];
  if (!candidates.length) throw new Error("No Zendesk OAuth refresh token is configured");
  let lastStatus = null;
  for (const refreshToken of candidates) {
    const response = await fetchImpl(`https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.ZENDESK_OAUTH_CLIENT_ID, client_secret: env.ZENDESK_OAUTH_CLIENT_SECRET })
    });
    if (response.ok) {
      const tokens = await response.json();
      if (!tokens.access_token || !tokens.refresh_token) throw new Error("Zendesk OAuth response omitted a token required for rotation");
      await saveRefreshToken(db, tokens.refresh_token, env);
      return tokens.access_token;
    }
    lastStatus = response.status;
    if (response.status !== 400 && response.status !== 401) break;
  }
  throw new Error(`Zendesk OAuth refresh failed (${lastStatus}); rotate the OAuth refresh token and check its expiry`);
}
