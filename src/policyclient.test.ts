/**
 * The policy client, checked against the route table policy actually serves.
 *
 * This file exists because the client was written against an imagined surface. It called
 * `POST /v1/decisions/market.listing`; policy has no `/v1` routes at all and takes the action in
 * the body (`policy/src/server.ts`, `parseDecisionRequest`). Every listing check
 * therefore 404'd.
 *
 * It was first reported as the gate being bypassed — a 404 swallowed into `review` + `degraded`.
 * Checking that against the code showed the opposite, and worse: `peerDecided` is true for ANY
 * 4xx (`runtime/packages/http/src/index.ts`), so the 404 landed on the `deny` branch, and
 * `server.ts` turns a deny into a 403. The marketplace was not unmoderated — **it was closed.
 * Every listing creation returned 403 `policy_denied`.** Worth stating precisely, because the two
 * failures need opposite fixes and guessing between them would have fixed neither.
 *
 * The defect was invisible to every existing test because they all stubbed fetch and asserted the
 * client's behaviour given a *response*, never that the request could reach a real route. So these
 * tests assert the request: its path, its action name, and the shape policy parses. Same class as
 * the recorded `wallet/src/pricingclient.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEGRADED_VERDICT, httpPolicyClient, type ListingPolicyInput } from './policyclient.ts'

const INPUT: ListingPolicyInput = {
  sellerSubject: 'user:01J0000000000000000000000',
  assetKind: 'title',
  itemUrn: 'urn:cloudsforge:market:listing:01J000000000000000000000A',
  amount: '1000',
  assetCode: 'SHARD',
  settlementMode: 'instant',
}

/** Captures the one request the client makes, and answers as policy answers. */
function harness(reply: { status: number; body: unknown }) {
  const seen: { url: string; method: string; body: Record<string, unknown> } = {
    url: '',
    method: '',
    body: {},
  }
  const client = httpPolicyClient({
    baseUrl: 'http://policy.test',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input)
      seen.method = init?.method ?? ''
      seen.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      })
    },
  })
  return { client, seen }
}

const ALLOW = { status: 201, body: { decision: { decision: 'allow', reasons: [] } } }

test('it posts to /decisions — the route policy actually serves', async () => {
  const { client, seen } = harness(ALLOW)
  await client.evaluateListing(INPUT)
  const path = new URL(seen.url).pathname
  assert.equal(path, '/decisions')
  assert.doesNotMatch(path, /\/v1\//, 'policy has no /v1 routes; a /v1 path is a guaranteed 404')
  assert.equal(seen.method, 'POST')
})

test('the action is the one policy has registered, spelled exactly', async () => {
  // Policy's registry is closed on purpose: an unregistered action is a 400, never a guess, so a
  // misspelling cannot reach the fail-open path. `market.listing` is not registered;
  // `market.listing.create` is (`policy/src/actions.ts`).
  const { client, seen } = harness(ALLOW)
  await client.evaluateListing(INPUT)
  assert.equal(seen.body['action'], 'market.listing.create')
})

test('the body carries what parseDecisionRequest requires', async () => {
  const { client, seen } = harness(ALLOW)
  await client.evaluateListing(INPUT)
  assert.equal(seen.body['subject'], INPUT.sellerSubject)
  assert.equal(seen.body['resource'], INPUT.itemUrn, 'resource is required and stored verbatim')
  assert.ok(seen.body['context'], 'context is required')
})

test('the amount crosses as a decimal STRING, never a JSON number', async () => {
  // Policy refuses a number outright rather than coercing, because a threshold comparison on a
  // float is the bug that service exists not to have.
  const { client, seen } = harness(ALLOW)
  await client.evaluateListing(INPUT)
  const ctx = seen.body['context'] as Record<string, unknown>
  assert.equal(typeof ctx['amount'], 'string')
  assert.equal(ctx['amount'], '1000')
})

test('policy\'s nested 201 envelope is read, not the flat shape', async () => {
  const { client } = harness({ status: 201, body: { decision: { decision: 'deny', reasons: ['velocity'] } } })
  const v = await client.evaluateListing(INPUT)
  assert.equal(v.decision, 'deny')
  assert.deepEqual(v.reasons, ['velocity'])
  assert.equal(v.degraded, false)
})

test('a 201 whose body cannot be read is NOT an allow', async () => {
  // Otherwise a change to policy's response shape silently opens the gate — the same way the 404
  // silently opened it.
  const { client } = harness({ status: 201, body: { unexpected: true } })
  const v = await client.evaluateListing(INPUT)
  assert.equal(v.decision, 'review')
  assert.equal(v.degraded, true)
})

test('a 404 degrades rather than denying — a missing route is not a decision', async () => {
  // This is the second half of the defect and it is worse than the first. A 404 is `peerDecided`
  // (any 4xx is), so the broken route did not merely bypass the gate — it returned `deny`, and
  // `server.ts` turns a deny into 403. Every listing creation on the platform was refused:
  // the marketplace was CLOSED, not unmoderated. A route that does not exist is our
  // misconfiguration, never a verdict about a seller's listing.
  const { client } = harness({ status: 404, body: { error: { code: 'not_found', message: 'no' } } })
  const v = await client.evaluateListing(INPUT)
  assert.equal(v.degraded, true)
  assert.equal(v.decision, DEGRADED_VERDICT.decision)
})

/*
 * THE THIRD HALF OF THE SAME DEFECT, and the one that actually shut the marketplace in the live
 * estate on 2026-08-04.
 *
 * `market` was started holding the compose PLACEHOLDER token. Policy answered 401. `peerDecided`
 * was true, so the client called it a `deny`, and `server.ts` turned that into a 403 on every
 * listing by every seller. Found only because somebody tried to seed the marketplace and could
 * not create a single listing.
 *
 * A 401 is a sentence about US, not about the listing: this caller is not authenticated. A 403 is
 * "this caller may not ask". Neither is a moderator's judgement, and reading them as one makes our
 * own misconfiguration indistinguishable from a decision — the same shape as a reconciliation
 * failure that cannot be told apart from "the chain could not be observed".
 *
 * 400 is deliberately NOT here: a caller can provoke a malformed request, so failing open on it
 * would hand an override to anyone able to send bad JSON.
 */
for (const status of [401, 403]) {
  test(`a ${status} is policy refusing US, not policy judging the listing`, async () => {
    const client = httpPolicyClient({
      baseUrl: 'http://policy.invalid',
      token: () => 'token',
      deadlineMs: 1_000,
      fetch: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
    })
    const v = await client.evaluateListing(INPUT)
    assert.equal(v.decision, DEGRADED_VERDICT.decision, `${status} must not read as a moderator's deny`)
    assert.equal(v.degraded, true, `${status} must be flagged degraded, so the evidence survives`)
  })
}

test('a 400 still denies, because a caller can provoke one', async () => {
  const client = httpPolicyClient({
    baseUrl: 'http://policy.invalid',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: async () => new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }),
  })
  const v = await client.evaluateListing(INPUT)
  assert.equal(v.decision, 'deny', 'failing open on 400 would hand an override to anyone sending bad JSON')
})


test('a decision is never overridden by the fail-open default', async () => {
  const { client } = harness({ status: 400, body: { error: { code: 'bad_request', message: 'no' } } })
  const v = await client.evaluateListing(INPUT)
  assert.equal(v.decision, 'deny', 'a 4xx is policy deciding, not policy failing')
  assert.equal(v.degraded, false)
})
