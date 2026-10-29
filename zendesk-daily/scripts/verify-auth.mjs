import { pathToFileURL } from 'node:url';
import { createClientCredentialsAuth } from '../worker/src/oauth.js';
import { apiBase, requestWithRetry } from '../worker/src/zendesk.js';
import { verifyCandidateUsers } from './validate-readonly.mjs';

export async function verifyAuth({ env = process.env, fetchImpl = fetch } = {}) {
  const auth = createClientCredentialsAuth(env, fetchImpl);
  const response = await requestWithRetry(`${apiBase(env.ZENDESK_SUBDOMAIN)}/users/me`, auth, fetchImpl);
  const { user } = await response.json();
  if (!user?.id) throw new Error('Zendesk authentication identity missing');
  const candidates = await verifyCandidateUsers(env.ZENDESK_SUBDOMAIN, auth, fetchImpl);
  const identities = candidates.map(({ key, label, reporting, verified, identity }) => ({
    key, label, reporting, verified, ...identity,
    eligible: Boolean(verified && identity.active === true && ['agent', 'admin'].includes(identity.role))
  }));
  return { authentication: 'OAuth Client Credentials accepted by read-only GET', scope: 'read',
    identities, reportingAgentCount: identities.filter(u => u.reporting).length,
    status: identities.every(u => u.eligible) ? 'verified' : 'identity verification incomplete' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyAuth().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'verified') process.exitCode = 1;
  }).catch(() => {
    // Do not serialize untrusted exception messages, response bodies, or credentials.
    process.stderr.write('Zendesk authentication verification failed\n');
    process.exitCode = 1;
  });
}
