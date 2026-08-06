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
 * `PREFIXES` (`indexer/src/server.ts`) mounts every domain route under both `/v1` and bare.
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

/* ------------------------------------------------- do these paths exist, as SHAPES not prefixes */

/**
 * `micro-indexer`'s route table, as patterns, both spellings.
 *
 * Copied from `indexer/src/server.ts` (`DOMAIN`) and (`PREFIXES = ['/v1', '']`).
 * A copy, not an import: rule 2 of the estate's CI forbids source in one repository reaching into
 * a sibling checkout, and `micro-mint`'s CI job — `scripts/checkindexerroutes.mjs` — is the version
 * of this check that reads the real file. This one is the cheap in-suite backstop, and it goes red
 * on a shape rather than on a prefix.
 */
const INDEXER_ROUTES: readonly string[] = [
  '/chains/:chain/:network/status',
  '/addresses/:chain/:network/:address/activity',
  '/addresses/:chain/:network/:address/token-balances',
  '/transactions/:chain/:network/:hash',
  '/transactions/:chain/:network/:hash/confirmations',
  '/tokens/:chain/:network/:address',
  '/blocks/:chain/:network/:height',
  '/watch/:chain/:network/:address',
  '/backfills/:chain/:network',
].flatMap((path) => [path, `/v1${path}`])

/**
 * Does a requested path match a served pattern? Same segment count, and every segment agrees.
 *
 * **Segment counts, never prefixes**, and this is the whole point of the rewrite. The version of
 * this test that shipped first matched `path.startsWith(servedPrefix)` against a list containing
 * `/v1/chains/`, and pinned the COUNT of unserved paths rather than their shapes. `micro-mint` then
 * shipped the identical defect this file exists to catch — it called
 * `/v1/chains/:chain/:network/transactions/:hash`, which the indexer has never served — and **the
 * prefix version of this guard would have passed it**, because the dead path begins with a prefix
 * the indexer really does serve. A count is not a shape. Copied from
 * `mint/scripts/checkindexerroutes.mjs` rather than invented a third time.
 */
function matches(requested: string, pattern: string): boolean {
  const asked = requested.split('/')
  const serves = pattern.split('/')
  if (asked.length !== serves.length) return false
  return serves.every((segment, index) => {
    const mine = asked[index] ?? ''
    return segment.startsWith(':') ? mine.length > 0 : segment === mine
  })
}

/**
 * `${...}` is exactly ONE segment.
 *
 * So a helper standing for two — a `${scope}` holding `chain/network` — produces a path one segment
 * short of every pattern and is refused rather than guessed at. That is deliberate: a checker that
 * accepts a path whose shape it cannot see would have passed the defect it exists to catch. This
 * client had exactly such a helper until the shape check was added, and removing it is part of the
 * same change.
 */
const placeholder = (path: string): string => path.replace(/\$\{[^}]*\}/g, 'x')

/** Every request path this client sends, read out of its source with the prose stripped. */
export function requestedPaths(source: string): readonly string[] {
  // COMMENTS STRIPPED FIRST. This file and the client both quote dead paths in prose, and a
  // checker that cannot tell a request from a sentence about one is not a checker.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
  return [...code.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1] ?? '').filter((p) => p.length > 1)
}

test('every path this client requests is a whole route shape the indexer serves — or the one that is not', () => {
  const paths = requestedPaths(CLIENT)
  assert.equal(paths.length, 2, `expected exactly two request paths, found: ${paths.join(', ')}`)

  const unserved = paths.filter((p) => !INDEXER_ROUTES.some((r) => matches(placeholder(p), r)))

  // The escrow path is SERVED, stated positively so that the assertion below cannot go vacuous by
  // both paths quietly becoming unserved.
  const served = paths.filter((p) => !unserved.includes(p))
  assert.deepEqual(
    served.map(placeholder),
    ['/transactions/x/x/x/confirmations'],
    `the escrow question must reach a route the indexer serves; asked: ${paths.join(', ')}`,
  )

  // And exactly one is not, by SHAPE: token facts. It is not waiting on the indexer — it is keyed
  // by a `micro-mint` item URN the indexer has no registry for, and three of `TokenFacts`' eight
  // fields need complete holder history or a custody fact about a private key. Whoever owns that
  // capability — a token registry — deletes this test and the workaround with it.
  assert.deepEqual(
    unserved.map(placeholder),
    ['/v1/tokens/x/facts'],
    `unserved paths are not the one expected: ${unserved.join(', ')}`,
  )
})

test('the shape check goes red on a path the indexer does not serve — including a served PREFIX', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE MUTATION, IN THE SUITE.
  //
  // It is not enough that the check says "all good". It has to be shown that it can say otherwise,
  // and specifically on the case the old prefix version passed: `/v1/chains/…/transactions/…` is
  // the exact dead path `micro-mint` shipped, and it BEGINS with `/v1/chains/`, which the indexer
  // really does serve. A prefix test calls it fine. A shape test does not.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const dead = [
    // micro-mint's real defect: the status route's prefix with a resource bolted on.
    '/v1/chains/${chain}/${network}/transactions/${hash}',
    // micro-market's original two.
    '/v1/chains/${chain}/transactions/${hash}/escrow',
    '/v1/tokens/${urn}/facts',
    // Right shape, wrong resource.
    '/v1/receipts/${chain}/${network}/${hash}',
    // Right resource, one segment too many.
    '/v1/transactions/${chain}/${network}/${hash}/confirmations/latest',
  ]
  for (const path of dead) {
    assert.equal(
      INDEXER_ROUTES.some((r) => matches(placeholder(path), r)),
      false,
      `${path} is not served by micro-indexer, but this check accepted it`,
    )
  }

  // ── And the reason the `${scope}` helper had to come out of the client ──────────────────────
  //
  // `/transactions/${scope}/${hash}/confirmations`, with `${scope}` holding `chain/network`,
  // collapses to FOUR segments. That is not merely one short of the confirmations route — it is
  // exactly the shape of `/transactions/:chain/:network/:hash`, so the checker matches it against
  // the WRONG route and reports it as fine. Measured here rather than asserted in prose, because
  // it is the strongest argument for writing every segment out: a shape check can only judge the
  // shape it is shown, and a helper hides one.
  assert.equal(
    INDEXER_ROUTES.some((r) => matches(placeholder('/transactions/${scope}/${hash}/confirmations'), r)),
    true,
    'the scope form was expected to match a DIFFERENT route — if it no longer does, rewrite this note',
  )
  assert.equal(placeholder('/transactions/${scope}/${hash}/confirmations').split('/').length, 5)
  assert.equal(
    placeholder('/transactions/${chain}/${network}/${hash}/confirmations').split('/').length,
    6,
  )

  // And it is not simply refusing everything: every route the indexer serves matches itself, and
  // the two spellings are both real.
  for (const route of INDEXER_ROUTES) {
    assert.ok(matches(route, route), route)
  }
  assert.ok(
    matches('/v1/transactions/ember/testnet/0xabc/confirmations', '/v1/transactions/:chain/:network/:hash/confirmations'),
  )
  assert.ok(
    matches('/transactions/ember/testnet/0xabc/confirmations', '/transactions/:chain/:network/:hash/confirmations'),
  )
})
