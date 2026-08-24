/**
 * AN IDEMPOTENCY KEY BELONGS TO THE CALLER WHO CHOSE IT.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────────
 *
 * `withIdempotentRoute` built its claim as `originatingService: deps.producer` — the constant
 * `SERVICE` from `index.ts`, which names MARKET ITSELF — plus the route and the caller's
 * `Idempotency-Key` header. Nothing in that triple identified the CALLER, and
 * `idempotency_keys.key` is a bare `text` primary key with no actor column beside it
 * (`migrations.ts`). One namespace, every principal in it.
 *
 * The fingerprint did not save it either. It is taken over the request body — the body alone at
 * `POST /v1/listings`, `{ listingId, ...body }` at the four listing-scoped routes — and the
 * authenticated principal is used only INSIDE `run` (`sellerSubject`, `buyerSubject`,
 * `bidderSubject`, `offererSubject`, `raiserSubject`, `openedBy`). It never reached the hash.
 *
 * So two sellers who chose the same key for the same item collided, and `idempotency.ts`
 * handed the second one the FIRST one's stored response with `replayed: true`. The second seller's
 * listing was never created and they were told the id of somebody else's. A client deriving its
 * key from the payload — a common and defensible reading of what an idempotency key is — collides
 * that way deterministically rather than by accident.
 *
 * ── WHY THE NAMESPACE RATHER THAN THE FINGERPRINT ─────────────────────────────────────────────
 *
 * Both close the leak; they are not equivalent, and the difference is what the second caller gets.
 *
 *   * In the FINGERPRINT, the principal makes the collision an ERROR: the key row already exists
 *     with a different hash, so the second caller is refused with `IdempotencyKeyReuseError` —
 *     409, "this key was already used with a different request body", about a body they never
 *     sent. Whoever claims a key first can then deny it to everybody else, and on a marketplace
 *     with caller-chosen keys that is a griefing surface as well as an unexplainable error.
 *   * In the NAMESPACE, the collision cannot happen at all. Each principal has its own key space,
 *     which is what an idempotency key means everywhere it is done properly.
 *
 * There is a second, decisive reason here specifically. The stored key is threaded into `run` and
 * persisted ON the listing, where `listings_idempotency_uniq` (migration 12) makes it unique. Had
 * the principal gone into the fingerprint only, that stored key would still have been the same
 * string for two sellers, and the second seller's INSERT would have died on a 23505 against a row
 * they cannot see. Scoping the namespace fixes both layers with one change, because the layer
 * below is keyed on the very string this changes.
 *
 * ── THE TESTS THAT MATTER ─────────────────────────────────────────────────────────────────────
 *
 * These drive the real `createServer` over a real socket with real Postgres, because the defect
 * was in the WIRING — the principal existed at every call site and simply was not passed — and a
 * unit test of `namespacedKey` cannot see a caller that is never handed to it.
 *
 * The concurrent pair is the important one, and it is the same held-open transaction twice with
 * opposite expectations. The service's own claim transaction is what is held open: the fake ledger
 * is armed to block inside `settleSale`, so the winner's `idempotency_keys` row is INSERTED and
 * UNCOMMITTED for as long as the test wants. Then
 *
 *   * a DIFFERENT principal presenting the same key must not block on it at all, and must finish
 *     while the winner is still gated — against the old code it blocks on the row lock until the
 *     winner commits and is then handed a 409 about somebody else's body;
 *   * the SAME principal presenting the same key must still block on it, be seen blocked in
 *     `pg_blocking_pids`, and replay once the winner commits.
 *
 * Neither can pass by luck, and both were made to fail before they were believed:
 *
 *   * the first fails on a deadline with the blocking pids printed. Against the unscoped key it
 *     did exactly that, naming the statement bob was stuck on — `insert into idempotency_keys …`,
 *     blocked by alice's backend;
 *   * the second fails on the wait. Scoping the claim per ATTEMPT instead of per CALLER — one
 *     character's worth of mutation, `subjectOf(principal)` plus the request id — made it fail
 *     after the full ten seconds having seen nothing block on the claim at all.
 *
 * That second run is also why the wait inspects the blocked STATEMENT rather than merely counting
 * blocked backends. Under the mutation something WAS blocked: `settleSale`'s
 * `update listings … where status = 'active'`, which two purchases of one listing contend for
 * whether or not an idempotency key exists. A test that accepted any blocked backend would have
 * passed that mutation and proved nothing.
 */

import { singleNetworkSql } from './testsupport.ts'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics } from './server.ts'
import {
  ALICE,
  BOB,
  SECOND_BUYER,
  fakeLedger,
  fakeVerifier,
  harness,
  migrateTestDb,
  openDb,
  quietLogger,
  resetMarket,
  seedListing,
  skip,
  type FakeLedger,
  type Harness,
} from './testsupport.ts'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

/** One key, chosen by two different callers. Derived from the payload, as a client legitimately may. */
const SHARED_KEY = 'sha256-ashvale-01-fixed-1000-shard'

/* ------------------------------------------------------------------ the gated ledger */

interface GatedLedger extends FakeLedger {
  /**
   * Block the NEXT `postEntry` until `release()`. Resolves when that call arrives, which is the
   * moment the winner's claim row exists and is uncommitted.
   *
   * Armed explicitly rather than always-on because seeding a listing posts an escrow entry of its
   * own, and a gate that caught it would hold the fixture rather than the request under test.
   */
  arm(): Promise<void>
  release(): void
}

function gatedLedger(): GatedLedger {
  const base = fakeLedger()
  let gate: Promise<void> | null = null
  let arrived: (() => void) | null = null
  let release = (): void => {}

  return {
    get entries() {
      return base.entries
    },
    get keys() {
      return base.keys
    },
    get postedCount() {
      return base.postedCount
    },
    posted: (key) => base.posted(key),
    failNext: (err) => base.failNext(err),
    failAlways: (err) => base.failAlways(err),
    arm() {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return new Promise<void>((resolve) => {
        arrived = resolve
      })
    },
    release() {
      release()
    },
    async postEntry(request) {
      if (gate) {
        const waitFor = gate
        gate = null
        arrived?.()
        await waitFor
      }
      return base.postEntry(request)
    },
  }
}

/* ------------------------------------------------------------------ the real server */

interface Running {
  readonly base: string
  readonly h: Harness
  readonly ledger: GatedLedger
  close(): Promise<void>
}

async function start(sql: postgres.Sql): Promise<Running> {
  const ledger = gatedLedger()
  const h = harness(sql, { ledger })
  const server: Server = createServer({
    lifecycle: new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 }),
    logger: quietLogger(),
    metrics: registerServiceMetrics(new Metrics()),
    verifier: fakeVerifier(),
    sql: singleNetworkSql(h.sql),
    singleNetwork: 'mainnet' as const,
    producer: 'market',
    listings: h.listings,
    orders: h.orders,
    bids: h.bids,
    moderation: h.moderation,
    indexer: h.indexer,
    indexerNetwork: 'testnet',
    policy: h.policy,
    queue: { async enqueue() {} },
    eventSigningSecret: SECRET,
    platformFeeBps: 250,
    maxRoyaltyBps: 1_000,
    disputeWindowMs: 0,
    listingEnabled: true,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    h,
    ledger,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function post(
  run: Running,
  path: string,
  token: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Answer> {
  const res = await fetch(`${run.base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function idOf(answer: Answer, wrapper: string): string {
  const inner = answer.body[wrapper]
  assert.ok(
    inner && typeof inner === 'object',
    `no ${wrapper} in ${JSON.stringify(answer.body)} (status ${answer.status})`,
  )
  const id = (inner as Record<string, unknown>)['id']
  assert.equal(typeof id, 'string', `no ${wrapper}.id in ${JSON.stringify(answer.body)}`)
  return id as string
}

const LISTING_BODY: Record<string, unknown> = {
  assetKind: 'collectible',
  itemUrn: 'cf:mint:token:ashvale-01',
  itemAssetCode: 'TOKEN:cf:mint:token:ashvale-01',
  quantity: '1',
  pricingMode: 'fixed',
  price: '1000',
  assetCode: 'SHARD',
  settlementMode: 'custodial',
  royaltyBps: 0,
}

/**
 * Wait until a backend is blocked ON THE CLAIM ROW, or give up loudly.
 *
 * `pg_blocking_pids` rather than a sleep, for the reason `listingidempotency.test.ts` gives: a
 * sleep long enough to be reliable makes the suite slow, and one short enough to be quick is a
 * race that fails on a loaded machine. This waits on the fact itself.
 *
 * The statement text is checked, and that is not fussiness. `settleSale` claims the LISTING row
 * with an `update … where status = 'active'`, so a second purchase of one listing blocks on that
 * row whether or not the idempotency key is doing anything at all. A test that accepted "somebody
 * is blocked" would therefore go green with the key removed entirely, which is precisely the
 * vacuous pass this file must not have. Requiring `idempotency_keys` in the blocked statement is
 * what makes the observation about the key rather than about the listing.
 */
async function waitUntilBlockedOnTheClaim(sql: postgres.Sql, whatFor: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if ((await blocked(sql)).some((b) => b.query.includes('idempotency_keys'))) return
    if (Date.now() > deadline) {
      assert.fail(
        `${whatFor}: nothing ever blocked on the claim row. The duplicate sailed past the ` +
          "winner's uncommitted key, which means two attempts at one operation are running at " +
          'once and any replay that follows is a coincidence rather than an invariant. Blocked ' +
          `elsewhere: ${JSON.stringify(await blocked(sql))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function blocked(sql: postgres.Sql): Promise<{ pid: number; blocked_by: number[]; query: string }[]> {
  return sql<{ pid: number; blocked_by: number[]; query: string }[]>`
    select a.pid, pg_blocking_pids(a.pid) as blocked_by, a.query
      from pg_stat_activity a
     where a.datname = current_database()
       and cardinality(pg_blocking_pids(a.pid)) > 0
  `
}

describe('an idempotency key is scoped to the caller who chose it', { skip }, () => {
  let sql: postgres.Sql
  let run: Running

  before(async () => {
    sql = openDb(10)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    if (run) await run.close()
    await resetMarket(sql)
    run = await start(sql)
  })
  // Unconditionally, and this is not tidiness. A test that fails while the gate is shut leaves a
  // request parked inside the ledger holding an open transaction, and the next `resetMarket`
  // TRUNCATE would then wait on it forever — turning one red test into a hung suite.
  afterEach(async () => {
    if (run) {
      run.ledger.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })
  after(async () => {
    if (run) await run.close()
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- the reported defect */

  test('TWO SELLERS, ONE KEY, IDENTICAL BODIES — two listings, and each seller gets their own', async () => {
    // The whole defect in six lines. Both sellers list the same item at the same price and both
    // derive their key from the payload, so the keys are equal and the fingerprints are equal.
    const alice = await post(run, '/v1/listings', 'alice', SHARED_KEY, LISTING_BODY)
    const bob = await post(run, '/v1/listings', 'bob', SHARED_KEY, LISTING_BODY)

    assert.equal(alice.status, 201)
    assert.equal(bob.status, 201, `bob was replayed alice's answer: ${JSON.stringify(bob.body)}`)
    assert.equal(bob.body['replayed'], false, "bob's listing was never created")
    assert.notEqual(
      idOf(bob, 'listing'),
      idOf(alice, 'listing'),
      "bob was handed the id of alice's listing — a listing he does not own and cannot cancel",
    )

    const rows = await sql<{ seller_subject: string }[]>`
      select seller_subject from listings order by seller_subject
    `
    assert.deepEqual(
      rows.map((r) => r.seller_subject),
      [`user:${ALICE}`, `user:${BOB}`],
      'one of the two sellers is not on the market at all',
    )
  })

  test('two buyers, one key, identical bodies — two offers, and each buyer escrows their own funds', async () => {
    // The same defect on a route that moves money. Carol lists; alice and bob both offer 900 with
    // the same key. `offers_open_uniq` is per (listing, offerer), so these are two legitimate
    // offers — and the second one being replayed the first's answer means bob believes he has an
    // open offer, has escrowed nothing, and holds an id belonging to alice.
    const listing = await seedListing(run.h, { sellerSubject: SECOND_BUYER })
    const body = { amount: '900' }

    const alice = await post(run, `/v1/listings/${listing.id}/offers`, 'alice', SHARED_KEY, body)
    const bob = await post(run, `/v1/listings/${listing.id}/offers`, 'bob', SHARED_KEY, body)

    assert.equal(alice.status, 201)
    assert.equal(bob.status, 201, `bob was replayed alice's offer: ${JSON.stringify(bob.body)}`)
    assert.notEqual(idOf(bob, 'offer'), idOf(alice, 'offer'))

    const rows = await sql<{ offerer_subject: string; escrow_id: string | null }[]>`
      select offerer_subject, escrow_id from offers order by offerer_subject
    `
    assert.deepEqual(
      rows.map((r) => r.offerer_subject),
      [`user:${ALICE}`, `user:${BOB}`],
    )
    assert.ok(
      rows.every((r) => r.escrow_id !== null),
      'an offer with no escrow behind it is an offer that cannot be accepted',
    )
  })

  test('two operators, one key — two moderation cases, because they are two decisions', async () => {
    // `/v1/moderation/cases` takes `openedBy: operatorIdOf(principal)`, so two operators opening a
    // case on one subject under a shared key are two different acts by two different people. The
    // route runs the same wrapper as the six others; nothing about it is special, which is the
    // point of checking it.
    const body = { subjectKind: 'seller', subjectUrn: `user:${ALICE}`, reason: 'reported twice' }
    const first = await post(run, '/v1/moderation/cases', 'admin', SHARED_KEY, body)
    const second = await post(run, '/v1/moderation/cases', 'admin2', SHARED_KEY, body)

    assert.equal(first.status, 201)
    assert.equal(second.status, 201, `the second operator was replayed the first's case: ${JSON.stringify(second.body)}`)
    assert.notEqual(idOf(second, 'case'), idOf(first, 'case'))
    const opened = await sql<{ opened_by: string }[]>`
      select opened_by from moderation_cases order by opened_by
    `
    assert.deepEqual(
      opened.map((c) => c.opened_by),
      ['ops-1', 'ops-2'],
      "one operator's case was never opened",
    )

    // The same operator again is still a replay — the scoping must not turn one operator's own
    // retry into a second case.
    const again = await post(run, '/v1/moderation/cases', 'admin', SHARED_KEY, body)
    assert.equal(again.status, 200)
    assert.equal(again.body['replayed'], true)
    assert.equal(idOf(again, 'case'), idOf(first, 'case'))
  })

  /* ---------------------------------------------------------------- what must NOT change */

  test('one seller, one key, twice — still exactly one listing, replayed', async () => {
    const first = await post(run, '/v1/listings', 'alice', SHARED_KEY, LISTING_BODY)
    const retry = await post(run, '/v1/listings', 'alice', SHARED_KEY, LISTING_BODY)

    assert.equal(first.status, 201)
    assert.equal(retry.status, 200)
    assert.equal(retry.body['replayed'], true)
    assert.equal(idOf(retry, 'listing'), idOf(first, 'listing'))
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from listings`
    assert.equal(rows[0]?.n, 1, 'the retry wrote a second listing')
  })

  test('one seller, one key, a DIFFERENT body — still a 409, not a replay', async () => {
    // Scoping the namespace must not weaken the reuse check inside it. Returning the first
    // request's answer to a second, different request is worse than an error.
    await post(run, '/v1/listings', 'alice', SHARED_KEY, LISTING_BODY)
    const changed = await post(run, '/v1/listings', 'alice', SHARED_KEY, {
      ...LISTING_BODY,
      price: '9999',
    })
    assert.equal(changed.status, 409)
    assert.equal(
      (changed.body['error'] as Record<string, unknown> | undefined)?.['code'],
      'idempotency_key_reused',
    )
  })

  test('the key a caller stores is theirs — one client key, two rows, one per principal', async () => {
    await post(run, '/v1/listings', 'alice', SHARED_KEY, LISTING_BODY)
    await post(run, '/v1/listings', 'bob', SHARED_KEY, LISTING_BODY)

    const rows = await sql<{ key: string }[]>`select key from idempotency_keys order by key`
    assert.equal(rows.length, 2, 'two callers, one namespace — the defect is still here')
    assert.ok(
      rows.every((r) => r.key.includes(SHARED_KEY)),
      'the client key should still be legible in the stored key, for the operator who has to join it',
    )
    assert.ok(rows.some((r) => r.key.includes(ALICE)), 'no key names alice')
    assert.ok(rows.some((r) => r.key.includes(BOB)), 'no key names bob')

    // And the listing carries the same scoped string, so `listings_idempotency_uniq` is per seller
    // rather than global. This is the second layer the fingerprint alternative would have left
    // broken: one string, two sellers, a 23505 on a row the loser cannot see.
    const listings = await sql<{ idempotency_key: string; seller_subject: string }[]>`
      select idempotency_key, seller_subject from listings order by seller_subject
    `
    assert.equal(listings.length, 2)
    assert.notEqual(listings[0]?.idempotency_key, listings[1]?.idempotency_key)
  })

  /* ---------------------------------------------------------------- concurrency */

  test('A DIFFERENT PRINCIPAL NEVER WAITS ON SOMEBODY ELSE’S CLAIM', async () => {
    // Two listings, two buyers, one key. Alice's purchase is gated INSIDE `settleSale`, which is
    // called from inside `run` — so her `idempotency_keys` row is inserted and uncommitted for the
    // whole of bob's request. Against the unscoped key bob's INSERT waits on that row until alice
    // commits and is then refused with a 409 about a body he never sent. Scoped, he never meets it.
    const l1 = await seedListing(run.h, { sellerSubject: SECOND_BUYER })
    const l2 = await seedListing(run.h, { sellerSubject: SECOND_BUYER, itemUrn: 'cf:mint:token:0193' })

    const arrived = run.ledger.arm()
    const alice = post(run, `/v1/listings/${l1.id}/buy`, 'alice', SHARED_KEY, { amount: '1000' })
    await arrived

    const bob = post(run, `/v1/listings/${l2.id}/buy`, 'bob', SHARED_KEY, { amount: '1000' })
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8_000))
    const outcome = await Promise.race([bob, timeout])
    if (outcome === 'timeout') {
      const waiters = await blocked(sql)
      run.ledger.release()
      await alice.catch(() => undefined)
      assert.fail(
        'bob never finished while alice held her claim open. He is waiting on a row that is not ' +
          `his: ${JSON.stringify(waiters)}`,
      )
    }

    // He finished, and he finished with his OWN order, while alice is still inside the ledger.
    assert.equal(outcome.status, 201, JSON.stringify(outcome.body))
    assert.equal(outcome.body['replayed'], false)

    run.ledger.release()
    const first = await alice
    assert.equal(first.status, 201)
    assert.notEqual(idOf(outcome, 'order'), idOf(first, 'order'))

    const orders = await sql<{ buyer_subject: string; listing_id: string }[]>`
      select buyer_subject, listing_id from orders order by buyer_subject
    `
    assert.deepEqual(
      orders.map((o) => o.buyer_subject),
      [`user:${ALICE}`, `user:${BOB}`],
    )
    assert.equal(orders[0]?.listing_id, l1.id)
    assert.equal(orders[1]?.listing_id, l2.id)
  })

  test('THE SAME PRINCIPAL STILL BLOCKS ON ITS OWN CLAIM, AND THEN REPLAYS', async () => {
    // The mirror image, on the same gate. This is the property the scoping must not cost: a
    // double-clicked Buy button meets an uncommitted claim row, WAITS on it — observed in
    // `pg_blocking_pids`, not inferred from a sleep — and replays the one order that committed.
    const listing = await seedListing(run.h, { sellerSubject: SECOND_BUYER })

    const arrived = run.ledger.arm()
    const first = post(run, `/v1/listings/${listing.id}/buy`, 'alice', SHARED_KEY, { amount: '1000' })
    await arrived

    const second = post(run, `/v1/listings/${listing.id}/buy`, 'alice', SHARED_KEY, { amount: '1000' })
    await waitUntilBlockedOnTheClaim(sql, "alice's own double-click")

    run.ledger.release()
    const [a, b] = await Promise.all([first, second])

    assert.equal(a.status, 201)
    assert.equal(b.status, 200, `the double-click was not replayed: ${JSON.stringify(b.body)}`)
    assert.equal(b.body['replayed'], true)
    assert.equal(idOf(b, 'order'), idOf(a, 'order'))

    const rows = await sql<{ n: number }[]>`select count(*)::int as n from orders`
    assert.equal(rows[0]?.n, 1, 'one item, two clicks, two orders')
    // And nothing is left blocked behind them.
    assert.equal((await blocked(sql)).length, 0)
  })
})
