/**
 * A retried `POST /v1/listings` creates ONE listing, and the schema is what makes that true.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 *
 * `@cloudsforge/http` retries a POST — up to three attempts — as soon as the caller supplies an
 * idempotency key (`runtime/packages/http/src/index.ts`):
 *
 *     const retriable = IDEMPOTENT_METHODS.has(method) || options.idempotencyKey !== undefined
 *
 * That rule infers retry-safety from the CALLER's intent rather than from the SERVER's capability,
 * which the client cannot know. `tessera/src/marketclient.ts` supplies a key, so every
 * `POST /v1/listings` this estate makes is automatically retried on a lost response — and a lost
 * response on a call that actually succeeded is the ordinary case, not an exotic one.
 *
 * `withIdempotentRoute` (`server.ts`) is supposed to absorb that. It does not, quite. Its
 * `run` callback is typed `() => Promise<…>` and DISCARDS the `tx` that `withIdempotency` hands it
 * (`idempotency.ts`), and `createListing(deps.sql, …)` then opens a transaction of its own
 * (`listings.ts`). So the claim and the work commit SEPARATELY, which breaks property 1
 * asserted in `idempotency.ts`. If the connection dies after the inner transaction committed
 * and before the outer one did, the listing is durable and the claim row is not — and the client's
 * automatic retry writes a SECOND listing for one item.
 *
 * ── WHY ONLY LISTINGS ─────────────────────────────────────────────────────────────────────────
 *
 * All seven routes through the wrapper split their transactions the same way, and six of them are
 * harmless, because the artefact each one writes already has a natural unique key that a second
 * attempt collides with:
 *
 *   * `/v1/listings/:id/buy` and `/v1/offers/:id/accept` → `orders_listing_uniq` (migrations.ts)
 *   * `/v1/listings/:id/bids`                            → `bids_leading_uniq`  (migrations.ts)
 *   * `/v1/listings/:id/offers`                          → `offers_open_uniq`   (migrations.ts)
 *   * `/v1/orders/:id/disputes`                          → `disputes_open_uniq` (migrations.ts)
 *   * `/v1/moderation/cases`                     → `moderation_open_freeze_uniq` (migrations.ts)
 *
 * `listings` was the one artefact with no natural key at all, which is exactly why the escape was
 * reachable there and nowhere else. The fix does not restructure the transactions — a claim held
 * open across `settleSale`'s HTTP call to the ledger would be a long transaction waiting on the
 * network — it gives `listings` the natural key its six siblings already had.
 *
 * ── WHERE THE INVARIANT LIVES ─────────────────────────────────────────────────────────────────
 *
 * In `listings_idempotency_uniq` (migrations.ts, migration 12), not in a lookup. The duplicate-key
 * violation is the correctness path; `findListingByIdempotencyKey` is only an optimisation that
 * saves the loser a wasted INSERT. This mirrors what the ledger already does one layer down —
 * `journal_entries_idempotency_key_uniq` beside `idempotency_keys.key`, two independent invariants
 * describing the same thing (`ledger/src/idempotency.ts`) — and what custody's migration 6
 * did for `custody_keys`.
 *
 * The second test below is the one that matters. A naive `Promise.all` of two calls passes
 * VACUOUSLY whenever the scheduler lets the second call's lookup run after the first call's
 * commit: it proves the optimisation works and says nothing about the invariant. So it holds the
 * winning INSERT open in another transaction and waits on `pg_blocking_pids` until the loser is
 * demonstrably blocked ON THE INDEX before letting the winner commit. If the schema is not doing
 * the work, nothing blocks and the test fails on the wait rather than passing by luck.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  createListing,
  findListing,
  listingRoyalties,
  type CreateListingInput,
} from './listings.ts'
import { CREATOR, SELLER, harness, migrateTestDb, openDb, resetMarket, skip, type Harness } from './testsupport.ts'

// Spelled the way `withIdempotentRoute` spells it: service, route, PRINCIPAL, then the client's
// key. The principal is what stops one seller's key resolving to another's listing, and it is part
// of this string rather than beside it — so `listings_idempotency_uniq` is per seller for free.
// See `callerscoping.test.ts`.
const KEY = `market:/v1/listings:${SELLER}|tessera-issue-ashvale-01`

function listingInput(overrides: Partial<CreateListingInput> = {}): CreateListingInput {
  return {
    sellerSubject: SELLER,
    assetKind: 'collectible',
    itemUrn: 'cf:mint:token:ashvale-01',
    quantity: 1n,
    itemAssetCode: 'TOKEN:cf:mint:token:ashvale-01',
    pricingMode: 'fixed',
    price: 1_000n,
    assetCode: 'SHARD',
    settlementMode: 'custodial',
    royaltyBps: 500,
    platformFeeBps: 250,
    disputeWindowMs: 0,
    royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
    maxRoyaltyBps: 1_000,
    actor: SELLER,
    correlationId: 'r',
    ...overrides,
  }
}

async function listingCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from listings`
  return rows[0]?.n ?? 0
}

/**
 * Wait until some backend in THIS database is blocked by another, or give up loudly.
 *
 * `pg_blocking_pids` rather than a sleep: a sleep long enough to be reliable is a sleep that makes
 * the suite slow, and a sleep short enough to be quick is a race that fails on a loaded machine.
 * This waits on the fact itself.
 */
async function waitUntilBlocked(sql: postgres.Sql, whatFor: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n
        from pg_stat_activity a
       where a.datname = current_database()
         and cardinality(pg_blocking_pids(a.pid)) > 0
    `
    if ((rows[0]?.n ?? 0) > 0) return
    if (Date.now() > deadline) {
      assert.fail(
        `${whatFor}: nothing ever blocked. The loser's INSERT sailed past the winner's ` +
          'uncommitted row, which means no unique index is enforcing the key and the duplicate ' +
          'is being prevented — if at all — by a lookup that a race defeats.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('a retried listing creation', { skip }, () => {
  let sql: postgres.Sql
  let h: Harness

  before(async () => {
    sql = openDb(8)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
    h = harness(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  test('the same idempotency key twice is ONE listing, replayed', async () => {
    const first = await createListing(h.sql, 'market', listingInput({ idempotencyKey: KEY }))
    // The retry the HTTP client makes on its own when the first response is lost. The claim row in
    // `idempotency_keys` is deliberately NOT consulted here: this is the case where the claim
    // transaction never committed, so there is nothing to replay from and the schema is the only
    // thing standing between one listing and two.
    const second = await createListing(h.sql, 'market', listingInput({ idempotencyKey: KEY }))

    assert.equal(second.id, first.id, 'the retry got a different listing — the item is listed twice')
    assert.equal(await listingCount(sql), 1)
    // The replay is the real row, not a husk, and the retry did not write a second royalty split
    // onto it either — `listing_royalties` has no unique constraint of its own, so a second pass
    // through the insert loop would have doubled the recipient rows even if the listing were one.
    const stored = await findListing(sql, first.id)
    assert.equal(stored?.sellerSubject, SELLER)
    assert.deepEqual(await listingRoyalties(sql, first.id), [{ subject: CREATOR, bps: 10_000 }])
  })

  test('two listings with NO key are two listings, as they must be', async () => {
    // The `treasury` lesson from custody's migration 6: before making two requests one, check the
    // case where they are MEANT to be distinct. A seller may list the same item twice — a second
    // copy, a relist after a cancel — and does so with a fresh key or none at all. The index is
    // partial on `idempotency_key is not null` precisely so that neither becomes a collision, and
    // so that the rows already in the table when migration 12 runs are not retroactively
    // constrained against each other.
    const a = await createListing(h.sql, 'market', listingInput())
    const b = await createListing(h.sql, 'market', listingInput())
    assert.notEqual(a.id, b.id)
    assert.equal(await listingCount(sql), 2)

    const c = await createListing(h.sql, 'market', listingInput({ idempotencyKey: `${KEY}:relist` }))
    assert.notEqual(c.id, a.id)
    assert.equal(await listingCount(sql), 3)
  })

  test('A CONCURRENT DOUBLE-SUBMIT BLOCKS ON THE INDEX AND THEN REPLAYS — it never writes two', async () => {
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })

    // The winner, held open. Written with raw SQL rather than `createListing` so the transaction
    // can be kept uncommitted for as long as the test needs — which is the whole point: the loser
    // must be made to meet an insert that has NOT committed yet, because that is the only ordering
    // in which a check-then-act has already read "nothing there" and is about to write the second
    // row.
    let winnerId = ''
    const winner = sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into listings (
          seller_subject, asset_kind, item_urn, quantity, item_asset_code, pricing_mode,
          price, asset_code, settlement_mode, royalty_bps, platform_fee_bps, dispute_window_ms,
          idempotency_key
        ) values (
          ${SELLER}, 'collectible', 'cf:mint:token:ashvale-01', '1',
          'TOKEN:cf:mint:token:ashvale-01', 'fixed', '1000', 'SHARD', 'custodial', 0, 250, '0',
          ${KEY}
        )
        returning id
      `
      winnerId = rows[0]!.id
      await gate
      return { v: winnerId }
    })

    // The loser: the client's automatic second attempt, arriving while the first is still in
    // flight. It must not return until the winner commits.
    const loser = createListing(h.sql, 'market', listingInput({ idempotencyKey: KEY }))

    await waitUntilBlocked(sql, 'the concurrent duplicate listing')
    released()

    const [, replayed] = await Promise.all([winner, loser])

    assert.equal(replayed.id, winnerId, 'the loser wrote its own listing instead of finding the winner')
    assert.equal(await listingCount(sql), 1, 'one item, two requests, two listings')
  })
})
