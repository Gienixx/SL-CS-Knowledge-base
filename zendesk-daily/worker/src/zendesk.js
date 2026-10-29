const API_VERSION = "v2";
const MAX_RETRIES = 5;

export function apiBase(subdomain) {
  if (!/^[a-z0-9-]+$/i.test(subdomain || "")) throw new Error("invalid Zendesk subdomain");
  return `https://${subdomain}.zendesk.com/api/${API_VERSION}`;
}

export async function requestWithRetry(url, accessToken, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const managed = typeof accessToken?.getToken === "function";
  if (managed && new URL(url).origin !== accessToken.origin) throw new Error("Unexpected Zendesk API origin");
  let token = managed ? await accessToken.getToken() : null;
  let renewed = false;
  let authorization = managed ? `Bearer ${token}` : typeof accessToken === "string" ? `Bearer ${accessToken}` : accessToken?.authorization;
  if (!authorization || !/^(Bearer|Basic)\s+\S+$/i.test(authorization)) throw new Error("Zendesk authorization is required");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (managed) {
      token = await accessToken.getToken();
      authorization = `Bearer ${token}`;
    }
    let response;
    try { response = await fetchImpl(url, { redirect: "error", headers: { Authorization: authorization, Accept: "application/json" } }); }
    catch { throw new Error("Zendesk API request failed (network)"); }
    if (response.status === 401 && managed && !renewed) {
      renewed = true;
      token = await accessToken.getToken(token);
      authorization = `Bearer ${token}`;
      try { response = await fetchImpl(url, { redirect: "error", headers: { Authorization: authorization, Accept: "application/json" } }); }
      catch { throw new Error("Zendesk API request failed (network)"); }
    }
    if (response.ok) return response;
    if (response.status !== 429 && response.status < 500) throw new Error(`Zendesk API request failed (${response.status})`);
    if (attempt === MAX_RETRIES) throw new Error(`Zendesk API retry limit reached (${response.status})`);
    const retryAfter = Number(response.headers.get("retry-after"));
    const resetSeconds = Number(response.headers.get("ratelimit-reset") || response.headers.get("zendesk-ratelimit-reset"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000
      : Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000
      : Math.min(30_000, 500 * (2 ** attempt));
    await sleep(delay);
  }
  throw new Error("Zendesk API request failed");
}

export async function fetchCursorPages(firstUrl, accessToken, { fetchImpl = fetch, checkpoint, onPage, maxPages = Infinity, minIntervalMs = 0, sleepImpl = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let url = firstUrl;
  const seen = new Set();
  let lastUpdatedAt = null;
  let pages = 0;
  let lastRequestAt = null;
  while (url && pages < maxPages) {
    if (seen.has(url)) throw new Error("Zendesk pagination loop detected");
    seen.add(url);
    if (lastRequestAt !== null && minIntervalMs > 0) {
      const remaining = minIntervalMs - (Date.now() - lastRequestAt);
      if (remaining > 0) await sleepImpl(remaining);
    }
    lastRequestAt = Date.now();
    const response = await requestWithRetry(url, accessToken, fetchImpl);
    const page = await response.json();
    const items = page.tickets || page.ticket_metric_events || page.satisfaction_ratings || page.audits || [];
    for (const item of items) {
      const itemWatermark = sourceTimestamp(item);
      if (itemWatermark && (!lastUpdatedAt || itemWatermark > lastUpdatedAt)) lastUpdatedAt = itemWatermark;
    }
    if (onPage) await onPage(items, page);
    url = page.next_page || page.after_url || null;
    if (checkpoint) await checkpoint(url, lastUpdatedAt, items.length);
    pages++;
  }
  return { lastUpdatedAt, nextPage: url, pages };
}

export function minimalTicket(ticket) {
  return { id: ticket.id, created_at: ticket.created_at, updated_at: ticket.updated_at, generated_timestamp: ticket.generated_timestamp, status: ticket.status, assignee_id: ticket.assignee_id, via_channel: ticket.via?.channel ?? null };
}

export function sourceTimestamp(ticket) {
  const value = ticket.generated_timestamp || ticket.updated_at;
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const millis = Number.isFinite(numeric) && /^\d{9,13}$/.test(String(value)) ? (String(value).length <= 10 ? numeric * 1000 : numeric) : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function minimalAudit(audit, knownAgentIds) {
  const authorId = Number(audit.author_id);
  let status = null, assigneeChanged = false, assigneeId = null, publicComment = false;
  for (const event of audit.events || []) {
    if (event.type === "Change" && event.field_name === "status" && event.value === "solved") status = "solved";
    if (event.type === "Change" && event.field_name === "assignee_id") {
      assigneeChanged = true;
      assigneeId = event.value === null || event.value === "" ? null : Number(event.value);
    }
    if (event.type === "Comment" && event.public === true && knownAgentIds.has(authorId)) publicComment = true;
  }
  return { id: audit.id, ticketId: audit.ticket_id, at: audit.created_at, authorId, status, assigneeChanged, assigneeId, publicComment };
}

export async function listAgentIdsByUsername(subdomain, accessToken, usernames, fetchImpl = fetch) {
  const found = {};
  for (const username of usernames) {
    const url = `${apiBase(subdomain)}/users/search?query=${encodeURIComponent(username)}&per_page=100`;
    const response = await requestWithRetry(url, accessToken, fetchImpl);
    const body = await response.json();
    found[username] = (body.users || []).map(user => ({ id: user.id, name: user.name, role: user.role, active: user.active }));
  }
  return found;
}

export async function getTicketMetrics(subdomain, ticketId, accessToken, fetchImpl = fetch) {
  const response = await requestWithRetry(`${apiBase(subdomain)}/tickets/${encodeURIComponent(ticketId)}/metrics`, accessToken, fetchImpl);
  const body = await response.json();
  const metricValue = body.ticket_metric || body.ticket_metrics || null;
  const metric = Array.isArray(metricValue) ? metricValue[0] : metricValue;
  return metric && {
    ticket_id: metric.ticket_id,
    solved_at: metric.solved_at,
    reply_time_in_minutes: metric.reply_time_in_minutes,
    requester_wait_time_in_minutes: metric.requester_wait_time_in_minutes,
    full_resolution_time_in_minutes: metric.full_resolution_time_in_minutes,
    replies: metric.replies,
    reopens: metric.reopens
  };
}

export async function getTicketAudits(subdomain, ticketId, accessToken, fetchImpl = fetch, roleCache = new Map()) {
  const start = `${apiBase(subdomain)}/tickets/${encodeURIComponent(ticketId)}/audits?filter_events%5B%5D=Comment&filter_events%5B%5D=Change&page[size]=100`;
  const rawAudits = [];
  await fetchCursorPages(start, accessToken, { fetchImpl, onPage: page => rawAudits.push(...page) });
  const authorIds = [...new Set(rawAudits.filter(a => (a.events || []).some(e => e.type === "Comment" && e.public === true)).map(a => Number(a.author_id)).filter(Number.isSafeInteger))];
  const missing = authorIds.filter(id => !roleCache.has(id));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const ids = missing.slice(offset, offset + 100);
    if (!ids.length) continue;
    const response = await requestWithRetry(`${apiBase(subdomain)}/users/show_many?ids=${ids.join(",")}`, accessToken, fetchImpl);
    const { users = [] } = await response.json();
    for (const user of users) roleCache.set(Number(user.id), user.role === "admin" || user.role === "agent" || user.role === "light_agent" || user.role === "light-agent" || Boolean(user.role && user.role !== "end-user"));
    for (const id of ids) if (!roleCache.has(id)) roleCache.set(id, false);
  }
  const agentAuthors = new Set(authorIds.filter(id => roleCache.get(id)));
  return rawAudits.map(a => minimalAudit(a, agentAuthors)).sort((a, b) => a.at.localeCompare(b.at));
}

export async function getSatisfactionRatings(subdomain, startEpoch, endEpoch, accessToken, fetchImpl = fetch, onPage) {
  const start = `${apiBase(subdomain)}/satisfaction_ratings?start_time=${startEpoch}&end_time=${endEpoch}&page[size]=100`;
  const selected = [];
  await fetchCursorPages(start, accessToken, { fetchImpl, onPage: async (items, page) => {
    selected.push(...items.map(r => ({ ticket_id: r.ticket_id, created_at: r.created_at, updated_at: r.updated_at, score: r.score, assignee_id: r.assignee_id })));
    if (onPage) await onPage(page.next_page || null);
  } });
  return selected;
}
