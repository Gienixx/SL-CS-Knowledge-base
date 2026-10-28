import { AGENTS, METRICS, buildDailyRows, dayBoundsPht, emptyRows, previousPhtDay } from "./analytics.js";
import { getAccessToken } from "./oauth.js";
import { apiBase, fetchCursorPages, getSatisfactionRatings, getTicketAudits, getTicketMetrics, minimalTicket, sourceTimestamp } from "./zendesk.js";

const MAX_PAGES_PER_INVOCATION = 12;
const LATE_AFTER_MS = 10 * 60_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function agentIds(env) {
  let ids;
  try { ids = JSON.parse(env.ZENDESK_AGENT_IDS_JSON || "{}"); } catch { throw new Error("ZENDESK_AGENT_IDS_JSON must be valid JSON"); }
  const missing = AGENTS.filter(agent => !Number.isSafeInteger(Number(ids[agent.key])) || Number(ids[agent.key]) <= 0);
  if (missing.length) throw new Error(`Verified Zendesk user IDs are required for: ${missing.map(a => a.label).join(", ")}`);
  if (new Set(AGENTS.map(a => Number(ids[a.key]))).size !== AGENTS.length) throw new Error("Zendesk agent IDs must be unique");
  return Object.fromEntries(AGENTS.map(a => [a.key, Number(ids[a.key])]));
}

function isoNow() { return new Date().toISOString(); }
function parseRunDay(request, defaultDay) {
  const value = new URL(request.url).searchParams.get("day") || defaultDay;
  dayBoundsPht(value);
  return value;
}

async function verifyAccess(request, env) {
  const compact = request.headers.get("cf-access-jwt-assertion");
  if (!compact || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error("Cloudflare Access verification is not configured");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("Invalid Cloudflare Access token");
  const decode = value => JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
  const header = decode(parts[0]), claims = decode(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported Cloudflare Access JWT");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(env.ACCESS_AUD) || claims.exp * 1000 <= Date.now()) throw new Error("Cloudflare Access token is expired or has the wrong audience");
  const certResponse = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!certResponse.ok) throw new Error("Unable to validate Cloudflare Access signing key");
  const { keys = [] } = await certResponse.json();
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) throw new Error("Cloudflare Access signing key is unknown");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0));
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) throw new Error("Cloudflare Access signature verification failed");
  return claims;
}

function adminEmailAllowed(claims, env) {
  const allow = (env.CORRECTION_ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return claims.email && allow.includes(String(claims.email).toLowerCase());
}

async function runSnapshot(day, env, scheduledTime = new Date()) {
  const db = env.REPORTING_DB;
  const now = isoNow();
  const bounds = dayBoundsPht(day);
  const scheduledFor = new Date(Date.parse(bounds.end) + 6 * 60 * 60 * 1000).toISOString();
  const runId = crypto.randomUUID();
  let lock = await db.prepare("INSERT OR IGNORE INTO run_lock(lock_name,run_id,locked_at) VALUES ('zendesk-daily',?,?)").bind(runId, now).run();
  if (!lock.meta?.changes) {
    const existing = await db.prepare("SELECT run_id,locked_at FROM run_lock WHERE lock_name='zendesk-daily'").first();
    if (existing && Date.parse(existing.locked_at) < Date.now() - 60 * 60_000) {
      await db.prepare("DELETE FROM run_lock WHERE lock_name='zendesk-daily' AND run_id=?").bind(existing.run_id).run();
      lock = await db.prepare("INSERT OR IGNORE INTO run_lock(lock_name,run_id,locked_at) VALUES ('zendesk-daily',?,?)").bind(runId, now).run();
    }
    if (!lock.meta?.changes) throw new Error("Another Zendesk daily run holds the lease");
  }
  let activeRunId = runId;
  try {
    const finalized = await db.prepare("SELECT 1 AS found FROM daily_snapshot WHERE reporting_day=? LIMIT 1").bind(day).first();
    if (finalized) return { day, status:"already_finalized" };
    const ids = agentIds(env);
    const resume = await db.prepare("SELECT run_id,next_page_url,started_at,pages_processed,tickets_seen,source_watermark FROM run_log WHERE reporting_day=? AND status IN ('incomplete','running','failed') ORDER BY started_at DESC LIMIT 1").bind(day).first();
    let nextPage = resume?.next_page_url || null;
    if (resume) activeRunId = resume.run_id;
    const startedAt = resume?.started_at || now;
    if (!resume) await db.prepare("INSERT INTO run_log(run_id,reporting_day,status,scheduled_for,started_at) VALUES (?,?, 'running', ?, ?)").bind(runId, day, scheduledFor, now).run();
    else await db.prepare("UPDATE run_log SET status='running',message=NULL,error_code=NULL WHERE run_id=?").bind(activeRunId).run();

    const accessToken = await getAccessToken(env);
    const base = apiBase(env.ZENDESK_SUBDOMAIN);
    const knownIds = new Set(Object.values(ids));
    const roleCache = new Map(Object.values(ids).map(id => [id,true]));
    const firstUrl = nextPage || `${base}/incremental/tickets/cursor?start_time=${Math.floor(Date.parse(bounds.start) / 1000)}`;
    const ratings = await getSatisfactionRatings(env.ZENDESK_SUBDOMAIN, Math.floor(Date.parse(bounds.start) / 1000), Math.floor(Date.parse(bounds.end) / 1000), accessToken);
    let pagesThisCall = 0;
    let watermark = resume?.source_watermark || null;
    for (const rating of ratings) if (rating.updated_at && (!watermark || rating.updated_at > watermark)) watermark = rating.updated_at;
    const cursor = await fetchCursorPages(firstUrl, accessToken, {
      onPage: async tickets => {
        for (const raw of tickets) {
          const ticket = minimalTicket(raw);
          if (!Number.isSafeInteger(Number(ticket.id))) continue;
          if (ticket.status !== "solved" && ticket.status !== "closed") continue;
          const metric = await getTicketMetrics(env.ZENDESK_SUBDOMAIN, ticket.id, accessToken);
          if (!metric?.solved_at || Date.parse(metric.solved_at) < Date.parse(bounds.start) || Date.parse(metric.solved_at) >= Date.parse(bounds.end)) continue;
          const audits = await getTicketAudits(env.ZENDESK_SUBDOMAIN, ticket.id, accessToken, fetch, roleCache);
          const [row] = buildDailyRows({ day, tickets: [ticket], metricsByTicket: new Map([[String(ticket.id), metric]]), auditsByTicket: new Map([[String(ticket.id), audits]]), ratings, agentIds: ids });
          const agentRow = row.solved_tickets ? row : null;
          // Stage only the per-ticket aggregate inputs. Ticket text, comments, requester IDs, names, and emails are discarded.
          const auditSolve = [...audits].reverse().find(a => a.status === "solved" && a.at === metric.solved_at);
          let assigneeAtSolve = null, lastAssignment = null;
          for (const audit of audits) {
            if (Date.parse(audit.at) > Date.parse(metric.solved_at)) break;
            if (audit.assigneeChanged) assigneeAtSolve = audit.assigneeId;
            if (audit.assigneeChanged && audit.assigneeId !== null && Date.parse(audit.at) <= Date.parse(metric.solved_at)) lastAssignment = audit;
            if (audit.at === metric.solved_at && audit.status === "solved") break;
          }
          const chosenAgentId = assigneeAtSolve ?? auditSolve?.authorId;
          const chosenAgent = AGENTS.find(a => ids[a.key] === chosenAgentId);
          if (agentRow && chosenAgent) {
            const rating = ratings.find(r => String(r.ticket_id) === String(ticket.id) && (r.score === "good" || r.score === "bad"));
            const publicReplies = audits.filter(a => a.publicComment).length;
            const values = {
              first_reply_minutes: Number(metric.replies) === 0 ? null : metric.reply_time_in_minutes?.calendar ?? null,
              requester_wait_minutes: metric.requester_wait_time_in_minutes?.calendar ?? null,
              last_assignment_to_resolution_minutes: lastAssignment ? Math.max(0, (Date.parse(metric.solved_at) - Date.parse(lastAssignment.at)) / 60000) : null,
              full_resolution_minutes: metric.full_resolution_time_in_minutes?.calendar ?? null,
              csat: rating?.score ?? null,
              one_touch: ticket.via_channel === "api" ? null : publicReplies <= 1 && Number(metric.reopens || 0) === 0
            };
            await db.prepare("INSERT INTO staged_metrics(run_id,ticket_id,agent_key,metric_json) VALUES (?,?,?,?) ON CONFLICT(run_id,ticket_id) DO UPDATE SET agent_key=excluded.agent_key,metric_json=excluded.metric_json")
              .bind(activeRunId, ticket.id, chosenAgent.key, JSON.stringify(values)).run();
          }
          const ticketWatermark = sourceTimestamp(ticket);
          if (ticketWatermark && (!watermark || ticketWatermark > watermark)) watermark = ticketWatermark;
        }
        pagesThisCall++;
      },
      maxPages: MAX_PAGES_PER_INVOCATION,
      minIntervalMs: 6_100,
      checkpoint: async (url, pageWatermark, ticketsCount) => {
        if (pageWatermark && (!watermark || pageWatermark > watermark)) watermark = pageWatermark;
        await db.prepare("UPDATE run_log SET next_page_url=?,pages_processed=pages_processed+1,tickets_seen=tickets_seen+?,source_watermark=? WHERE run_id=?")
          .bind(url, ticketsCount, watermark, activeRunId).run();
      }
    });

    if (cursor.nextPage) {
        await db.prepare("UPDATE run_log SET status='incomplete',message='Page budget reached; resume from saved cursor' WHERE run_id=?").bind(activeRunId).run();
        return { runId: activeRunId, day, status: "incomplete", pagesThisCall, nextPage: true };
    }

    const staged = await db.prepare("SELECT agent_key,metric_json FROM staged_metrics WHERE run_id=?").bind(activeRunId).all();
    const rows = emptyRows(day);
    for (const { agent_key: key, metric_json: text } of staged.results || []) {
      const row = rows.find(r => r.agentKey === key);
      const x = JSON.parse(text);
      row._items ??= [];
      row._items.push(x);
    }
    for (const row of rows) {
      const items = row._items || [];
      const med = key => {
        const a = items.map(x => x[key]).filter(Number.isFinite).sort((x,y)=>x-y);
        if (!a.length) return null;
        const n = Math.floor(a.length/2); return a.length%2 ? a[n] : (a[n-1]+a[n])/2;
      };
      const rated = items.filter(x => x.csat);
      const touch = items.filter(x => typeof x.one_touch === "boolean");
      row.solved_tickets = items.length;
      row.first_reply_minutes = med("first_reply_minutes");
      row.requester_wait_minutes = med("requester_wait_minutes");
      row.last_assignment_to_resolution_minutes = med("last_assignment_to_resolution_minutes");
      row.full_resolution_minutes = med("full_resolution_minutes");
      row.csat_percent = rated.length ? 100 * rated.filter(x => x.csat === "good").length / rated.length : null;
      row.one_touch_percent = touch.length ? 100 * touch.filter(x => x.one_touch).length / touch.length : null;
      row.csat_responses = rated.length;
      row.one_touch_denominator = touch.length;
      delete row._items;
    }

    const actualCompleted = isoNow();
    const cutoff = `${new Date(Date.parse(bounds.end) + 6 * 60 * 60 * 1000).toISOString()}`;
    const late = Date.parse(actualCompleted) > Date.parse(cutoff) + LATE_AFTER_MS;
    const quality = late ? "late" : "on_time";
    const inserts = rows.map(row => db.prepare(`INSERT INTO daily_snapshot(reporting_day,agent_key,agent_label,solved_tickets,first_reply_minutes,requester_wait_minutes,last_assignment_to_resolution_minutes,full_resolution_minutes,csat_percent,one_touch_percent,csat_responses,one_touch_denominator,run_id,intended_cutoff,actual_started_at,actual_completed_at,source_watermark,quality_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(day,row.agentKey,row.agentLabel,row.solved_tickets,row.first_reply_minutes,row.requester_wait_minutes,row.last_assignment_to_resolution_minutes,row.full_resolution_minutes,row.csat_percent,row.one_touch_percent,row.csat_responses,row.one_touch_denominator,activeRunId,cutoff,startedAt,actualCompleted,watermark,quality));
    inserts.push(db.prepare("UPDATE run_log SET status=?,completed_at=?,source_watermark=?,next_page_url=NULL,message=? WHERE run_id=?")
      .bind(quality === "late" ? "late" : "complete", actualCompleted, watermark, late ? "Completed after cutoff tolerance; not an exact as-of reconstruction" : null, activeRunId));
    inserts.push(db.prepare("DELETE FROM staged_metrics WHERE run_id=?").bind(activeRunId));
    await db.batch(inserts);
    return { runId: activeRunId, day, status: quality, sourceWatermark: watermark };
  } catch (error) {
    await db.prepare("INSERT OR IGNORE INTO run_log(run_id,reporting_day,status,scheduled_for,started_at,error_code,message,completed_at) VALUES (?,?, 'failed', ?, ?, ?, ?, ?)")
      .bind(activeRunId,day,scheduledFor,now,"collector_error",String(error?.message || error).slice(0,500),isoNow()).run().catch(() => {});
    await db.prepare("UPDATE run_log SET status='failed',completed_at=?,error_code=?,message=? WHERE run_id=?")
      .bind(isoNow(), "collector_error", String(error?.message || error).slice(0, 500), activeRunId).run().catch(() => {});
    throw error;
  } finally {
    await db.prepare("DELETE FROM run_lock WHERE lock_name='zendesk-daily' AND run_id=?").bind(runId).run().catch(() => {});
  }
}

async function dashboardRows(request, env) {
  const claims = await verifyAccess(request, env);
  if (!claims.email) return json({ error: "Cloudflare Access user identity is missing" }, 401);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || previousPhtDay();
  const end = url.searchParams.get("end") || start;
  dayBoundsPht(start); dayBoundsPht(end);
  if (end < start || Date.parse(end) - Date.parse(start) > 366 * 86400000) return json({ error: "Invalid date range" }, 400);
  const agent = url.searchParams.get("agent");
  const rows = await env.REPORTING_DB.prepare(`SELECT e.*, r.status AS latest_run_status, r.started_at AS latest_run_started_at, r.completed_at AS latest_run_completed_at
    FROM effective_daily_snapshot e
    LEFT JOIN (SELECT reporting_day,status,started_at,completed_at,ROW_NUMBER() OVER(PARTITION BY reporting_day ORDER BY started_at DESC) rn FROM run_log) r
      ON r.reporting_day=e.reporting_day AND r.rn=1
    WHERE e.reporting_day BETWEEN ? AND ? AND (? IS NULL OR e.agent_key=?)
    ORDER BY e.reporting_day,e.agent_key`).bind(start,end,agent,agent).all();
  return json({ rows: rows.results || [], filters: { start,end,agent }, generatedAt: isoNow() });
}

async function runLogs(request, env) {
  await verifyAccess(request, env);
  const day = parseRunDay(request, previousPhtDay());
  const result = await env.REPORTING_DB.prepare("SELECT run_id,reporting_day,status,scheduled_for,started_at,completed_at,source_watermark,pages_processed,tickets_seen,error_code,message FROM run_log WHERE reporting_day=? ORDER BY started_at DESC")
    .bind(day).all();
  return json({ runs: result.results || [] });
}

async function createCorrection(request, env) {
  const claims = await verifyAccess(request, env);
  if (!adminEmailAllowed(claims, env)) return json({ error: "Correction role required" }, 403);
  const body = await request.json();
  dayBoundsPht(body.day);
  if (!AGENTS.some(a => a.key === body.agentKey) || typeof body.reason !== "string" || body.reason.trim().length < 12) return json({ error: "day, a valid agentKey, and a correction reason of at least 12 characters are required" }, 400);
  if (!body.metrics || !Object.keys(body.metrics).length || Object.keys(body.metrics).some(key => !METRICS.includes(key))) return json({ error: "metrics must contain at least one of the seven supported metrics" }, 400);
  if (body.reason.trim().length > 1000) return json({ error: "correction reason must be at most 1000 characters" },400);
  const old = await env.REPORTING_DB.prepare("SELECT * FROM effective_daily_snapshot WHERE reporting_day=? AND agent_key=?").bind(body.day,body.agentKey).first();
  if (!old) return json({ error: "A finalized snapshot is required before it can be corrected" }, 404);
  const id = crypto.randomUUID(), now = isoNow();
  const values = Object.fromEntries(Object.entries(body.metrics).map(([key,value]) => [key,value]));
  const oldJson = JSON.stringify(old);
  const batch = [env.REPORTING_DB.prepare("INSERT INTO correction_log(correction_id,reporting_day,agent_key,actor_email,reason,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,body.day,body.agentKey,claims.email,body.reason.trim(),oldJson,JSON.stringify(values),now)];
  for (const [name,value] of Object.entries(values)) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) return json({ error: `Invalid value for ${name}` },400);
    if (name === "solved_tickets" && value !== null && !Number.isInteger(value)) return json({ error: "solved_tickets must be an integer" },400);
    if ((name === "csat_percent" || name === "one_touch_percent") && value !== null && value > 100) return json({ error: `${name} must be at most 100` },400);
    batch.push(env.REPORTING_DB.prepare("INSERT INTO correction_values(correction_id,metric_name,metric_value) VALUES (?,?,?)").bind(id,name,value));
  }
  await env.REPORTING_DB.batch(batch);
  return json({ correctionId:id,day:body.day,agentKey:body.agentKey,actor:claims.email,metrics:values,createdAt:now },201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/daily" && request.method === "GET") return await dashboardRows(request,env);
      if (url.pathname === "/api/runs" && request.method === "GET") return await runLogs(request,env);
      if (url.pathname === "/api/run" && request.method === "POST") {
        const claims = await verifyAccess(request,env);
        if (!adminEmailAllowed(claims,env)) return json({ error: "Admin role required" },403);
        return json(await runSnapshot(parseRunDay(request,previousPhtDay()),env,new Date()));
      }
      if (url.pathname === "/api/corrections" && request.method === "POST") return await createCorrection(request,env);
      if (url.pathname.startsWith("/api/")) return json({ error:"Not found" },404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error:String(error?.message || error) }, error?.message?.includes("Access") ? 401 : 500);
    }
  },
  async scheduled(controller, env, ctx) {
    const day = previousPhtDay(new Date(controller.scheduledTime));
    ctx.waitUntil(runSnapshot(day,env,new Date(controller.scheduledTime)));
  }
};
