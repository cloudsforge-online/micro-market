/**
 * Idempotency.
 *
 * The first three tests pin the regression that `ledger/src/idempotency.test.ts` documents:
 * fingerprinting a trace id made every honest retry 409. `micro-wallet` had to carry a
 * correlation id that was stable per operation rather than per attempt in order to work around
 * it. That workaround should not have been necessary, and is not, here.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  namespacedKey,
  reapIdempotencyKeys,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import { migrateTestDb, openDb, resetMarket, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

/* ------------------------------------------------------------------ the fingerprint */

test('a retry with a fresh correlation id is a replay, not a 409', () => {
  // THE regression. A correlation id is a trace identifier and is meant to change per attempt —
  // that is what makes a retry distinguishable in a trace. Fingerprinting it meant a caller doing
  // exactly the right thing was told its idempotency key had been reused with a different
  // payload, and could not tell that apart from a genuine key collision.
  const first = { listingId: 'l-1', amount: '1000', correlationId: 'req-aaa' }
  const retry = { listingId: 'l-1', amount: '1000', correlationId: 'req-bbb' }
  assert.equal(requestFingerprint(first), requestFingerprint(retry))
})

test('a genuinely different payload under one key is still caught', () => {
  const first = { listingId: 'l-1', amount: '1000', correlationId: 'req-aaa' }
  const different = { listingId: 'l-1', amount: '9999', correlationId: 'req-aaa' }
  assert.notEqual(requestFingerprint(first), requestFingerprint(different))
})

test('a different LISTING under one key is caught — the path parameter is fingerprinted', () => {
  assert.notEqual(
    requestFingerprint({ listingId: 'l-1', amount: '1000' }),
    requestFingerprint({ listingId: 'l-2', amount: '1000' }),
  )
})

test('requestId and idempotencyKey are per-attempt too', () => {
  assert.equal(
    requestFingerprint({ amount: '1', requestId: 'a', idempotencyKey: 'k1' }),
    requestFingerprint({ amount: '1', requestId: 'b', idempotencyKey: 'k2' }),
  )
})

test('field order does not change the fingerprint', () => {
  // `JSON.stringify` preserves insertion order, so two semantically identical bodies that
  // serialised their fields differently would fingerprint differently and a legitimate retry
  // would be rejected as reuse.
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
})

test('a bigint amount fingerprints as its decimal string, never as a float', () => {
  assert.equal(
    requestFingerprint({ amount: 10n ** 24n }),
    requestFingerprint({ amount: '1000000000000000000000000' }),
  )
})

test('an undefined field is the same as an absent one', () => {
  assert.equal(requestFingerprint({ a: 1, b: undefined }), requestFingerprint({ a: 1 }))
})

test('arrays keep their order — a royalty split is not a set', () => {
  assert.notEqual(
    requestFingerprint({ royalties: ['a', 'b'] }),
    requestFingerprint({ royalties: ['b', 'a'] }),
  )
})

test('the namespaced key is scoped by service, route AND principal', () => {
  assert.equal(
    namespacedKey('market', '/v1/listings', 'user:alice', 'abc'),
    'market:/v1/listings:user:alice|abc',
  )
  // The same client key on two routes describes two operations, and a caller reusing its request
  // id across both is doing something reasonable.
  assert.notEqual(
    namespacedKey('market', '/v1/listings', 'user:alice', 'abc'),
    namespacedKey('market', '/v1/listings/:id/buy', 'user:alice', 'abc'),
  )
  assert.notEqual(
    namespacedKey('market', '/v1/listings', 'user:alice', 'abc'),
    namespacedKey('trade', '/v1/listings', 'user:alice', 'abc'),
  )
})

test('TWO CALLERS CHOOSING ONE KEY DO NOT COLLIDE — the defect, at its smallest', () => {
  // The route and the client key are identical and so is the body. Only the caller differs, and
  // that has to be enough, because callers choose their own keys and do not coordinate. Before
  // this argument existed, these two strings were the same one and the second caller was replayed
  // the first caller's answer.
  assert.notEqual(
    namespacedKey('market', '/v1/listings', 'user:alice', 'sha256-of-the-payload'),
    namespacedKey('market', '/v1/listings', 'user:bob', 'sha256-of-the-payload'),
  )
})

test('a principal cannot be spelled to look like somebody else’s principal-plus-key', () => {
  // The injectivity argument, pinned. A client key may contain colons (`SAFE_IDEMPOTENCY_KEY`),
  // and a principal is a token subject, so a `:` between them would let `user:a` + `b:cccccccc`
  // and `user:a:b` + `cccccccc` produce one string — the very collision this scoping removes,
  // reintroduced by punctuation. The delimiter is outside the client-key charset instead.
  assert.notEqual(
    namespacedKey('market', '/v1/listings', 'user:a', 'b:cccccccc'),
    namespacedKey('market', '/v1/listings', 'user:a:b', 'cccccccc'),
  )
})

test('a key written before this change can never resolve against one written after it', () => {
  // The transition, such as it is. The legacy format is `market:<route>:<clientKey>` and contains
  // no `|`; every key this function now returns contains one. So the clean break is genuinely
  // clean in the direction that matters: nothing stale is ever mistaken for something current.
  const legacy = 'market:/v1/listings:abc'
  assert.ok(!legacy.includes('|'))
  assert.ok(namespacedKey('market', '/v1/listings', 'user:alice', 'abc').includes('|'))
})

/* ------------------------------------------------------------------ against Postgres */

describe('withIdempotency, against a real Postgres', { skip }, () => {
  let sql: postgres.Sql
  let db: Db

  before(async () => {
    sql = openDb(6)
    await migrateTestDb(sql)
    db = sql as unknown as Db
  })
  beforeEach(async () => {
    await resetMarket(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  const BUYER = 'user:alice'

  const run = (
    key: string,
    body: Record<string, unknown>,
    work: () => Promise<string>,
    principal = BUYER,
  ) =>
    withIdempotency<Record<string, unknown>>(db, {
      originatingService: 'market',
      route: '/v1/listings/:id/buy',
      principal,
      clientKey: key,
      requestHash: requestFingerprint(body),
      run: async () => {
        const id = await work()
        return { response: { orderId: id }, artefactId: id }
      },
    })

  test('the first call runs the work; the second replays it', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      return `order-${calls}`
    }
    const first = await run('k1', { amount: '100' }, work)
    const second = await run('k1', { amount: '100' }, work)
    assert.equal(first.replayed, false)
    assert.equal(second.replayed, true)
    assert.deepEqual(second.result, first.result)
    assert.equal(calls, 1, 'the work ran twice')
  })

  test('A RETRY WITH A FRESH CORRELATION ID REPLAYS RATHER THAN 409ING', async () => {
    // End to end, through the real table, because the fingerprint being right is only half of it.
    let calls = 0
    const work = async () => {
      calls += 1
      return `order-${calls}`
    }
    await run('k1', { amount: '100', correlationId: 'req-a' }, work)
    const retry = await run('k1', { amount: '100', correlationId: 'req-b' }, work)
    assert.equal(retry.replayed, true)
    assert.equal(calls, 1)
  })

  test('the same key with a different body is a 409, not a replay', async () => {
    // Returning the first request's answer to a second, different request is worse than an error:
    // the caller believes the thing it asked for happened.
    await run('k1', { amount: '100' }, async () => 'order-1')
    await assert.rejects(
      run('k1', { amount: '999' }, async () => 'order-2'),
      IdempotencyKeyReuseError,
    )
  })

  test('TWO PRINCIPALS, ONE KEY, ONE BODY — two runs and two artefacts', async () => {
    // The same table, the same key, the same fingerprint. Only the caller differs. Before the
    // principal was part of the namespace this was one row, the second caller's work never ran,
    // and they were handed `order-1` — an order belonging to somebody else.
    let calls = 0
    const work = async () => {
      calls += 1
      return `order-${calls}`
    }
    const alice = await run('k1', { amount: '100' }, work, 'user:alice')
    const trade = await run('k1', { amount: '100' }, work, 'service:trade')

    assert.equal(alice.replayed, false)
    assert.equal(trade.replayed, false, "the second caller was replayed the first caller's answer")
    assert.notDeepEqual(trade.result, alice.result)
    assert.equal(calls, 2, "the second caller's work never ran")
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys`
    assert.equal(rows[0]?.n, 2)
  })

  test('THE CLAIM AND THE WORK SHARE ONE TRANSACTION — a failure leaves no key behind', async () => {
    // A design that claims the key in its own transaction and then does the work has a window in
    // which the key exists and the order does not. A retry arriving in that window is answered
    // "already bought" for a purchase that never happened.
    await assert.rejects(
      run('k1', { amount: '100' }, async () => {
        throw new Error('the ledger refused')
      }),
      /the ledger refused/,
    )
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys`
    assert.equal(rows[0]?.n, 0)

    // And so the retry does the work rather than being told it already happened.
    const retry = await run('k1', { amount: '100' }, async () => 'order-1')
    assert.equal(retry.replayed, false)
  })

  test('A CONCURRENT DUPLICATE BLOCKS AND THEN REPLAYS — it never double-runs', async () => {
    // A double-clicked Buy button. The second INSERT waits on the first transaction's uncommitted
    // row; when that commits, the duplicate reads the stored response and replays it.
    let calls = 0
    const work = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return `order-${calls}`
    }
    const [a, b] = await Promise.allSettled([
      run('k1', { amount: '100' }, work),
      run('k1', { amount: '100' }, work),
    ])
    const outcomes = [a, b]
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof run>>> => r.status === 'fulfilled')
      .map((r) => r.value)
    // Either both succeed (one replayed) or one is told "in flight" — never two orders.
    assert.equal(calls, 1, 'the work ran twice for one idempotency key')
    if (outcomes.length === 2) {
      assert.deepEqual(outcomes.map((o) => o.replayed).sort(), [false, true])
    } else {
      const rejected = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult
      assert.ok(rejected.reason instanceof IdempotencyInFlightError)
    }
  })

  test('a claim with no stored response yet is “in flight”, not “done”', async () => {
    // If the original transaction rolled back between the insert and this read, nothing
    // committed, so the honest answer is "retry" rather than a guess.
    await sql`
      insert into idempotency_keys (key, route, request_hash)
      values (${namespacedKey('market', '/v1/listings/:id/buy', BUYER, 'k1')}, '/v1/listings/:id/buy',
              ${requestFingerprint({ amount: '100' })})
    `
    await assert.rejects(
      run('k1', { amount: '100' }, async () => 'order-1'),
      IdempotencyInFlightError,
    )
  })

  test('the claim row points at what the key produced', async () => {
    await run('k1', { amount: '100' }, async () => 'order-42')
    const rows = await sql<{ artefact_id: string }[]>`
      select artefact_id from idempotency_keys
       where key = ${namespacedKey('market', '/v1/listings/:id/buy', BUYER, 'k1')}
    `
    // The only link between a caller's key and the order it made. Losing it turns "did my retry
    // buy this twice" into an unanswerable question.
    assert.equal(rows[0]?.artefact_id, 'order-42')
  })

  test('the reaper keeps any key that produced something, however old', async () => {
    await run('k1', { amount: '100' }, async () => 'order-1')
    await withIdempotency(db, {
      originatingService: 'market',
      route: '/v1/listings',
      principal: BUYER,
      clientKey: 'k2',
      requestHash: 'h2',
      run: async () => ({ response: { ok: true }, artefactId: null }),
    })
    await sql`update idempotency_keys set created_at = now() - interval '90 days'`

    const removed = await reapIdempotencyKeys(db, 30)
    assert.equal(removed, 1)
    const rows = await sql<{ key: string }[]>`select key from idempotency_keys`
    assert.equal(rows.length, 1)
    assert.match(rows[0]?.key ?? '', /k1$/)
  })

  test('the reaper leaves keys inside their TTL alone', async () => {
    await withIdempotency(db, {
      originatingService: 'market',
      route: '/v1/listings',
      principal: BUYER,
      clientKey: 'k2',
      requestHash: 'h2',
      run: async () => ({ response: { ok: true }, artefactId: null }),
    })
    assert.equal(await reapIdempotencyKeys(db, 30), 0)
  })
})
