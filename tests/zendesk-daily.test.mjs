import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AGENTS, buildDailyRows, dayBoundsPht, median, previousPhtDay } from "../zendesk-daily/worker/src/analytics.js";
import { fetchCursorPages, minimalAudit, minimalTicket, requestWithRetry, sourceTimestamp } from "../zendesk-daily/worker/src/zendesk.js";
import { getAccessToken } from "../zendesk-daily/worker/src/oauth.js";
import { assigneeAtSolve, countPublicAgentReplies, CANDIDATE_USERS, fetchSearchExport, resolveReadOnlyAuth, runValidation, verifyCandidateUsers } from "../zendesk-daily/scripts/validate-readonly.mjs";

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/zendesk-daily/${name}.json`, import.meta.url), "utf8"));

test("PHT reporting day boundaries use midnight inclusive and next midnight exclusive", () => {
  assert.deepEqual(dayBoundsPht("2026-10-21"), { start:"2026-10-20T16:00:00.000Z", end:"2026-10-21T16:00:00.000Z" });
  assert.throws(() => dayBoundsPht("2026-02-30"), /invalid day/);
  assert.equal(previousPhtDay(new Date("2026-10-22T15:59:59.000Z")), "2026-10-21");
  assert.equal(previousPhtDay(new Date("2026-10-22T16:00:00.000Z")), "2026-10-22");
});

test("daily output uses solved time, verified agent IDs, medians, and nulls for unavailable fields", async () => {
  const [tickets, metrics, audits, ratings] = await Promise.all(["tickets","metrics","audits","ratings"].map(fixture));
  const rows = buildDailyRows({
    day:"2026-10-21", tickets,
    metricsByTicket:new Map(Object.entries(metrics)),
    auditsByTicket:new Map(Object.entries(audits).map(([id,list])=>[id,list.map(a=>minimalAudit(a,new Set([101,202,303,404,505])))])), ratings,
    agentIds:{ amora:101,gen:202,arby:303,ford:404,tommy:505 }
  });
  const amora = rows.find(r => r.agentKey === "amora");
  const gen = rows.find(r => r.agentKey === "gen");
  assert.equal(amora.solved_tickets,1);
  assert.equal(amora.first_reply_minutes,60);
  assert.equal(amora.requester_wait_minutes,90);
  assert.equal(amora.full_resolution_minutes,240);
  assert.equal(amora.csat_percent,100);
  assert.equal(amora.one_touch_percent,100);
  assert.equal(gen.solved_tickets,1);
  assert.equal(gen.first_reply_minutes,null);
  assert.equal(gen.csat_percent,0);
  assert.equal(rows.find(r => r.agentKey === "ford").solved_tickets,0);
});

test("median ignores unavailable values without inventing zeroes", () => {
  assert.equal(median([null, 10, 30]),20);
  assert.equal(median([null, undefined]),null);
});

test("source watermark normalizes Zendesk epoch timestamps", () => {
  assert.equal(sourceTimestamp({generated_timestamp:1792558800,updated_at:"2026-10-21T00:00:00Z"}),"2026-10-21T05:00:00.000Z");
});

test("API sanitizers retain only allowlisted ticket and audit fields", async () => {
  const ticket = minimalTicket({ id:7,created_at:"t",updated_at:"u",generated_timestamp:"g",status:"solved",assignee_id:1,subject:"secret",description:"secret",requester_id:2,via:{channel:"web"} });
  assert.deepEqual(ticket,{id:7,created_at:"t",updated_at:"u",generated_timestamp:"g",status:"solved",assignee_id:1,via_channel:"web"});
  const audit = minimalAudit({id:1,ticket_id:7,author_id:1,created_at:"t",events:[{type:"Comment",public:true,body:"secret"},{type:"Change",field_name:"status",value:"solved"}]},new Set([1]));
  assert.equal(audit.publicComment,true);
  assert.equal(JSON.stringify(audit).includes("secret"),false);
  assert.equal(AGENTS.some(a=>a.username==="automated"&&a.userId===null),true);
});

test("cursor pagination follows opaque next_page links and checkpoints each page", async () => {
  const urls=[], checkpoints=[];
  const fetchImpl=async url=>{
    urls.push(String(url));
    const first=String(url).endsWith("/start");
    return new Response(JSON.stringify(first?{tickets:[{id:1,updated_at:"2026-10-21T01:00:00Z"}],next_page:"https://z.test/end"}:{tickets:[{id:2,updated_at:"2026-10-21T02:00:00Z"}],next_page:null}),{status:200});
  };
  const result=await fetchCursorPages("https://z.test/start","token",{fetchImpl,checkpoint:async(...args)=>checkpoints.push(args)});
  assert.deepEqual(urls,["https://z.test/start","https://z.test/end"]);
  assert.equal(checkpoints.length,2);
  assert.equal(checkpoints[0][2],1);
  assert.equal(result.lastUpdatedAt,"2026-10-21T02:00:00.000Z");
});

test("incremental export after_url cursor is saved when page budget is exhausted", async () => {
  let checkpoint=null;
  const fetchImpl=async()=>new Response(JSON.stringify({tickets:[{id:9}],after_url:"https://z.test/cursor?cursor=opaque",end_of_stream:false}),{status:200});
  const result=await fetchCursorPages("https://z.test/incremental","token",{fetchImpl,maxPages:1,checkpoint:async(url)=>{checkpoint=url}});
  assert.equal(result.nextPage,"https://z.test/cursor?cursor=opaque");
  assert.equal(checkpoint,result.nextPage);
});

test("rate-limit retry honors Retry-After", async () => {
  let calls=0, waited=0;
  const fetchImpl=async()=>++calls===1?new Response("",{status:429,headers:{"Retry-After":"2"}}):new Response("ok",{status:200});
  const response=await requestWithRetry("https://z.test","token",fetchImpl,async ms=>{waited=ms});
  assert.equal(response.status,200);
  assert.equal(calls,2);
  assert.equal(waited,2000);
});

test("read-only search export follows cursor links and returns all pages", async () => {
  const urls=[];
  const fetchImpl=async url=>{
    urls.push(String(url));
    const first=urls.length===1;
    return new Response(JSON.stringify(first
      ? {results:[{id:1}],links:{next:"https://z.zendesk.com/api/v2/search/export?page%5Bafter%5D=opaque"},meta:{has_more:true}}
      : {results:[{id:2}],links:{next:null},meta:{has_more:false}}),{status:200});
  };
  const result=await fetchSearchExport("status:solved solved:2026-10-21","test-token",{subdomain:"z",fetchImpl});
  assert.deepEqual(result.results.map(ticket=>ticket.id),[1,2]);
  assert.equal(result.pages,2);
  assert.equal(urls.length,2);
  assert.equal(new URL(urls[0]).searchParams.get("filter[type]"),"ticket");
});

test("read-only search export rejects pagination links outside Zendesk", async () => {
  const fetchImpl=async()=>new Response(JSON.stringify({results:[],links:{next:"https://attacker.test/steal"}}),{status:200});
  await assert.rejects(fetchSearchExport("status:solved","token",{subdomain:"z",fetchImpl}),/unexpected URL/);
});

test("read-only solved-ticket attribution uses the assignee at solve time", () => {
  const audits=[
    {at:"2026-10-21T10:00:00Z",assigneeChanged:true,assigneeId:101,status:null,authorId:10},
    {at:"2026-10-21T11:00:00Z",assigneeChanged:true,assigneeId:202,status:null,authorId:10},
    {at:"2026-10-21T12:00:00Z",assigneeChanged:false,assigneeId:null,status:"solved",authorId:202},
    {at:"2026-10-21T13:00:00Z",assigneeChanged:true,assigneeId:303,status:null,authorId:10}
  ];
  assert.equal(assigneeAtSolve(audits,"2026-10-21T12:00:00Z"),202);
  assert.equal(assigneeAtSolve([{at:"2026-10-21T12:00:00Z",status:"solved",authorId:404}],"2026-10-21T12:00:00Z"),404);
});

test("one-touch reply count includes every verified agent author from ticket audits", () => {
  assert.equal(countPublicAgentReplies([
    {publicComment:true,authorId:101},
    {publicComment:true,authorId:606},
    {publicComment:false,authorId:101}
  ]),2);
});

test("read-only validator refuses to run without credentials and does not attempt a request", async () => {
  let called=false;
  await assert.rejects(runValidation({env:{ZENDESK_SUBDOMAIN:"example"},fetchImpl:async()=>{called=true;}}),/ZENDESK_ACCESS_TOKEN/);
  assert.equal(called,false);
});

test("validator distinguishes OAuth Bearer credentials from Zendesk API-token Basic credentials", () => {
  assert.deepEqual(resolveReadOnlyAuth({ZENDESK_ACCESS_TOKEN:"oauth-value",ZENDESK_EMAIL:"agent@example.test",ZENDESK_API_TOKEN:"api-value"}),
    {method:"OAuth Bearer",authorization:"Bearer oauth-value"});
  assert.deepEqual(resolveReadOnlyAuth({ZENDESK_EMAIL:"agent@example.test",ZENDESK_API_TOKEN:"api-value"}),
    {method:"API token Basic",authorization:`Basic ${Buffer.from("agent@example.test/token:api-value").toString("base64")}`});
  assert.throws(()=>resolveReadOnlyAuth({ZENDESK_API_TOKEN:"api-value"}),/both ZENDESK_EMAIL and ZENDESK_API_TOKEN/);
});

test("validator verifies six candidate IDs with one read-only GET and excludes Arez from reporting", async () => {
  let calledUrl="", authorization="";
  const fetchImpl=async(url,init)=>{
    calledUrl=String(url);authorization=init.headers.Authorization;
    return new Response(JSON.stringify({users:CANDIDATE_USERS.map(user=>({id:Number(user.id),name:user.label,role:"agent",active:true}))}),{status:200});
  };
  const candidates=await verifyCandidateUsers("example",{method:"API token Basic",authorization:"Basic safe"},fetchImpl);
  assert.equal(new URL(calledUrl).pathname,"/api/v2/users/show_many");
  assert.equal(new URL(calledUrl).searchParams.get("ids"),CANDIDATE_USERS.map(user=>user.id).join(","));
  assert.equal(authorization,"Basic safe");
  assert.equal(candidates.length,6);
  assert.equal(candidates.every(user=>user.verified),true);
  assert.equal(candidates.find(user=>user.key==="arez").reporting,false);
  assert.equal(candidates.filter(user=>user.reporting).length,5);
});

test("read-only errors omit API response bodies", async () => {
  const fetchImpl=async()=>new Response(JSON.stringify({description:"sensitive payload"}),{status:403});
  await assert.rejects(fetchSearchExport("status:solved","token",{subdomain:"z",fetchImpl}),/\(403\)/);
  await assert.rejects(fetchSearchExport("status:solved","token",{subdomain:"z",fetchImpl}),error=>!error.message.includes("sensitive payload"));
});

test("OAuth refresh rotates and encrypts the refresh token before the next run", async () => {
  let encrypted=null;
  const db={prepare(sql){return {first:async()=>encrypted?{encrypted_value:encrypted}:null,bind(value){return {run:async()=>{if(sql.startsWith("INSERT"))encrypted=value;return {meta:{changes:1}}}}}}}};
  const env={REPORTING_DB:db,ZENDESK_SUBDOMAIN:"example",ZENDESK_OAUTH_CLIENT_ID:"client",ZENDESK_OAUTH_CLIENT_SECRET:"secret",ZENDESK_REFRESH_TOKEN:"initial-refresh",OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  const requestBodies=[];let rejectStored=false;
  const fetchImpl=async(_url,init)=>{const body=JSON.parse(init.body);requestBodies.push(body);if(rejectStored&&body.refresh_token==="refresh-2")return new Response("expired",{status:400});const n=requestBodies.length;return new Response(JSON.stringify({access_token:`access-${n}`,refresh_token:`refresh-${n}`}),{status:200})};
  assert.equal(await getAccessToken(env,fetchImpl),"access-1");
  assert.equal(requestBodies[0].refresh_token,"initial-refresh");
  assert.ok(encrypted && !encrypted.includes("refresh-1"));
  assert.equal(await getAccessToken({...env,ZENDESK_REFRESH_TOKEN:"stale-initial"},fetchImpl),"access-2");
  assert.equal(requestBodies[1].refresh_token,"refresh-1");
  rejectStored=true;
  assert.equal(await getAccessToken({...env,ZENDESK_REFRESH_TOKEN:"reauthorized-refresh"},fetchImpl),"access-4");
  assert.deepEqual(requestBodies.slice(2).map(x=>x.refresh_token),["refresh-2","reauthorized-refresh"]);
});

test("D1 proposal contains append-only snapshots and correction audit safeguards", async () => {
  const sql=await readFile(new URL("../zendesk-daily/worker/migrations/0001_init.sql",import.meta.url),"utf8");
  assert.match(sql,/daily_snapshot_no_update/);
  assert.match(sql,/daily_snapshot_no_delete/);
  assert.match(sql,/correction_log_no_update/);
  assert.match(sql,/correction_log_no_delete/);
  assert.match(sql,/effective_daily_snapshot/);
  assert.match(sql,/next_page_url/);
});
