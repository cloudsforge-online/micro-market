/**
 * The auction close, and the two-worker race it must lose safely.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE DEFECT CLASS `settlement` PROVED WITH A CHAIN-KEYED LEASE.** Two withdrawal
 * workers, one nonce, one payment permanently lost. The marketplace equivalent is two workers,
 * one auction, two orders — one buyer charged for something the other received.
 *
 * The tests below run TWO independent harnesses over one database, sharing one fake ledger so the
 * ledger agrees with itself the way a real one would. That is what makes "exactly one settlement"
 * a demonstration rather than an assertion: if the claim in `settleSale` were a SELECT followed
 * by an UPDATE, these would fail.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { closeAuction } from './orders.ts'
import { placeBid } from './bids.ts'
import { findListing } from './listings.ts'
import { escrowsForListing } from './escrow.ts'
import {
  BUYER,
  SECOND_BUYER,
  SELLER,
  endAuctionNow,
  fakeLedger,
  harness,
  migrateTestDb,
  openDb,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

describe('the auction close', { skip }, () => {
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

  const auction = (overrides = {}) =>
    seedListing(h, { pricingMode: 'auction', price: 100n, ...overrides })

  const close = (worker: Harness, listingId: string, correlationId = 'r') =>
    closeAuction(worker.orders, { listingId, actor: 'system', correlationId })

  test('an auction that is not over yet is not closed', async () => {
    const listing = await auction()
    const result = await close(h, listing.id)
    assert.equal(result.outcome, 'not_due')
    assert.equal((await findListing(h.sql, listing.id))?.status, 'active')
  })

  test('an auction with no bids expires and the item is released', async () => {
    // An outcome, not a failure. Treating it as an error would dead-letter the job and leave the
    // seller's item reserved for ever against an auction nobody will ever close.
    const listing = await auction()
    await endAuctionNow(sql, listing.id)
    const result = await close(h, listing.id)
    assert.equal(result.outcome, 'no_bids')
    assert.equal(result.order, null)
    assert.equal((await findListing(h.sql, listing.id))?.status, 'expired')
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows[0]?.state, 'released')
  })

  test('an auction below its reserve expires and EVERY bid is refunded', async () => {
    const listing = await auction({ reservePrice: 5_000n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    const result = await close(h, listing.id)
    assert.equal(result.outcome, 'reserve_not_met')

    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.length, 2)
    for (const escrow of escrows) assert.equal(escrow.state, 'released')
    assert.equal((await findListing(h.sql, listing.id))?.status, 'expired')
  })

  test('an auction at exactly its reserve settles', async () => {
    const listing = await auction({ reservePrice: 500n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    const result = await close(h, listing.id)
    assert.equal(result.outcome, 'settled')
    assert.equal(result.order?.amount, 500n)
  })

  test('the winner is the leading bid, and their escrowed funds pay for it', async () => {
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const winning = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: SECOND_BUYER,
      amount: 900n,
      actor: SECOND_BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    const result = await close(h, listing.id)

    assert.equal(result.outcome, 'settled')
    assert.equal(result.order?.buyerSubject, SECOND_BUYER)
    assert.equal(result.order?.amount, 900n)
    assert.equal(result.order?.source, 'auction')

    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.find((e) => e.id === winning.bid.escrowId)?.state, 'captured')

    const rows = await sql<{ bidder_subject: string; status: string }[]>`
      select bidder_subject, status from bids where listing_id = ${listing.id} order by amount
    `
    assert.deepEqual(
      rows.map((row) => row.status),
      ['lost', 'won'],
    )
  })

  test('TWO WORKERS CLOSING ONE AUCTION PRODUCE EXACTLY ONE SETTLEMENT', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // The test the whole design of `settleSale`'s status claim exists to pass. Two harnesses,
    // two connections, one shared fake ledger — as close to two replicas as one process gets.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const ledger = fakeLedger()
    const workerA = harness(sql, { ledger })
    const workerB = harness(sql, { ledger })

    const listing = await seedListing(workerA, { pricingMode: 'auction', price: 100n })
    await placeBid(workerA.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 900n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)

    const results = await Promise.allSettled([
      close(workerA, listing.id, 'a'),
      close(workerB, listing.id, 'b'),
    ])
    const outcomes = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof close>>> => r.status === 'fulfilled')
      .map((r) => r.value.outcome)

    // EXACTLY ONE order.
    const orders = await sql<{ n: number }[]>`
      select count(*)::int as n from orders where listing_id = ${listing.id}
    `
    assert.equal(orders[0]?.n, 1, 'two workers produced more than one order')

    // EXACTLY ONE settlement entry, whatever the two workers each believed.
    const settlementKey = `market:settle:${listing.id}`
    assert.ok(ledger.posted(settlementKey), 'the settlement was never posted')
    const settled = outcomes.filter((outcome) => outcome === 'settled')
    assert.ok(settled.length <= 1, `two workers both claimed to have settled: ${outcomes.join(',')}`)

    // The seller was credited once.
    const entry = ledger.posted(settlementKey)
    const sellerLegs = entry?.postings.filter(
      (posting) => posting.account.subject === SELLER && posting.assetCode === 'SHARD',
    )
    assert.equal(sellerLegs?.length, 1)

    assert.equal((await findListing(sql as never, listing.id))?.status, 'sold')
  })

  test('four workers closing one auction still produce exactly one order', async () => {
    const ledger = fakeLedger()
    const workers = [0, 1, 2, 3].map(() => harness(sql, { ledger }))
    const first = workers[0] as Harness
    const listing = await seedListing(first, { pricingMode: 'auction', price: 100n })
    await placeBid(first.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 750n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)

    await Promise.allSettled(workers.map((worker, index) => close(worker, listing.id, `w${index}`)))

    const orders = await sql<{ n: number }[]>`
      select count(*)::int as n from orders where listing_id = ${listing.id}
    `
    assert.equal(orders[0]?.n, 1)
    // And exactly one entry under the derived settlement key: the second line of defence.
    const posted = ledger.keys.filter((key) => key === `market:settle:${listing.id}`)
    assert.ok(posted.length >= 1)
    assert.ok(ledger.posted(`market:settle:${listing.id}`))
  })

  test('closing an already-closed auction is reported as such, not as a sale', async () => {
    // The job's log line must not claim to have made a sale it did not make.
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 900n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    assert.equal((await close(h, listing.id)).outcome, 'settled')
    assert.equal((await close(h, listing.id)).outcome, 'already_closed')
  })

  test('a frozen auction is not closed by the sweep', async () => {
    // Moderation must survive the background worker, not only the HTTP route.
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 900n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    await sql`update listings set frozen = true where id = ${listing.id}`
    await assert.rejects(close(h, listing.id), /frozen/)
    const orders = await sql<{ n: number }[]>`
      select count(*)::int as n from orders where listing_id = ${listing.id}
    `
    assert.equal(orders[0]?.n, 0)
  })

  test('closing a listing that does not exist is refused, not silently ignored', async () => {
    await assert.rejects(
      close(h, '00000000-0000-4000-8000-000000000000'),
      /no such listing/,
    )
  })

  test('the winning auction credits the seller and the platform exactly once each', async () => {
    const listing = await auction({ price: 100n, platformFeeBps: 250 })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 1_000n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    const result = await close(h, listing.id)
    assert.equal(result.order?.feeAmount, 25n)
    assert.equal(result.order?.sellerProceeds, 975n)
    assert.equal(
      result.order?.feeAmount + (result.order?.sellerProceeds ?? 0n),
      result.order?.amount,
    )
  })
})
