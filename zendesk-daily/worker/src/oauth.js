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

export async function getRefreshAccessToken(env, fetchImpl = fetch) {
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

// Tokens are held only in the auth closure; never in D1, environment, or logs.
export function createClientCredentialsAuth(env, fetchImpl = fetch, now = Date.now) {
  const subdomain = env.ZENDESK_SUBDOMAIN;
  if (!/^[a-z0-9-]+$/i.test(subdomain || "")) throw new Error("invalid Zendesk subdomain");
  if (!env.ZENDESK_OAUTH_CLIENT_ID || !env.ZENDESK_OAUTH_CLIENT_SECRET) {
    throw new Error("Zendesk OAuth Client Credentials are not configured");
  }
  const origin = `https://${subdomain}.zendesk.com`;
  let token, expiresAt = 0, pending;
  async function acquire() {
    const started = now();
    let response;
    try {
      response = await fetchImpl(`${origin}/oauth/tokens`, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: env.ZENDESK_OAUTH_CLIENT_ID,
          client_secret: env.ZENDESK_OAUTH_CLIENT_SECRET, scope: "read" })
      });
    } catch { throw new Error("Zendesk OAuth token request failed (network)"); }
    if (!response.ok) throw new Error(`Zendesk OAuth token request failed (${response.status})`);
    let body;
    try { body = await response.json(); } catch { throw new Error("Invalid Zendesk OAuth token response"); }
    if (!body || typeof body !== "object") throw new Error("Invalid Zendesk OAuth token response");
    const lifetime = Number(body.expires_in);
    if (typeof body.access_token !== "string" || !body.access_token || /\s/.test(body.access_token)
      || !Number.isFinite(lifetime) || lifetime <= 0
      || (body.token_type !== undefined && (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"))
      || (body.scope && body.scope !== "read")) throw new Error("Invalid Zendesk OAuth token response");
    token = body.access_token;
    expiresAt = started + lifetime * 1000;
    return token;
  }
  async function getToken(rejectedToken) {
    if (rejectedToken && token === rejectedToken) expiresAt = 0;
    if (token && now() < expiresAt) return token;
    if (!pending) pending = acquire().finally(() => { pending = undefined; });
    return pending;
  }
  return Object.freeze({ method: "OAuth Client Credentials", origin, getToken });
}

export async function getAccessToken(env, fetchImpl = fetch) {
  return createClientCredentialsAuth(env, fetchImpl).getToken();
}
