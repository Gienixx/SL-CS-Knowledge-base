import { dayBoundsPht, isWithin } from "../worker/src/analytics.js";
import { apiBase, getTicketAudits, getTicketMetrics, requestWithRetry } from "../worker/src/zendesk.js";
import { pathToFileURL } from "node:url";

export const CANDIDATE_USERS = [
  { key: "amora", label: "Amora / Amor", id: "7741200383892", reporting: true },
  { key: "arby", label: "Arby", id: "45529189471380", reporting: true },
  { key: "arez", label: "Arez", id: "7741235860628", reporting: false },
  { key: "ford", label: "Ford", id: "12697099220884", reporting: true },
  { key: "gen", label: "Gen", id: "34717107952788", reporting: true },
  { key: "tommy", label: "Tommy Fang / AUTOMATED", id: "1905152069227", reporting: true }
];

export function resolveReadOnlyAuth(env = process.env) {
  if (env.ZENDESK_ACCESS_TOKEN) {
    return { method: "OAuth Bearer", authorization: `Bearer ${env.ZENDESK_ACCESS_TOKEN}` };
  }
  if (env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN) {
    const basic = Buffer.from(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`, "utf8").toString("base64");
    return { method: "API token Basic", authorization: `Basic ${basic}` };
  }
  throw new Error("Set ZENDESK_ACCESS_TOKEN (OAuth), or both ZENDESK_EMAIL and ZENDESK_API_TOKEN (API token)");
}

export async function verifyCandidateUsers(subdomain, auth, fetchImpl = fetch) {
  const ids = CANDIDATE_USERS.map(user => user.id).join(",");
  const url = `${apiBase(subdomain)}/users/show_many?ids=${encodeURIComponent(ids)}`;
  const response = await requestWithRetry(url, auth, fetchImpl);
  const body = await response.json();
  const users = new Map((body.users || []).map(user => [String(user.id), user]));
  return CANDIDATE_USERS.map(candidate => {
    const user = users.get(candidate.id);
    return {
      ...candidate,
      verified: Boolean(user),
      identity: user ? { id: String(user.id), name: user.name, role: user.role, active: user.active } : null
    };
  });
}


export async function fetchSearchExport(query, accessToken, { subdomain, fetchImpl = fetch, maxPages = 1000 } = {}) {
  if (!subdomain) throw new Error("ZENDESK_SUBDOMAIN is required");
  const base = apiBase(subdomain);
  const url = new URL(`${base}/search/export`);
  url.searchParams.set("filter[type]", "ticket");
  url.searchParams.set("query", query);
  url.searchParams.set("page[size]", "100");

  const results = [];
  const seen = new Set();
  let current = url.toString();
  let pages = 0;
  while (current) {
    if (seen.has(current)) throw new Error("Zendesk search pagination loop detected");
    if (pages >= maxPages) throw new Error("Zendesk search page limit reached");
    seen.add(current);
    const response = await requestWithRetry(current, accessToken, fetchImpl);
    const body = await response.json();
    if (!Array.isArray(body.results)) throw new Error("Zendesk search response omitted results");
    results.push(...body.results);
    current = body.links?.next || null;
    if (current) {
      const nextUrl = new URL(current, base);
      if (nextUrl.origin !== new URL(base).origin || !nextUrl.pathname.endsWith("/api/v2/search/export")) {
        throw new Error("Zendesk search pagination returned an unexpected URL");
      }
      current = nextUrl.toString();
    }
    pages++;
  }
  return { results, pages };
}

export function assigneeAtSolve(audits, solvedAt) {
  const solvedAtMs = Date.parse(solvedAt || "");
  if (!Number.isFinite(solvedAtMs)) return null;
  let currentAssignee = null;
  let solveActor = null;
  for (const audit of audits) {
    if (Date.parse(audit.at || "") > solvedAtMs) continue;
    if (audit.assigneeChanged) currentAssignee = audit.assigneeId == null ? null : Number(audit.assigneeId);
    if (audit.status === "solved") solveActor = Number(audit.authorId);
  }
  if (currentAssignee !== null && Number.isSafeInteger(currentAssignee) && currentAssignee > 0) return currentAssignee;
  return Number.isSafeInteger(solveActor) && solveActor > 0 ? solveActor : null;
}

export function countPublicAgentReplies(audits) {
  return audits.filter(audit => audit.publicComment).length;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}

export async function validateDay(day, { subdomain, accessToken, fetchImpl = fetch, identities = [] } = {}) {
  const { start, end } = dayBoundsPht(day);
  // Zendesk search indexes its solved date in the account's timezone. Search
  // a neighboring date too, then select exact PHT boundaries from solved_at.
  const dayBefore = new Date(Date.parse(`${day}T00:00:00Z`) - 172_800_000).toISOString().slice(0, 10);
  const dayAfter = new Date(Date.parse(`${day}T00:00:00Z`) + 172_800_000).toISOString().slice(0, 10);
  const query = `status:solved solved>${dayBefore} solved<${dayAfter}`;
  const { results, pages } = await fetchSearchExport(query, accessToken, { subdomain, fetchImpl });
  const reportingIds = new Set(CANDIDATE_USERS.filter(user => user.reporting).map(user => Number(user.id)));
  const details = await mapLimit(results, 4, async ticket => {
    const [metric, audits] = await Promise.all([
      getTicketMetrics(subdomain, ticket.id, accessToken, fetchImpl),
      getTicketAudits(subdomain, ticket.id, accessToken, fetchImpl)
    ]);
    if (!metric || !isWithin(metric.solved_at, start, end)) return null;
    const attributionId = assigneeAtSolve(audits, metric.solved_at);
    const agentReplies = countPublicAgentReplies(audits);
    return {
      id: String(ticket.id),
      assigneeId: attributionId,
      viaChannel: ticket.via?.channel ?? null,
      oneTouchEligible: ticket.via?.channel !== "api",
      oneTouch: ticket.via?.channel === "api" ? null : agentReplies <= 1 && Number(metric.reopens || 0) === 0,
      replies: metric.replies,
      reopens: metric.reopens
    };
  });
  const allSolved = details.filter(Boolean);
  const solved = allSolved.filter(item => reportingIds.has(Number(item.assigneeId)));
  const byAssignee = new Map();
  for (const item of solved) {
    const key = item.assigneeId == null ? "unassigned" : String(item.assigneeId);
    const row = byAssignee.get(key) || { assigneeId: item.assigneeId, solved: 0, oneTouchEligible: 0, oneTouch: 0 };
    row.solved++;
    if (item.oneTouchEligible) {
      row.oneTouchEligible++;
      if (item.oneTouch) row.oneTouch++;
    }
    byAssignee.set(key, row);
  }
  return {
    day,
    searchPages: pages,
    searchMatches: results.length,
    ticketsWithSolvedAtInPhtDay: solved.length,
    solvedTicketsOutsideReportingScope: allSolved.length - solved.length,
    byAssignee: [...byAssignee.values()].sort((a, b) => (a.assigneeId ?? 0) - (b.assigneeId ?? 0))
  };
}

export async function runValidation({ env = process.env, fetchImpl = fetch } = {}) {
  const subdomain = env.ZENDESK_SUBDOMAIN;
  if (!subdomain) throw new Error("ZENDESK_SUBDOMAIN is required");
  const auth = resolveReadOnlyAuth(env);
  const candidates = await verifyCandidateUsers(subdomain, auth, fetchImpl);
  const identitiesVerified = candidates.every(user => user.verified);
  const identities = candidates.map(({ key, label, reporting, verified, identity }) => ({ key, label, reporting, verified, ...identity }));
  if (!identitiesVerified) {
    return { authentication: `${auth.method} accepted by read-only GET`, identities, dates: [], validationStatus: "identity verification incomplete" };
  }
  const users = candidates.map(candidate => ({ ...candidate.identity, reporting: candidate.reporting }));
  const dates = await Promise.all(["2026-10-21", "2026-10-22"].map(day =>
    validateDay(day, { subdomain, accessToken: auth, fetchImpl, identities: users })
  ));
  return { authentication: `${auth.method} accepted by read-only GET`, identities, dates, validationStatus: "complete" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runValidation().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`Zendesk validation stopped: ${error.message}\n`);
      process.exitCode = 1;
    });
}
