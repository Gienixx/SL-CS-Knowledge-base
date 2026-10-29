import worker from "../zendesk-daily/worker/src/index.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AGENTS, buildDailyRows, dayBoundsPht, median, previousPhtDay } from "../zendesk-daily/worker/src/analytics.js";
import { fetchCursorPages, minimalAudit, minimalTicket, requestWithRetry, sourceTimestamp } from "../zendesk-daily/worker/src/zendesk.js";
import { getRefreshAccessToken as getAccessToken } from "../zendesk-daily/worker/src/oauth.js";
import { assigneeAtSolve, countPublicAgentReplies, CANDIDATE_USERS, fetchSearchExport, resolveReadOnlyAuth, runValidation, validateDay, verifyCandidateUsers } from "../zendesk-daily/scripts/validate-readonly.mjs";

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

// Exercise the scheduled collector through mocked Zendesk responses and in-memory
// D1 statements, including staging and final aggregation. No remote calls occur.
const collectorIds = {amora:101, gen:202, arby:303, ford:404, tommy:505};
const solveTime = "2026-10-21T12:00:00Z";
function rawAudit(at, author, events) {
  return {id:1, ticket_id:1, created_at:at, author_id:author, events};
}
const assign = id => ({type:"Change", field_name:"assignee_id", value:id});
const solveEvent = {type:"Change", field_name:"status", value:"solved"};
const comment = {type:"Comment", public:true};

async function collectScenario(t, {assignee=202, actor=202, audits, channel="email", reopens=0, solvedAt=solveTime} = {}) {
  audits ??= [rawAudit("2026-10-21T10:00:00Z", actor, [assign(assignee)]), rawAudit(solveTime, actor, [solveEvent, comment])];
  const staged = [], snapshots = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql, args:[],
        bind(...args) { this.args=args; return this; },
        async first() { return null; },
        async all() { assert.match(sql,/SELECT agent_key,metric_json FROM staged_metrics/); return {results:staged}; },
        async run() {
          if (sql.startsWith("INSERT INTO staged_metrics")) staged.push({agent_key:this.args[2],metric_json:this.args[3]});
          return {meta:{changes:1}};
        }
      };
      return statement;
    },
    async batch(statements) {
      for (const statement of statements) if (statement.sql.startsWith("INSERT INTO daily_snapshot")) snapshots.push(statement.args);
      return [];
    }
  };
  const ticket={id:1,status:"solved",updated_at:solveTime,via:{channel}};
  const metric={ticket_id:1,solved_at:solvedAt,replies:1,reopens};
  const fetchImpl=async (url, init={}) => {
    const path=new URL(url).pathname;
    let body;
    if(path==="/oauth/tokens") body={access_token:"mock-access",expires_in:3600,token_type:"bearer"};
    else {
      assert.equal(init.method || "GET","GET");
      if(path==="/api/v2/incremental/tickets/cursor") body={tickets:[ticket],next_page:null};
      else if(path==="/api/v2/search/export") body={results:[ticket],links:{next:null}};
      else if(path==="/api/v2/satisfaction_ratings") body={satisfaction_ratings:[],next_page:null};
      else if(path==="/api/v2/tickets/1/metrics") body={ticket_metric:metric};
      else if(path==="/api/v2/tickets/1/audits") body={audits,next_page:null};
      else if(path==="/api/v2/users/show_many") body={users:[...Object.values(collectorIds),606,888].map(id=>({id,role:id===888?"end-user":"agent"}))};
      else assert.fail(`Unexpected mocked request path: ${path}`);
    }
    return new Response(JSON.stringify(body),{status:200});
  };
  t.mock.method(globalThis,"fetch",fetchImpl);
  const env={REPORTING_DB:db,ZENDESK_SUBDOMAIN:"example",ZENDESK_AGENT_IDS_JSON:JSON.stringify(collectorIds),ZENDESK_OAUTH_CLIENT_ID:"mock-client",ZENDESK_OAUTH_CLIENT_SECRET:"mock-secret",ZENDESK_REFRESH_TOKEN:"mock-initial",OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  let pending;
  await worker.scheduled({scheduledTime:Date.parse("2026-10-21T22:00:00Z")},env,{waitUntil(p){pending=p;}});
  await pending;
  const normalizedAudits=audits.map(a=>minimalAudit(a,new Set([...Object.values(collectorIds),606])));
  const analytics=buildDailyRows({day:"2026-10-21",tickets:[minimalTicket(ticket)],metricsByTicket:new Map([["1",metric]]),auditsByTicket:new Map([["1",normalizedAudits]]),ratings:[],agentIds:collectorIds});
  // Use actual candidate IDs for validator scope, keeping test fixtures synthetic.
  const mapping=new Map(Object.entries(collectorIds).map(([key,id])=>[id,Number(CANDIDATE_USERS.find(u=>u.key===key).id)]));
  mapping.set(606,Number(CANDIDATE_USERS.find(u=>u.key==="arez").id));
  const validatorFetch=async(url,init)=>{
    const response=await fetchImpl(url,init);
    const body=await response.json();
    if(body.audits) body.audits=body.audits.map(a=>({...a,author_id:mapping.get(a.author_id)??a.author_id,events:a.events.map(e=>e.field_name==="assignee_id"?{...e,value:mapping.get(Number(e.value))??e.value}:e)}));
    if(body.users) body.users=body.users.map(u=>({...u,id:mapping.get(u.id)??u.id}));
    return new Response(JSON.stringify(body),{status:200});
  };
  const validation=await validateDay("2026-10-21",{subdomain:"example",accessToken:"mock-access",fetchImpl:validatorFetch});
  return {staged,snapshots,analytics,validation};
}

for (const [key,id] of Object.entries(collectorIds)) {
  test(`scheduled collector stages ${key} independently and finalizes its solved count`, async t=>{
    const {staged,snapshots,analytics,validation}=await collectScenario(t,{assignee:id,actor:606});
    assert.equal(staged.length,1);
    assert.equal(staged[0].agent_key,key);
    assert.equal(snapshots.find(row=>row[1]===key)[3],1);
    assert.equal(analytics.find(row=>row.agentKey===key).solved_tickets,1);
    assert.equal(validation.ticketsWithSolvedAtInPhtDay,1);
    if(key!=="amora") assert.equal(snapshots.find(row=>row[1]==="amora")[3],0);
  });
}

test("collector, analytics and validator count outside-scope agent replies without counting requester replies",async t=>{
  const audits=[rawAudit("2026-10-21T10:00:00Z",202,[assign(202),comment]),rawAudit("2026-10-21T11:00:00Z",606,[comment]),rawAudit("2026-10-21T11:30:00Z",888,[comment]),rawAudit(solveTime,202,[solveEvent])];
  const {staged,snapshots,analytics,validation}=await collectScenario(t,{audits});
  assert.equal(JSON.parse(staged[0].metric_json).one_touch,false);
  assert.equal(snapshots.find(r=>r[1]==="gen")[9],0);
  assert.equal(analytics.find(r=>r.agentKey==="gen").one_touch_percent,0);
  assert.equal(validation.byAssignee[0].oneTouch,0);
});

for(const scenario of [
  {name:"Arez assignment is excluded even when a reporting agent solves",assignee:606,actor:202,expected:null},
  {name:"unassigned solve falls back to final solve actor",assignee:null,actor:404,expected:"ford"},
  {name:"post-solve assignment does not change attribution",audits:[rawAudit("2026-10-21T10:00:00Z",202,[assign(202)]),rawAudit(solveTime,404,[solveEvent]),rawAudit("2026-10-21T13:00:00Z",101,[assign(101)])],expected:"gen"},
  {name:"assigned ticket without exact solve event uses assignee",audits:[rawAudit("2026-10-21T10:00:00Z",202,[assign(202)])],expected:"gen"},
  {name:"prior solve actor cannot substitute for missing final solve",audits:[rawAudit("2026-10-21T10:00:00Z",202,[solveEvent])],expected:null}
]) test(`attribution parity: ${scenario.name}`,async t=>{
  const {staged,analytics,validation}=await collectScenario(t,scenario);
  assert.deepEqual(staged.map(r=>r.agent_key),scenario.expected?[scenario.expected]:[]);
  assert.equal(analytics.reduce((n,r)=>n+r.solved_tickets,0),scenario.expected?1:0);
  assert.equal(validation.ticketsWithSolvedAtInPhtDay,scenario.expected?1:0);
});

for(const scenario of [{channel:"api",expected:null},{reopens:1,expected:false},{expected:true},{audits:[rawAudit("2026-10-21T10:00:00Z",202,[assign(202),comment]),rawAudit("2026-10-21T11:00:00Z",888,[comment]),rawAudit(solveTime,202,[solveEvent])],expected:true}]) {
  test(`one-touch parity: ${scenario.audits ? "requester reply is ignored" : JSON.stringify(scenario)}`,async t=>{
    const {staged,snapshots,analytics,validation}=await collectScenario(t,scenario);
    assert.equal(JSON.parse(staged[0].metric_json).one_touch,scenario.expected);
    assert.equal(snapshots.find(r=>r[1]==="gen")[11],scenario.expected===null?0:1);
    assert.equal(analytics.find(r=>r.agentKey==="gen").one_touch_denominator,scenario.expected===null?0:1);
    assert.equal(validation.byAssignee[0].oneTouchEligible,scenario.expected===null?0:1);
    assert.equal(validation.byAssignee[0].oneTouch,scenario.expected===true?1:0);
  });
}

for (const solvedAt of ["invalid", "2026-10-21T16:00:00Z", "2026-10-20T15:59:59Z"]) {
  test(`collector rejects ineligible solved timestamp ${solvedAt}`, async t => {
    const {staged,analytics,validation}=await collectScenario(t,{solvedAt});
    assert.equal(staged.length,0);
    assert.equal(analytics.reduce((n,r)=>n+r.solved_tickets,0),0);
    assert.equal(validation.ticketsWithSolvedAtInPhtDay,0);
  });
}
