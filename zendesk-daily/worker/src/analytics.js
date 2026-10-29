export const AGENTS = [
  { key: "amora", label: "Amor", username: "amora", userId: null },
  { key: "gen", label: "Gen", username: "gen", userId: null },
  { key: "arby", label: "Arby", username: "arby", userId: null },
  { key: "ford", label: "Ford", username: "ford", userId: null },
  { key: "tommy", label: "Tommy Fang", username: "automated", userId: null }
];

export const METRICS = [
  "solved_tickets", "first_reply_minutes", "requester_wait_minutes",
  "last_assignment_to_resolution_minutes", "full_resolution_minutes", "csat_percent", "one_touch_percent"
];

const PHT_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayBoundsPht(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("day must be YYYY-MM-DD");
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start) || new Date(start + PHT_MINUTES * 60_000).toISOString().slice(0, 10) !== day) throw new Error("invalid day");
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

export function previousPhtDay(now = new Date()) {
  const local = new Date(now.getTime() + PHT_MINUTES * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

export function isWithin(value, start, end) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) && t >= Date.parse(start) && t < Date.parse(end);
}

export function minutesBetween(later, earlier) {
  const a = Date.parse(later || ""), b = Date.parse(earlier || "");
  return Number.isFinite(a) && Number.isFinite(b) && a >= b ? (a - b) / 60_000 : null;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Audits carry publicComment only after Zendesk roles have classified the author.
export function countPublicAgentReplies(audits) {
  return audits.filter(audit => audit.publicComment).length;
}

export function oneTouchResult(audits, metric, channel) {
  return channel === "api" ? null : countPublicAgentReplies(audits) <= 1 && Number(metric.reopens || 0) === 0;
}

export function assigneeAtSolve(audits, solvedAt) {
  const solvedAtMs = Date.parse(solvedAt || "");
  if (!Number.isFinite(solvedAtMs)) return null;
  let currentAssignee = null, solveActor = null;
  const history = audits.filter(a => Number.isFinite(Date.parse(a.at)) && Date.parse(a.at) <= solvedAtMs)
    .slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const audit of history) {
    if (audit.assigneeChanged) currentAssignee = audit.assigneeId == null ? null : Number(audit.assigneeId);
    if (audit.status === "solved" && Date.parse(audit.at) === solvedAtMs) solveActor = Number(audit.authorId);
  }
  // An out-of-scope assignee must not be replaced by an in-scope solve actor.
  if (Number.isSafeInteger(currentAssignee) && currentAssignee > 0) return currentAssignee;
  return Number.isSafeInteger(solveActor) && solveActor > 0 ? solveActor : null;
}

export function buildDailyRows({ day, tickets, metricsByTicket, auditsByTicket, ratings, agentIds = {} }) {
  const { start, end } = dayBoundsPht(day);
  const agentById = new Map(AGENTS.map(a => [Number(agentIds[a.key]), a]).filter(([id]) => Number.isSafeInteger(id) && id > 0));
  const byAgent = new Map(AGENTS.map(a => [a.key, []]));

  for (const ticket of tickets) {
    const metric = metricsByTicket.get(String(ticket.id));
    if (!metric || !isWithin(metric.solved_at, start, end)) continue;
    const audits = auditsByTicket.get(String(ticket.id)) || [];
    let lastAssignment = null;
    for (const audit of audits) {
      if (audit.assigneeChanged && audit.assigneeId !== null && Date.parse(audit.at) <= Date.parse(metric.solved_at)) lastAssignment = audit;
    }
    const agent = agentById.get(assigneeAtSolve(audits, metric.solved_at));
    if (!agent) continue;
    const ticketRatings = ratings.filter(r => String(r.ticket_id) === String(ticket.id) && isWithin(r.created_at, start, end));
    const score = ticketRatings.find(r => r.score === "good" || r.score === "bad")?.score ?? null;
    byAgent.get(agent.key).push({
      solvedAt: metric.solved_at,
      firstReply: Number(metric.replies) === 0 ? null : metric.reply_time_in_minutes?.calendar ?? null,
      requesterWait: metric.requester_wait_time_in_minutes?.calendar ?? null,
      lastAssignToResolution: lastAssignment ? minutesBetween(metric.solved_at, lastAssignment.at) : null,
      fullResolution: metric.full_resolution_time_in_minutes?.calendar ?? null,
      csat: score,
      oneTouch: oneTouchResult(audits, metric, ticket.via_channel)
    });
  }

  return AGENTS.map(agent => {
    const items = byAgent.get(agent.key);
    const firstReplies = items.map(x => x.firstReply).filter(Number.isFinite);
    const waits = items.map(x => x.requesterWait).filter(Number.isFinite);
    const assignments = items.map(x => x.lastAssignToResolution).filter(Number.isFinite);
    const resolutions = items.map(x => x.fullResolution).filter(Number.isFinite);
    const csat = items.filter(x => x.csat);
    const touches = items.filter(x => x.oneTouch !== null);
    return {
      day, agentKey: agent.key, agentLabel: agent.label,
      solved_tickets: items.length,
      first_reply_minutes: median(firstReplies),
      requester_wait_minutes: median(waits),
      last_assignment_to_resolution_minutes: median(assignments),
      full_resolution_minutes: median(resolutions),
      csat_percent: csat.length ? 100 * csat.filter(x => x.csat === "good").length / csat.length : null,
      one_touch_percent: touches.length ? 100 * touches.filter(x => x.oneTouch).length / touches.length : null,
      csat_responses: csat.length,
      one_touch_denominator: touches.length
    };
  });
}

export function emptyRows(day) {
  return AGENTS.map(agent => ({
    day, agentKey: agent.key, agentLabel: agent.label,
    solved_tickets: 0, first_reply_minutes: null, requester_wait_minutes: null,
    last_assignment_to_resolution_minutes: null, full_resolution_minutes: null,
    csat_percent: null, one_touch_percent: null, csat_responses: 0, one_touch_denominator: 0
  }));
}
