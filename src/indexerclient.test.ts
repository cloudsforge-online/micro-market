/**
 * A 404 is an answer or an outage, and which one it is decides whether this marketplace tells the
 * truth about money.
 *
 * ## What this used to pin, and what it pins now
 *
 * This client called `/v1/tokens/:urn/facts` and `/v1/chains/:chain/transactions/:hash/escrow`.
 * `micro-indexer` served neither, so every call 404'd, always — and the escrow branch turned that
 * into `{confirmed: false}`, which `server.ts` turned into "the on-chain escrow is not confirmed
 * yet". EVERY on-chain escrow activation failed with a diagnosis that was false. All 287 tests
 * passed throughout, because every one of them stubbed the response rather than asking whether the
 * request could reach a route.
 *
 * The escrow half is now real: `micro-indexer` serves
 * `GET /transactions/:chain/:network/:hash/confirmations` (18-build-status §3.3j), and it answers
 * **404 `transaction_not_found`** for a transaction it has never seen. So a 404 splits, and the
 * split is the thing under test here:
 *
 *   `transaction_not_found`  a fact about the chain. `known: false`, and the seller is told to
 *                            check their hash and their network.
 *   anything else            a path this service asked for and the indexer does not serve. Our
 *                            own misconfiguration, which says nothing about any chain, and stays
 *                            an outage exactly as before.
 *
 * The token-facts half is still an outage, and the last test says why in one line: it is not a
 * capability any service in the estate owns, so its absence is a design gap rather than an unbuilt
 * route. That test is the one that goes red the day somebody does own it.
 *
 * A correction to the note this file used to carry: `micro-indexer` DOES serve `/v1` paths. Its
 * `PREFIXES` (`indexer/src/server.ts:124`) mounts every domain route under both `/v1` and bare.
 * The old calls 404'd because there is no `/tokens` route and no `/escrow` sub-resource, not
 * because of the prefix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { IndexerUnavailableError, httpIndexerClient } from './indexerclient.ts'

const CLIENT = readFileSync(fileURLToPath(new URL('./indexerclient.ts', import.meta.url)), 'utf8')

const HASH = `0x${'a'.repeat(64)}`

/** A client whose indexer answers exactly this, and a record of what it was asked for. */
function clientWith(
  status: number,
  body: unknown,
): { client: ReturnType<typeof httpIndexerClient>; asked: string[] } {
  const asked: string[] = []
  const client = httpIndexerClient({
    baseUrl: 'http://indexer.test',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: async (input) => {
      asked.push(new URL(String(input)).pathname)
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      })
    },
  })
  return { client, asked }
}

const notFound = (code: string): unknown => ({ error: { code, message: 'no', requestId: 'r' } })

/* ------------------------------------------------------------------ the escrow question */

test('the client asks for the route the indexer actually serves', async () => {
  // `:chain/:network` first and no invented prefix — the indexer's own convention. Asserted on the
  // wire rather than on the source, because a template literal that reads right can still send the
  // wrong path.
  const { client, asked } = clientWith(200, {
    confirmed: true,
    confirmations: 61,
    requiredConfirmations: 60,
    status: 'success',
    canonical: true,
    halted: false,
  })
  const answer = await client.escrowStatus('ember', 'testnet', HASH)
  assert.deepEqual(asked, [`/transactions/ember/testnet/${HASH}/confirmations`])
  assert.equal(answer.known, true)
  assert.equal(answer.confirmed, true)
  // The depth travels with the answer. This service must never hold a copy of it — `contracts-chain`
  // is exact-pinned precisely so four services cannot disagree about what "confirmed" means.
  assert.equal(answer.requiredConfirmations, 60)
  assert.equal(answer.confirmations, 61)
})

test('a transaction the indexer has never seen is an ANSWER, not an outage', async () => {
  // The half of the 404 that is a fact. Before the route existed, this case did not exist either:
  // every call 404'd and every activation was refused with the wrong reason.
  const { client } = clientWith(404, notFound('transaction_not_found'))
  const answer = await client.escrowStatus('ember', 'testnet', HASH)
  assert.equal(answer.known, false)
  assert.equal(answer.confirmed, false, 'fail closed: an unknown transaction is never confirmed')
  // Null, never zero. Zero is a real depth and this is the absence of one.
  assert.equal(answer.confirmations, null)
  assert.equal(answer.requiredConfirmations, null)
  assert.equal(answer.status, null)
})

test('a 404 from a path the indexer does not serve is still an outage', async () => {
  // The dangerous half, and the reason this branches on the CODE rather than on the status. If a
  // route is ever renamed under us, this must fail loudly rather than report every escrow in the
  // marketplace as a transaction that does not exist.
  const { client } = clientWith(404, notFound('not_found'))
  await assert.rejects(
    () => client.escrowStatus('ember', 'testnet', HASH),
    (err: unknown) => err instanceof IndexerUnavailableError,
  )
})

test('a 404 whose body cannot be read is an outage, never a confident negative', async () => {
  for (const body of ['<html>gateway</html>', {}, { error: {} }, { error: { code: 7 } }]) {
    const { client } = clientWith(404, body)
    await assert.rejects(
      () => client.escrowStatus('ember', 'testnet', HASH),
      (err: unknown) => err instanceof IndexerUnavailableError,
      JSON.stringify(body),
    )
  }
})

test('an unreadable 200 is not "unconfirmed"', async () => {
  // A response-shape change must not silently become a refusal with the wrong reason, which is
  // exactly the failure mode this whole change removes. Same rule micro-community applies to an
  // unreadable 201 from policy.
  for (const body of [{}, { confirmed: 'yes' }, { confirmed: 1 }]) {
    const { client } = clientWith(200, body)
    await assert.rejects(
      () => client.escrowStatus('ember', 'testnet', HASH),
      (err: unknown) => err instanceof IndexerUnavailableError,
      JSON.stringify(body),
    )
  }
})

test('a real outage is still an outage', async () => {
  for (const status of [500, 502, 503]) {
    const { client } = clientWith(status, { error: { code: 'internal' } })
    await assert.rejects(
      () => client.escrowStatus('ember', 'testnet', HASH),
      (err: unknown) => err instanceof IndexerUnavailableError,
      String(status),
    )
  }
})

test('a seen-but-shallow transaction is a negative answer, and carries its own arithmetic', async () => {
  const { client } = clientWith(200, {
    confirmed: false,
    confirmations: 3,
    requiredConfirmations: 60,
    status: 'success',
    canonical: true,
    halted: false,
  })
  const answer = await client.escrowStatus('ember', 'testnet', HASH)
  assert.equal(answer.known, true, 'seen — which is what makes "not yet" a true statement')
  assert.equal(answer.confirmed, false)
  assert.equal(answer.confirmations, 3)
  assert.equal(answer.requiredConfirmations, 60)
})

/* ------------------------------------------------------------------ what the seller is told */

test('a refusal names which of the five things actually happened', async () => {
  // The old message was one sentence for every outcome — "the on-chain escrow is not confirmed
  // yet" — and it was false for all of them, because the route it came from did not exist. Only
  // one of these five is "wait"; the other four are things somebody has to go and do.
  const { escrowRefusal } = await import('./server.ts')
  const base = {
    known: true,
    confirmed: false,
    confirmations: 3,
    requiredConfirmations: 60,
    status: 'success',
    canonical: true,
    halted: false,
  } as const

  assert.match(
    escrowRefusal({ ...base, known: false, canonical: false, status: null }, 'ember', 'mainnet'),
    /no record of that transaction on ember\/mainnet/,
  )
  assert.match(escrowRefusal({ ...base, halted: true }, 'ember', 'mainnet'), /halted/)
  assert.match(escrowRefusal({ ...base, canonical: false, status: 'orphaned' }, 'ember', 'mainnet'), /canonical/)
  // A reverted transaction is mined, sits in a block, and gathers depth exactly like one that
  // worked. Telling its sender to wait longer would be advice that never comes good.
  assert.match(escrowRefusal({ ...base, status: 'failed' }, 'ember', 'mainnet'), /did not succeed/)
  assert.match(escrowRefusal(base, 'ember', 'mainnet'), /3 of 60 confirmations/)
})

/* ------------------------------------------------------------------ the facts question */

test('a 404 on token facts is an outage, never "no indicators"', async () => {
  const { client } = clientWith(404, notFound('not_found'))
  await assert.rejects(
    () => client.tokenFacts('cf:mint:token:0192'),
    (err: unknown) => err instanceof IndexerUnavailableError,
  )
})

test('exactly one route this client needs is one nothing in the estate serves', () => {
  // The self-deleting note, resized. It used to pin TWO unserved routes; the escrow one is served
  // now and this asserts it — `/transactions/` is in the served list below, so a regression to the
  // old `/v1/chains/.../escrow` spelling fails here.
  //
  // The one that remains is token facts, and it is NOT waiting on the indexer. It is keyed by a
  // `micro-mint` item URN that the indexer has no registry for, and five of `TokenFacts`' eight
  // fields are contract state or custody state a chain indexer does not hold. Whoever owns that
  // capability — a token registry — deletes this test and the workaround with it.
  const served = [
    '/chains/',
    '/addresses/',
    '/transactions/',
    '/blocks/',
    '/watch/',
    '/backfills/',
    '/v1/chains/',
    '/v1/addresses/',
    '/v1/transactions/',
    '/v1/blocks/',
    '/v1/watch/',
    '/v1/backfills/',
  ]
  // COMMENTS STRIPPED FIRST. The first version of this scan matched `/v1`, `/tokens` and `/escrow`
  // inside the comment explaining that those routes do not exist — a guard reading its own prose.
  // A checker that cannot tell a request from a sentence about one is not a checker.
  const code = CLIENT.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  const paths = [...code.matchAll(/`(\/[A-Za-z0-9/${}().\-_:]+)`/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p.length > 1)
  assert.ok(paths.length >= 2, `the scan found no request paths at all: ${paths.join(', ')}`)
  const unserved = paths.filter((p) => !served.some((s) => p.startsWith(s)))
  assert.equal(
    unserved.length,
    1,
    `expected only the token-facts route to be unserved, found ${unserved.length}: ${unserved.join(', ')}`,
  )
  assert.ok(unserved.every((p) => p.includes('/facts')), unserved.join(', '))
  // And the escrow path is a served one now. Stated positively so that deleting the line above
  // could not quietly make this test vacuous.
  assert.ok(
    paths.some((p) => p.startsWith('/transactions/')),
    `the escrow question is not asked of a served route: ${paths.join(', ')}`,
  )
})
