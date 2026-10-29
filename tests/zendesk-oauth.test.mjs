import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientCredentialsAuth, getAccessToken } from '../zendesk-daily/worker/src/oauth.js';
import { requestWithRetry } from '../zendesk-daily/worker/src/zendesk.js';
import { resolveReadOnlyAuth, CANDIDATE_USERS } from '../zendesk-daily/scripts/validate-readonly.mjs';
import { verifyAuth } from '../zendesk-daily/scripts/verify-auth.mjs';
const env = { ZENDESK_SUBDOMAIN:'example', ZENDESK_OAUTH_CLIENT_ID:'client-private', ZENDESK_OAUTH_CLIENT_SECRET:'secret-private', ZENDESK_ACCESS_TOKEN:'invalid-legacy' };
const json = (body, status=200) => new Response(JSON.stringify(body), {status});
const issued = (token='access-private', expires_in=60) => json({access_token:token,expires_in,token_type:'bearer',scope:'read'});
const url = 'https://example.zendesk.com/api/v2/users/me';

test('client credentials use read scope, override legacy token, cache in memory and serialize no secrets', async()=>{
 let calls=0;
 const auth=resolveReadOnlyAuth(env, async(target,init)=>{
  calls++; assert.equal(target,'https://example.zendesk.com/oauth/tokens');
  assert.equal(init.redirect,'error'); assert.equal(init.method,'POST');
  assert.deepEqual(JSON.parse(init.body),{grant_type:'client_credentials',client_id:env.ZENDESK_OAUTH_CLIENT_ID,client_secret:env.ZENDESK_OAUTH_CLIENT_SECRET,scope:'read'});
  return issued();
 });
 assert.equal(await auth.getToken(),'access-private');
 assert.deepEqual(await Promise.all([auth.getToken(),auth.getToken()]),['access-private','access-private']);
 assert.equal(calls,1); assert.doesNotMatch(JSON.stringify(auth),/private|invalid-legacy/);
 assert.equal(await getAccessToken(env,async()=>issued()),'access-private');
});

test('expiration renews once and concurrent callers share token acquisition',async()=>{
 let time=1000,calls=0;
 const auth=createClientCredentialsAuth(env,async()=>issued(`token-${++calls}`,1),()=>time);
 assert.deepEqual(await Promise.all([auth.getToken(),auth.getToken()]),['token-1','token-1']);
 time=1999; assert.equal(await auth.getToken(),'token-1');
 time=2000; assert.deepEqual(await Promise.all([auth.getToken(),auth.getToken()]),['token-2','token-2']);
 assert.equal(calls,2);
});

for (const status of [400,401,403,500]) test(`authentication failure ${status} is sanitized with no fallback`,async()=>{
 let calls=0;
 const auth=resolveReadOnlyAuth(env,async()=>{calls++;return json(env,status)});
 await assert.rejects(auth.getToken(),error=>error.message===`Zendesk OAuth token request failed (${status})`);
 assert.equal(calls,1);
});

test('token network and malformed response errors protect secrets',async()=>{
 for(const fetchImpl of [async()=>{throw Error(JSON.stringify(env))},async()=>new Response('secret-private'),async()=>json(null),async()=>json({access_token:'secret-private',expires_in:60,token_type:123}),async()=>json({access_token:'secret-private'}),async()=>json({access_token:'secret-private',expires_in:60,scope:'write'})]) {
  await assert.rejects(createClientCredentialsAuth(env,fetchImpl).getToken(),error=>!JSON.stringify(error.message).includes('private'));
 }
 assert.throws(()=>resolveReadOnlyAuth({...env,ZENDESK_OAUTH_CLIENT_SECRET:''}),/not configured/);
});

for(const finalStatus of [200,401]) test(`401 triggers only one controlled renewal, ending ${finalStatus}`,async()=>{
 let grants=0,reads=0;
 const fetchImpl=async(target,init)=>{
  if(target.endsWith('/oauth/tokens'))return issued(`access-${++grants}`);
  reads++;assert.equal(init.headers.Authorization,`Bearer access-${reads}`);
  return json({},reads===1?401:finalStatus);
 };
 const auth=createClientCredentialsAuth(env,fetchImpl);
 if(finalStatus===200) assert.equal((await requestWithRetry(url,auth,fetchImpl)).status,200);
 else await assert.rejects(requestWithRetry(url,auth,fetchImpl),/\(401\)/);
 assert.equal(grants,2);assert.equal(reads,2);
});

test('managed credentials cannot follow foreign pagination or redirects and errors are sanitized',async()=>{
 const auth=createClientCredentialsAuth(env,async()=>issued());
 await assert.rejects(requestWithRetry('https://attacker.test',auth,async()=>assert.fail()),/origin/);
 await assert.rejects(requestWithRetry(url,auth,async()=>{throw Error('access-private')}),/failed \(network\)/);
});

test('verification reads authenticated identity and all six candidates; Arez excluded',async()=>{
 const paths=[];
 const fetchImpl=async(target,init)=>{
  const path=new URL(target).pathname;paths.push(path);
  if(path==='/oauth/tokens')return issued();
  assert.equal(init.method ?? 'GET','GET');
  if(path.endsWith('/users/me'))return json({user:{id:1}});
  return json({users:CANDIDATE_USERS.map(c=>({id:c.id,name:c.label,role:'agent',active:true}))});
 };
 const result=await verifyAuth({env,fetchImpl});
 assert.equal(result.status,'verified');assert.equal(result.identities.length,6);
 assert.equal(result.reportingAgentCount,5);assert.equal(result.identities.find(c=>c.key==='arez').reporting,false);
 assert.doesNotMatch(JSON.stringify(result),/private|invalid-legacy/);
 assert.deepEqual(paths,['/oauth/tokens','/api/v2/users/me','/api/v2/users/show_many']);
});

test('failed renewal stops without using legacy credentials or retrying the API',async()=>{
 let grants=0,reads=0;
 const fetchImpl=async(target)=>{
  if(target.endsWith('/oauth/tokens'))return ++grants===1?issued():json(env,401);
  reads++;return json({},401);
 };
 await assert.rejects(requestWithRetry(url,createClientCredentialsAuth(env,fetchImpl),fetchImpl),/token request failed \(401\)/);
 assert.equal(grants,2);assert.equal(reads,1);
});

test('a late concurrent 401 reuses the already renewed token',async()=>{
 let calls=0;
 const auth=createClientCredentialsAuth(env,async()=>issued(`access-${++calls}`));
 const old=await auth.getToken();
 assert.deepEqual(await Promise.all([auth.getToken(old),auth.getToken(old)]),['access-2','access-2']);
 assert.equal(await auth.getToken(old),'access-2');assert.equal(calls,2);
});

test('identity verification reports missing and inactive candidates without changing reporting scope',async()=>{
 const fetchImpl=async(target)=>{
  if(target.endsWith('/oauth/tokens'))return issued();
  if(target.endsWith('/users/me'))return json({user:{id:1}});
  return json({users:CANDIDATE_USERS.slice(1).map(c=>({id:c.id,role:'agent',active:c.key!=='arez'}))});
 };
 const result=await verifyAuth({env,fetchImpl});
 assert.equal(result.status,'identity verification incomplete');
 assert.equal(result.identities.find(c=>c.key==='amora').verified,false);
 assert.equal(result.identities.find(c=>c.key==='arez').eligible,false);
 assert.equal(result.reportingAgentCount,5);
});
