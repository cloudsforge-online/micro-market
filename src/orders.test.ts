/**
 * Settlement: the sale itself, the money it moves, and the guarantee that it happens once.
 *
 * The assertions in this file are mostly about POSTINGS rather than about return values. An order
 * row that says the right thing while the ledger was told something else is the failure mode this
 * whole service exists to prevent, and the only way to catch it is to read what the ledger was
 * actually asked for.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  OrderError,
  findOrder,
  listOrders,
  orderRoyalties,
  releaseProceeds,
  settleSale,
  duePayouts,
} from './orders.ts'
import { ListingStateError, findListing } from './listings.ts'
import { escrowsForListing, releaseEscrow } from './escrow.ts'
import { makeOffer, placeBid } from './bids.ts'
import { LedgerRefusedError } from './ledgerclient.ts'
import { splitSale } from './money.ts'
import {
  BUYER,
  CREATOR,
  SECOND_BUYER,
  SELLER,
  assertBalanced,
  harness,
  migrateTestDb,
  openDb,
  payoutDueNow,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

describe('settlement', { skip }, () => {
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

  const buy = (listingId: string, amount = 1_000n, buyer = BUYER, correlationId = 'r') =>
    settleSale(h.orders, {
      listingId,
      buyerSubject: buyer,
      amount,
      source: 'purchase',
      actor: buyer as `user:${string}`,
      correlationId,
    })

  /* ---------------------------------------------------------------- the sale */

  test('A SALE IS ONE BALANCED LEDGER ENTRY', async () => {
    // Two entries would admit a state where the sale committed and the royalty did not — a
    // creator unpaid for a sale that definitely happened, discoverable only in aggregate.
    const listing = await seedListing(h, {
      price: 1_000n,
      royaltyBps: 500,
      royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
    })
    const result = await buy(listing.id)

    const entry = h.ledger.posted(`market:settle:${listing.id}`)
    assert.ok(entry, 'no settlement entry was posted')
    assert.equal(entry.kind, 'market_settled')
    assertBalanced(entry.postings)

    const legs = entry.postings.map((p) => [
      p.direction,
      p.amount.toString(),
      p.assetCode,
      p.account.subject,
      p.account.purpose,
    ])
    assert.deepEqual(legs, [
      // The buyer pays from RESERVED, not available: their funds were escrowed a moment earlier
      // in this same transaction. Debiting available would be a second charge.
      ['debit', '1000', 'SHARD', BUYER, 'reserved'],
      ['credit', '925', 'SHARD', SELLER, 'available'],
      ['credit', '25', 'SHARD', 'platform', 'fees'],
      ['credit', '50', 'SHARD', CREATOR, 'available'],
      ['debit', '1', 'TOKEN:cf:mint:token:0192', SELLER, 'reserved'],
      ['credit', '1', 'TOKEN:cf:mint:token:0192', BUYER, 'available'],
    ])
    assert.equal(result.order.sellerProceeds, 925n)
  })

  test('the order row partitions its own price, and Postgres checked it', async () => {
    const listing = await seedListing(h, {
      price: 1_001n,
      royaltyBps: 750,
      royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
    })
    const result = await buy(listing.id, 1_001n)
    const order = result.order
    assert.equal(order.feeAmount + order.royaltyAmount + order.sellerProceeds, order.amount)
    assert.equal(order.feeAmount, 25n)
    assert.equal(order.royaltyAmount, 75n)
    assert.equal(order.sellerProceeds, 901n)
  })

  test('THE ROYALTY SPLIT SUMS EXACTLY TO THE ROYALTY, WITH NO ROUNDING LEAK', async () => {
    // Three recipients at 3333/3333/3334 of a royalty that does not divide. Flooring each share
    // independently would lose two units and the ledger would refuse the entry.
    const listing = await seedListing(h, {
      price: 1_003n,
      royaltyBps: 1_000,
      royaltyRecipients: [
        { subject: 'user:a', bps: 3_333 },
        { subject: 'user:b', bps: 3_333 },
        { subject: 'user:c', bps: 3_334 },
      ],
    })
    const result = await buy(listing.id, 1_003n)
    const paid = await orderRoyalties(h.sql, result.order.id)
    const total = paid.reduce((acc, share) => acc + share.amount, 0n)
    assert.equal(total, result.order.royaltyAmount)
    assert.equal(
      result.order.feeAmount + result.order.royaltyAmount + result.order.sellerProceeds,
      1_003n,
    )
    assertBalanced(h.ledger.posted(`market:settle:${listing.id}`)?.postings ?? [])
  })

  test('the royalty each recipient was actually paid is recorded, not merely the rate', async () => {
    // Once largest-remainder has handed somebody a dust unit, "the split said 60/40, what did
    // they get" cannot be answered from the rates alone.
    const listing = await seedListing(h, {
      price: 999n,
      royaltyBps: 1_000,
      royaltyRecipients: [
        { subject: 'user:a', bps: 6_000 },
        { subject: 'user:b', bps: 4_000 },
      ],
    })
    const result = await buy(listing.id, 999n)
    const paid = await orderRoyalties(h.sql, result.order.id)
    assert.equal(paid.length, 2)
    assert.equal(
      paid.reduce((acc, share) => acc + share.amount, 0n),
      result.order.royaltyAmount,
    )
  })

  test('a sale with no royalty posts no royalty legs at all', async () => {
    const listing = await seedListing(h, { price: 1_000n })
    await buy(listing.id)
    const entry = h.ledger.posted(`market:settle:${listing.id}`)
    // A zero-amount posting is not an error but the ledger has no use for it, and it makes an
    // entry harder to read.
    assert.ok(entry?.postings.every((p) => p.amount > 0n))
    assert.equal(entry?.postings.length, 5)
  })

  test('a zero platform fee leaves the seller everything', async () => {
    const listing = await seedListing(h, { price: 1_000n, platformFeeBps: 0 })
    const result = await buy(listing.id)
    assert.equal(result.order.feeAmount, 0n)
    assert.equal(result.order.sellerProceeds, 1_000n)
  })

  test('the buyer pays exactly what the listing says — no more, no less', async () => {
    // Accepting an overpayment silently would take money nobody asked for, and the ledger would
    // balance perfectly while doing it.
    const listing = await seedListing(h, { price: 1_000n })
    await assert.rejects(buy(listing.id, 1_500n), OrderError)
    await assert.rejects(buy(listing.id, 999n), OrderError)
    const after = await findListing(h.sql, listing.id)
    assert.equal(after?.status, 'active')
  })

  test('a seller may not buy their own listing', async () => {
    const listing = await seedListing(h)
    await assert.rejects(buy(listing.id, 1_000n, SELLER), /may not buy their own listing/)
  })

  test('a buyer who cannot pay leaves the listing on sale', async () => {
    const listing = await seedListing(h)
    h.ledger.failNext(new LedgerRefusedError(402, 'insufficient_balance', 'not enough'))
    await assert.rejects(buy(listing.id), LedgerRefusedError)
    const after = await findListing(h.sql, listing.id)
    assert.equal(after?.status, 'active')
    assert.equal(await findOrder(h.sql, 'ignored').catch(() => null), null)
    const orders = await listOrders(h.sql, {})
    assert.equal(orders.length, 0)
  })

  /* ---------------------------------------------------------------- once, and only once */

  test('ONE LISTING SELLS ONCE — the second buyer gets the order that exists', async () => {
    const listing = await seedListing(h)
    const first = await buy(listing.id)
    const second = await buy(listing.id, 1_000n, SECOND_BUYER)
    // Not a 409. The client is retrying after a lost response, and telling it "conflict" would
    // make it retry harder or tell a customer their purchase failed when it succeeded.
    assert.equal(second.replayed, true)
    assert.equal(second.order.id, first.order.id)
    assert.equal(second.order.buyerSubject, BUYER)
    // Three entries and no more: the item reservation at activation, the buyer's funds
    // reservation, and the settlement. The second purchase posted NOTHING — it replayed.
    assert.equal(h.ledger.postedCount, 3)
  })

  test('TWO SIMULTANEOUS PURCHASES PRODUCE EXACTLY ONE ORDER AND ONE POSTED ENTRY', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // The status claim — `update … where status = 'active'` — is what makes this true. The first
    // transaction takes the row lock; the second blocks, re-evaluates the predicate against the
    // committed version, and finds nothing to claim.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const listing = await seedListing(h)
    const results = await Promise.allSettled([
      buy(listing.id, 1_000n, BUYER, 'a'),
      buy(listing.id, 1_000n, SECOND_BUYER, 'b'),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    // Both may succeed — one settles and one replays — but there is only ever one ORDER.
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from orders where listing_id = ${listing.id}
    `
    assert.equal(rows[0]?.n, 1)
    assert.equal(h.ledger.posted(`market:settle:${listing.id}`) !== undefined, true)
    const settlementPosts = h.ledger.keys.filter((key) => key === `market:settle:${listing.id}`)
    assert.ok(settlementPosts.length >= 1)
    // Whatever the interleaving, exactly one real entry exists under the settlement key.
    const orders = await listOrders(h.sql, {})
    assert.equal(orders.length, 1)
    assert.ok(fulfilled.length >= 1)
  })

  test('a settlement that is claimed but not yet written answers “retry”, not “no order”', async () => {
    // A client told "no order exists" for a purchase that is committing right now would report a
    // failure to the customer. The honest answer is "ask again".
    const listing = await seedListing(h)
    await sql`update listings set status = 'settling' where id = ${listing.id}`
    await assert.rejects(buy(listing.id), /being settled; retry shortly/)
  })

  test('the item escrow and the funds escrow are both captured, never released', async () => {
    // `captured` says the value was SPENT by the settlement entry, not returned to its owner.
    // Releasing either would refund a completed sale.
    const listing = await seedListing(h)
    const result = await buy(listing.id)
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.length, 2)
    for (const escrow of escrows) {
      assert.equal(escrow.state, 'captured')
      assert.equal(escrow.settleEntryId, result.order.journalEntryId)
      assert.equal(escrow.orderId, result.order.id)
    }
  })

  test('a captured escrow cannot be released afterwards', async () => {
    const listing = await seedListing(h)
    await buy(listing.id)
    const escrow = (await escrowsForListing(h.sql, listing.id))[0]
    const posted = h.ledger.postedCount
    const outcome = await sql.begin(async (tx) => {
      const result = await releaseEscrow(
        tx as never,
        { ledger: h.ledger, actor: 'system', correlationId: 'r' },
        escrow?.id as string,
      )
      return { value: result }
    })
    assert.equal(outcome.value.status, 'already')
    assert.equal(h.ledger.postedCount, posted, 'a captured escrow must not be refunded')
  })

  test('ESCROW IS RELEASED EXACTLY ONCE UNDER TWO CONCURRENT RELEASERS', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // Three independent defences: the row lock, the derived key `market:release:<escrowId>`, and
    // `escrows_settled_names_entry`. A double release refunds a bidder twice — real money,
    // created out of nothing, invisible until the trial balance goes non-zero.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    const bid = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const escrowId = bid.bid.escrowId as string
    const before = h.ledger.postedCount

    const release = () =>
      sql.begin(async (tx) => ({
        value: await releaseEscrow(
          tx as never,
          { ledger: h.ledger, actor: 'system', correlationId: 'r' },
          escrowId,
        ),
      }))
    const [a, b] = await Promise.all([release(), release()])

    const outcomes = [a.value.status, b.value.status].sort()
    assert.deepEqual(outcomes, ['already', 'released'])
    // Exactly one new ledger entry, not two.
    assert.equal(h.ledger.postedCount, before + 1)
    const escrows = await escrowsForListing(h.sql, listing.id)
    const funds = escrows.find((escrow) => escrow.id === escrowId)
    assert.equal(funds?.state, 'released')
  })

  test('releasing an escrow that does not exist is “missing”, not a crash', async () => {
    const outcome = await sql.begin(async (tx) => ({
      value: await releaseEscrow(
        tx as never,
        { ledger: h.ledger, actor: 'system', correlationId: 'r' },
        '00000000-0000-4000-8000-000000000000',
      ),
    }))
    assert.equal(outcome.value.status, 'missing')
  })

  /* ---------------------------------------------------------------- losers are refunded */

  test('every losing bid is refunded by the settlement itself', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    const first = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const second = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: SECOND_BUYER,
      amount: 600n,
      actor: SECOND_BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await settleSale(h.orders, {
      listingId: listing.id,
      buyerSubject: SECOND_BUYER,
      amount: 600n,
      source: 'auction',
      fundsEscrowId: second.bid.escrowId,
      actor: 'system',
      correlationId: 'r',
    })
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.find((e) => e.bidId === first.bid.id)?.state, 'released')
    assert.equal(escrows.find((e) => e.bidId === second.bid.id)?.state, 'captured')
  })

  test('an open offer that was not accepted is declined and refunded', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: SECOND_BUYER,
      amount: 800n,
      actor: SECOND_BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await buy(listing.id)
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.find((e) => e.offerId === offer.id)?.state, 'released')
    const rows = await sql<{ status: string }[]>`select status from offers where id = ${offer.id}`
    assert.equal(rows[0]?.status, 'declined')
  })

  test('accepting an offer settles at the OFFER’s amount, not the listing’s price', async () => {
    const listing = await seedListing(h, { price: 1_000n })
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const result = await settleSale(h.orders, {
      listingId: listing.id,
      buyerSubject: BUYER,
      amount: 800n,
      source: 'offer',
      fundsEscrowId: offer.escrowId,
      offerId: offer.id,
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(result.order.amount, 800n)
    assert.equal(result.order.source, 'offer')
    const rows = await sql<{ status: string }[]>`select status from offers where id = ${offer.id}`
    assert.equal(rows[0]?.status, 'accepted')
  })

  test('a settlement whose escrowed amount disagrees with the price is refused', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await assert.rejects(
      settleSale(h.orders, {
        listingId: listing.id,
        buyerSubject: BUYER,
        amount: 900n,
        source: 'offer',
        fundsEscrowId: offer.escrowId,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      /does not match the settlement amount/,
    )
  })

  /* ---------------------------------------------------------------- the event */

  test('market.listing.sold is written in the same transaction as the order', async () => {
    // worlds, billing, ledger, activity, notify and analytics all read this one. A publish after
    // the commit is a publish that is skipped when the process dies in between.
    const listing = await seedListing(h, {
      royaltyBps: 500,
      royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
    })
    const result = await buy(listing.id)
    const rows = await sql<{ topic: string; key: string; payload: Record<string, unknown> }[]>`
      select topic, key, payload from outbox where topic = 'market.listing.sold'
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.key, listing.id)
    const payload = rows[0]?.payload as Record<string, unknown>
    assert.equal(payload['orderId'], result.order.id)
    // Amounts on the wire are strings, every one of them.
    assert.equal(payload['amount'], '1000')
    assert.equal(payload['sellerProceeds'], '925')
    assert.deepEqual(payload['royalties'], [{ subject: CREATOR, amount: '50' }])
  })

  /* ---------------------------------------------------------------- the dispute window */

  test('with a dispute window, proceeds land in payout_due rather than available', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await buy(listing.id)
    assert.equal(result.order.proceedsState, 'held')
    assert.ok(result.order.payoutDueAt)

    const entry = h.ledger.posted(`market:settle:${listing.id}`)
    const sellerLeg = entry?.postings.find(
      (p) => p.account.subject === SELLER && p.assetCode === 'SHARD',
    )
    // Money that is theirs and not yet spendable — which is exactly what a separate account
    // purpose is for.
    assert.equal(sellerLeg?.account.purpose, 'payout_due')
  })

  test('without a dispute window, proceeds are spendable immediately', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 0 })
    const result = await buy(listing.id)
    assert.equal(result.order.proceedsState, 'released')
    assert.equal(result.order.payoutDueAt, null)
  })

  test('the payout moves payout_due to available, and only when it is due', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await buy(listing.id)

    const early = await releaseProceeds(h.orders, {
      orderId: result.order.id,
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(early.outcome, 'not_due')

    await payoutDueNow(sql, result.order.id)
    const paid = await releaseProceeds(h.orders, {
      orderId: result.order.id,
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(paid.outcome, 'paid')
    assert.equal(paid.order?.proceedsState, 'released')

    const escrow = (await escrowsForListing(h.sql, listing.id)).find((e) => e.kind === 'proceeds')
    const entry = h.ledger.posted(`market:release:${escrow?.id}`)
    // payout_due → available, NOT reserved → available. The proceeds were never reserved, and
    // debiting an empty `reserved` account would be refused by the ledger.
    assert.deepEqual(
      entry?.postings.map((p) => [p.direction, p.account.purpose]),
      [
        ['debit', 'payout_due'],
        ['credit', 'available'],
      ],
    )
  })

  test('THE PAYOUT HAPPENS EXACTLY ONCE UNDER TWO CONCURRENT WORKERS', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await buy(listing.id)
    await payoutDueNow(sql, result.order.id)
    const before = h.ledger.postedCount

    const [a, b] = await Promise.all([
      releaseProceeds(h.orders, { orderId: result.order.id, actor: 'system', correlationId: 'a' }),
      releaseProceeds(h.orders, { orderId: result.order.id, actor: 'system', correlationId: 'b' }),
    ])
    assert.deepEqual([a.outcome, b.outcome].sort(), ['already_paid', 'paid'])
    assert.equal(h.ledger.postedCount, before + 1)
  })

  test('duePayouts finds only orders past their window', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await buy(listing.id)
    assert.deepEqual([...(await duePayouts(h.sql, 10))], [])
    await payoutDueNow(sql, result.order.id)
    assert.deepEqual([...(await duePayouts(h.sql, 10))], [result.order.id])
  })

  test('the payout emits market.order.paid_out', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await buy(listing.id)
    await payoutDueNow(sql, result.order.id)
    await releaseProceeds(h.orders, { orderId: result.order.id, actor: 'system', correlationId: 'r' })
    const rows = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox where topic = 'market.order.paid_out'
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.payload['amount'], '975')
  })

  test('paying out an order that does not exist is “missing”, not a crash', async () => {
    const result = await releaseProceeds(h.orders, {
      orderId: '00000000-0000-4000-8000-000000000000',
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(result.outcome, 'missing')
  })

  /* ---------------------------------------------------------------- on-chain */

  test('an on-chain sale names its transaction and posts nothing to the ledger', async () => {
    // AD-14: the buyer paid the seller's own wallet and the platform was never a party.
    const listing = await seedListing(h, { settlementMode: 'onchain', activate: false })
    const { activateListing } = await import('./listings.ts')
    await activateListing(h.listings, {
      listingId: listing.id,
      sellerSubject: SELLER,
      onchainEscrowTx: '0xescrow',
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    const result = await settleSale(h.orders, {
      listingId: listing.id,
      buyerSubject: BUYER,
      amount: 1_000n,
      source: 'purchase',
      onchainTransactionId: '0xsettlement',
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(result.order.journalEntryId, null)
    assert.equal(result.order.outboundTransactionId, '0xsettlement')
    assert.equal(result.order.proceedsState, 'released')
    assert.equal(h.ledger.postedCount, 0)
  })

  test('an on-chain sale with no transaction id is refused', async () => {
    const listing = await seedListing(h, { settlementMode: 'onchain', activate: false })
    const { activateListing } = await import('./listings.ts')
    await activateListing(h.listings, {
      listingId: listing.id,
      sellerSubject: SELLER,
      onchainEscrowTx: '0xescrow',
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    await assert.rejects(
      settleSale(h.orders, {
        listingId: listing.id,
        buyerSubject: BUYER,
        amount: 1_000n,
        source: 'purchase',
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      /must name the confirmed transaction/,
    )
  })

  /* ---------------------------------------------------------------- state guards */

  test('a cancelled listing cannot be bought', async () => {
    const { cancelListing } = await import('./listings.ts')
    const listing = await seedListing(h)
    await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'gone',
      actor: 'system',
      correlationId: 'r',
    })
    await assert.rejects(buy(listing.id), ListingStateError)
  })

  test('a draft cannot be bought — it holds nothing', async () => {
    const listing = await seedListing(h, { activate: false })
    await assert.rejects(buy(listing.id), ListingStateError)
  })

  test('an auction cannot be bought outright', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await assert.rejects(buy(listing.id, 100n), /not sold at a fixed price/)
  })

  test('the split stored on a replayed order describes the sale that happened', async () => {
    // Read from the order's own columns rather than recomputed from the rates: the stored amounts
    // are what actually moved.
    const listing = await seedListing(h, {
      price: 1_003n,
      royaltyBps: 1_000,
      royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
    })
    const first = await buy(listing.id, 1_003n)
    const replay = await buy(listing.id, 1_003n, SECOND_BUYER)
    assert.equal(replay.replayed, true)
    assert.deepEqual(
      {
        price: replay.split.price,
        fee: replay.split.platformFee,
        royalty: replay.split.royaltyTotal,
        proceeds: replay.split.sellerProceeds,
      },
      {
        price: first.order.amount,
        fee: first.order.feeAmount,
        royalty: first.order.royaltyAmount,
        proceeds: first.order.sellerProceeds,
      },
    )
    // And it still partitions.
    assert.equal(
      replay.split.platformFee + replay.split.royaltyTotal + replay.split.sellerProceeds,
      replay.split.price,
    )
  })

  test('the arithmetic the order stores is the arithmetic money.ts computes', async () => {
    const listing = await seedListing(h, {
      price: 7_777n,
      royaltyBps: 999,
      royaltyRecipients: [
        { subject: 'user:a', bps: 1_234 },
        { subject: 'user:b', bps: 8_766 },
      ],
    })
    const result = await buy(listing.id, 7_777n)
    const expected = splitSale({
      price: 7_777n,
      platformFeeBps: 250,
      royaltyBps: 999,
      royaltyRecipients: [
        { subject: 'user:a', bps: 1_234 },
        { subject: 'user:b', bps: 8_766 },
      ],
    })
    assert.equal(result.order.feeAmount, expected.platformFee)
    assert.equal(result.order.royaltyAmount, expected.royaltyTotal)
    assert.equal(result.order.sellerProceeds, expected.sellerProceeds)
  })
})
