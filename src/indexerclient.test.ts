/**
 * A 404 from a route that does not exist is an outage, not an answer.
 *
 * This client called `/v1/tokens/:urn/facts` and
 * `/v1/chains/:chain/transactions/:hash/escrow`. `micro-indexer` serves neither, and no `/v1`
 * paths at all — its table is /chains, /addresses, /transactions, /blocks, /watch, /backfills
 * (`indexer/src/server.ts:317-322`). So every call 404'd, always.
 *
 * The escrow branch turned that into `{confirmed: false}`, and `server.ts:761` turns that into
 * "the on-chain escrow is not confirmed yet". So EVERY on-chain escrow activation failed with a
 * diagnosis that was false — a seller retries for ever, and an operator investigates the chain
 * rather than the integration. The facts branch returned `null`, which rendered "no indicators"
 * on every listing in the marketplace, permanently and silently.
 *
 * Both passed 287 tests, because every one of them stubbed the response rather than asking whether
 * the request could reach a route. That is the seventh instance of this shape in the estate and
 * the third in this repository.
 *
 * Failing closed is unchanged and correct. What these tests pin is that "we could not ask" is
 * reported as an outage, which is the distinction the fail-closed argument depends on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { IndexerUnavailableError, httpIndexerClient } from './indexerclient.ts'

const CLIENT = readFileSync(fileURLToPath(new URL('./indexerclient.ts', import.meta.url)), 'utf8')

function clientWith(status: number) {
  return httpIndexerClient({
    baseUrl: 'http://indexer.test',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      }),
  })
}

test('a 404 on escrow status is an outage, never an unconfirmed escrow', async () => {
  // The dangerous one. Returning `{confirmed:false}` here made a missing route indistinguishable
  // from a genuinely unconfirmed transaction, and the listing was refused with the wrong reason
  // for ever.
  await assert.rejects(
    () => clientWith(404).escrowStatus('ember', '0xabc'),
    (err: unknown) => {
      assert.ok(err instanceof IndexerUnavailableError)
      assert.match(err.message, /no escrow-status route/)
      return true
    },
  )
})

test('a 404 on token facts is an outage, never "no indicators"', async () => {
  await assert.rejects(
    () => clientWith(404).tokenFacts('urn:cloudsforge:market:item:1'),
    (err: unknown) => err instanceof IndexerUnavailableError,
  )
})

test('a real outage is still an outage', async () => {
  // The 503 path must not have been broken by making 404 join it.
  await assert.rejects(
    () => clientWith(503).escrowStatus('ember', '0xabc'),
    (err: unknown) => err instanceof IndexerUnavailableError,
  )
})

test('the routes this client needs and the indexer does not serve are exactly the known two', () => {
  // NOT a claim that the paths are right — they are not, and cannot be until the indexer grows
  // the capabilities. `/v1/tokens/:urn/facts` and `/v1/chains/:chain/transactions/:hash/escrow`
  // have no counterpart in `indexer/src/server.ts:317-322`, which serves /chains, /addresses,
  // /transactions, /blocks, /watch and /backfills, none of them versioned.
  //
  // What this pins is the SIZE of the gap. Both known-missing calls now fail loudly rather than
  // answering (the three tests above), and a THIRD unserved route added here would slip in
  // silently. When the indexer serves them, this test fails and is deleted along with the
  // workaround — which is how the estate's other self-deleting notes have behaved.
  const served = ['/chains/', '/addresses/', '/transactions/', '/blocks/', '/watch/', '/backfills/']
  // COMMENTS STRIPPED FIRST. The first version of this scan matched `/v1`, `/tokens` and
  // `/escrow` inside the comment above explaining that those routes do not exist — the seventh
  // instance of a guard in this estate reading its own prose, and the second I have written
  // myself. A checker that cannot tell a request from a sentence about one is not a checker.
  const code = CLIENT.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  const paths = [...code.matchAll(/`(\/[A-Za-z0-9/${}().\-_:]+)`/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p.length > 1)
  const unserved = paths.filter((p) => !served.some((s) => p.startsWith(s)))
  assert.equal(
    unserved.length,
    2,
    `expected exactly the two known-missing routes, found ${unserved.length}: ${unserved.join(', ')}`,
  )
  assert.ok(unserved.every((p) => p.includes('/facts') || p.includes('/escrow')), unserved.join(', '))
})
