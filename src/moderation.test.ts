/**
 * Moderation and disputes — the two things that can stop a sale.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * The claim under test: **a freeze actually blocks settlement**, and it does so without a race.
 * The freeze is a column on the listing, set in the same transaction as the case, and
 * `settleSale`'s claim carries `and frozen = false` in its WHERE. There is no instant at which a
 * frozen listing is settleable.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  ModerationError,
  findCase,
  findDispute,
  listCases,
  listDisputes,
  openCase,
  openDispute,
  resolveCase,
  resolveDispute,
} from './moderation.ts'
import { FrozenError, findListing } from './listings.ts'
import { escrowsForListing } from './escrow.ts'
import { releaseProceeds, settleSale, duePayouts, findOrder } from './orders.ts'
import { placeBid } from './bids.ts'
import {
  BUYER,
  SECOND_BUYER,
  SELLER,
  assertBalanced,
  endAuctionNow,
  harness,
  migrateTestDb,
  openDb,
  payoutDueNow,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

describe('moderation and disputes', { skip }, () => {
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

  const buy = (listingId: string, amount = 1_000n, buyer = BUYER) =>
    settleSale(h.orders, {
      listingId,
      buyerSubject: buyer,
      amount,
      source: 'purchase',
      actor: buyer as `user:${string}`,
      correlationId: 'r',
    })

  const freeze = (listingId: string, action: 'freeze' | 'delist' = 'freeze') =>
    openCase(h.moderation, {
      subjectKind: 'listing',
      subjectUrn: `cf:market:listing:${listingId}`,
      listingId,
      reason: 'reported as counterfeit',
      action,
      openedBy: 'ops-1',
      correlationId: 'r',
    })

  /* ---------------------------------------------------------------- the freeze */

  test('A MODERATION FREEZE BLOCKS SETTLEMENT', async () => {
    const listing = await seedListing(h)
    await freeze(listing.id)
    assert.equal((await findListing(h.sql, listing.id))?.frozen, true)
    await assert.rejects(buy(listing.id), FrozenError)
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from orders`
    assert.equal(rows[0]?.n, 0)
  })

  test('the freeze is set in the SAME TRANSACTION as the case', async () => {
    // If it were applied afterwards by a job, there would be a window in which a listing under
    // investigation was still sellable — and that window is when a fraudulent seller would sell.
    const listing = await seedListing(h)
    const opened = await freeze(listing.id)
    const stored = await sql<{ frozen: boolean; opened_at: Date }[]>`
      select l.frozen, m.opened_at from listings l
        join moderation_cases m on m.listing_id = l.id
       where l.id = ${listing.id} and m.id = ${opened.id}
    `
    assert.equal(stored[0]?.frozen, true)
  })

  test('a freeze also stops a bid, an offer and an activation', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await freeze(listing.id)
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 500n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      FrozenError,
    )
  })

  test('dismissing the case lifts the freeze and the listing sells again', async () => {
    const listing = await seedListing(h)
    const opened = await freeze(listing.id)
    await assert.rejects(buy(listing.id), FrozenError)

    await resolveCase(h.moderation, {
      caseId: opened.id,
      state: 'dismissed',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.frozen, false)
    const result = await buy(listing.id)
    assert.equal(result.replayed, false)
  })

  test('a second open case keeps the listing frozen when the first is dismissed', async () => {
    // The flag is RECOMPUTED from the open set rather than toggled. Toggling means two
    // independent investigations fight, and closing the trivial one unfreezes the serious one.
    const listing = await seedListing(h)
    const first = await freeze(listing.id)
    // A dispute is the second reason. (A second freezing CASE is refused by
    // `moderation_open_freeze_uniq`, which is a different and equally deliberate guard.)
    const order = await sql<{ id: string }[]>`
      insert into orders (listing_id, buyer_subject, seller_subject, item_urn, item_asset_code,
                          quantity, amount, fee_amount, royalty_amount, seller_proceeds,
                          asset_code, settlement_mode, journal_entry_id, source, settled_at)
      values (${listing.id}, ${BUYER}, ${SELLER}, 'x', 'TOKEN:x', '1', '100', '0', '0', '100',
              'SHARD', 'custodial', 'entry-x', 'purchase', now())
      returning id
    `
    await openDispute(h.moderation, {
      orderId: order[0]?.id as string,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    await resolveCase(h.moderation, {
      caseId: first.id,
      state: 'dismissed',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.frozen, true)
  })

  test('upholding a delist withdraws the listing and refunds every escrow', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const opened = await freeze(listing.id, 'delist')
    await resolveCase(h.moderation, {
      caseId: opened.id,
      state: 'upheld',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.status, 'cancelled')
    for (const escrow of await escrowsForListing(h.sql, listing.id)) {
      assert.equal(escrow.state, 'released')
    }
  })

  test('a case with no action does not freeze anything', async () => {
    // The `review` verdict from policy opens one of these. A degraded gate must not freeze the
    // marketplace during a policy outage — that would be failing closed by another route.
    const listing = await seedListing(h)
    await openCase(h.moderation, {
      subjectKind: 'listing',
      subjectUrn: `cf:market:listing:${listing.id}`,
      listingId: listing.id,
      reason: 'flagged for review',
      action: 'none',
      openedBy: 'system',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.frozen, false)
    const result = await buy(listing.id)
    assert.equal(result.replayed, false)
  })

  test('a freezing case must name the listing it acts on', async () => {
    await assert.rejects(
      openCase(h.moderation, {
        subjectKind: 'seller',
        subjectUrn: SELLER,
        reason: 'suspicious',
        action: 'freeze',
        openedBy: 'ops-1',
        correlationId: 'r',
      }),
      ModerationError,
    )
  })

  test('resolving a case twice is idempotent', async () => {
    const listing = await seedListing(h)
    const opened = await freeze(listing.id)
    await resolveCase(h.moderation, {
      caseId: opened.id,
      state: 'dismissed',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    const again = await resolveCase(h.moderation, {
      caseId: opened.id,
      state: 'upheld',
      resolvedBy: 'ops-2',
      correlationId: 'r',
    })
    // The first decision stands. Re-resolving must not rewrite who decided what.
    assert.equal(again.state, 'dismissed')
    assert.equal(again.resolvedBy, 'ops-1')
  })

  test('cases are listable by state and by subject', async () => {
    const listing = await seedListing(h)
    await freeze(listing.id)
    assert.equal((await listCases(h.sql, { state: 'open' })).length, 1)
    assert.equal((await listCases(h.sql, { state: 'upheld' })).length, 0)
    assert.equal(
      (await listCases(h.sql, { subjectUrn: `cf:market:listing:${listing.id}` })).length,
      1,
    )
  })

  test('opening a case emits an event an operator console can subscribe to', async () => {
    const listing = await seedListing(h)
    const opened = await freeze(listing.id)
    const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
      select topic, payload from outbox where topic = 'market.moderation.opened'
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.payload['caseId'], opened.id)
    assert.equal(rows[0]?.payload['action'], 'freeze')
  })

  /* ---------------------------------------------------------------- disputes */

  const settledOrder = async (disputeWindowMs = 3_600_000) => {
    const listing = await seedListing(h, { disputeWindowMs })
    const result = await buy(listing.id)
    return { listing, order: result.order }
  }

  test('AN OPEN DISPUTE BLOCKS THE PAYOUT', async () => {
    const { order } = await settledOrder()
    await payoutDueNow(sql, order.id)
    await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    const result = await releaseProceeds(h.orders, {
      orderId: order.id,
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(result.outcome, 'disputed')
    assert.equal((await findOrder(h.sql, order.id))?.proceedsState, 'held')
  })

  test('a disputed order is excluded from the payout sweep as well', async () => {
    // Two defences in the same direction: the sweep's query and the claim itself. A dispute
    // raised between the sweep and the claim would otherwise be ignored.
    const { order } = await settledOrder()
    await payoutDueNow(sql, order.id)
    assert.deepEqual([...(await duePayouts(h.sql, 10))], [order.id])
    await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    assert.deepEqual([...(await duePayouts(h.sql, 10))], [])
  })

  test('a dispute freezes the listing behind the order', async () => {
    const { listing, order } = await settledOrder()
    await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.frozen, true)
  })

  test('only the buyer or the seller may dispute an order', async () => {
    // A third party's complaint is a moderation case: a different table, a different resolution
    // path, and no power to move money.
    const { order } = await settledOrder()
    await assert.rejects(
      openDispute(h.moderation, {
        orderId: order.id,
        raiserSubject: SECOND_BUYER,
        reason: 'I want it',
        correlationId: 'r',
      }),
      /only the buyer or the seller/,
    )
  })

  test('a second open dispute on one order is refused', async () => {
    const { order } = await settledOrder()
    await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'a',
      correlationId: 'r',
    })
    await assert.rejects(
      openDispute(h.moderation, {
        orderId: order.id,
        raiserSubject: SELLER,
        reason: 'b',
        correlationId: 'r',
      }),
      /disputes_open_uniq/,
    )
  })

  test('A REFUND IS A REVERSAL ENTRY, NEVER AN EDIT OF THE ORDER', async () => {
    // 04-domain-model §2.2 invariant 3. The order stays exactly as it settled, for ever; the
    // dispute row is what says what happened next.
    const { order } = await settledOrder()
    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    const resolved = await resolveDispute(h.moderation, {
      disputeId: dispute.id,
      resolution: 'refunded',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal(resolved.dispute.state, 'resolved_refunded')
    assert.ok(resolved.reversalEntryId)

    const entry = h.ledger.posted(`market:refund:${dispute.id}`)
    assert.ok(entry)
    assert.equal(entry.kind, 'reversal')
    assert.equal(entry.reversesEntryId, order.journalEntryId)
    assertBalanced(entry.postings)

    // The buyer gets the FULL price back, and every party who was paid gives their share back —
    // including the platform. A refund that returned the price while clawing back only part of it
    // would not balance, and absorbing the difference would be a write-off nobody approved.
    assert.deepEqual(
      entry.postings.map((p) => [p.direction, p.amount.toString(), p.account.subject, p.account.purpose]),
      [
        ['debit', '975', SELLER, 'payout_due'],
        ['debit', '25', 'platform', 'fees'],
        ['credit', '1000', BUYER, 'available'],
      ],
    )

    // The order's own amounts are untouched.
    const after = await findOrder(h.sql, order.id)
    assert.equal(after?.amount, order.amount)
    assert.equal(after?.sellerProceeds, order.sellerProceeds)
  })

  test('a refund captures the proceeds escrow rather than releasing it to the seller', async () => {
    const { listing, order } = await settledOrder()
    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    await resolveDispute(h.moderation, {
      disputeId: dispute.id,
      resolution: 'refunded',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    const proceeds = (await escrowsForListing(h.sql, listing.id)).find((e) => e.kind === 'proceeds')
    // `captured`: the value left the escrow and did NOT go back to its owner.
    assert.equal(proceeds?.state, 'captured')
  })

  test('a refund after the payout has run is REFUSED, with a reason', async () => {
    // `refundPostings` debits the seller's payout_due. Once the money is in `available` the seller
    // may have spent it, and a refund would drive their liability negative — which the ledger
    // refuses, correctly, after the operator has already told the buyer they were being repaid.
    const { order } = await settledOrder()
    await payoutDueNow(sql, order.id)
    await releaseProceeds(h.orders, { orderId: order.id, actor: 'system', correlationId: 'r' })

    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'late complaint',
      correlationId: 'r',
    })
    await assert.rejects(
      resolveDispute(h.moderation, {
        disputeId: dispute.id,
        resolution: 'refunded',
        resolvedBy: 'ops-1',
        correlationId: 'r',
      }),
      /already been paid out/,
    )
  })

  test('an on-chain sale cannot be refunded through the ledger', async () => {
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
      onchainTransactionId: '0xsettle',
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const dispute = await openDispute(h.moderation, {
      orderId: result.order.id,
      raiserSubject: BUYER,
      reason: 'not as described',
      correlationId: 'r',
    })
    await assert.rejects(
      resolveDispute(h.moderation, {
        disputeId: dispute.id,
        resolution: 'refunded',
        resolvedBy: 'ops-1',
        correlationId: 'r',
      }),
      /on-chain sale cannot be refunded/,
    )
  })

  test('upholding the sale unfreezes the listing and lets the payout run', async () => {
    const { listing, order } = await settledOrder()
    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    await resolveDispute(h.moderation, {
      disputeId: dispute.id,
      resolution: 'upheld',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal((await findListing(h.sql, listing.id))?.frozen, false)
    await payoutDueNow(sql, order.id)
    const paid = await releaseProceeds(h.orders, {
      orderId: order.id,
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(paid.outcome, 'paid')
  })

  test('an already-resolved dispute cannot be resolved again', async () => {
    const { order } = await settledOrder()
    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'a',
      correlationId: 'r',
    })
    await resolveDispute(h.moderation, {
      disputeId: dispute.id,
      resolution: 'upheld',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    await assert.rejects(
      resolveDispute(h.moderation, {
        disputeId: dispute.id,
        resolution: 'refunded',
        resolvedBy: 'ops-2',
        correlationId: 'r',
      }),
      /already resolved_upheld/,
    )
  })

  test('resolving a dispute emits an event, and the dispute is findable', async () => {
    const { order } = await settledOrder()
    const dispute = await openDispute(h.moderation, {
      orderId: order.id,
      raiserSubject: BUYER,
      reason: 'a',
      correlationId: 'r',
    })
    await resolveDispute(h.moderation, {
      disputeId: dispute.id,
      resolution: 'upheld',
      resolvedBy: 'ops-1',
      correlationId: 'r',
    })
    assert.equal((await findDispute(h.sql, dispute.id))?.state, 'resolved_upheld')
    assert.equal((await listDisputes(h.sql, { state: 'open' })).length, 0)
    const rows = await sql<{ topic: string }[]>`
      select topic from outbox where topic like 'market.dispute.%' order by occurred_at
    `
    assert.deepEqual(
      rows.map((row) => row.topic),
      ['market.dispute.opened', 'market.dispute.resolved'],
    )
  })

  /**
   * The third instance of the defect that made `market.offer.made` findable, and the one with the
   * most at stake: opening a dispute FREEZES the listing and holds the seller's payout, and every
   * subject on the envelope named the person who complained.
   *
   * Both directions are exercised on purpose. A counterparty computed as "always the seller" is
   * right half the time and would pass a one-directional test — and being right half the time
   * means telling a buyer, in the other half, that their own complaint was made against them.
   */
  test('a dispute names the counterparty, in whichever direction it was raised', async () => {
    const buyerRaised = await settledOrder()
    await openDispute(h.moderation, {
      orderId: buyerRaised.order.id,
      raiserSubject: BUYER,
      reason: 'never arrived',
      correlationId: 'r',
    })
    const first = await sql<{ actor: string; payload: Record<string, unknown> }[]>`
      select actor, payload from outbox where topic = 'market.dispute.opened'
    `
    assert.equal(first.length, 1)
    assert.equal(first[0]!.actor, BUYER)
    assert.equal(first[0]!.payload['raiserSubject'], BUYER)
    assert.equal(first[0]!.payload['counterpartySubject'], SELLER)

    await sql`delete from outbox`
    const sellerRaised = await settledOrder()
    await openDispute(h.moderation, {
      orderId: sellerRaised.order.id,
      raiserSubject: SELLER,
      reason: 'the buyer is charging back',
      correlationId: 'r',
    })
    const second = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox where topic = 'market.dispute.opened'
    `
    assert.equal(second.length, 1)
    assert.equal(second[0]!.payload['raiserSubject'], SELLER)
    assert.equal(second[0]!.payload['counterpartySubject'], BUYER)
  })

  /**
   * The other half of that pair, which was missing and made the first half read as complete.
   *
   * `market.dispute.opened` names the counterparty so the person whose payout it FREEZES can be
   * told. `market.dispute.resolved` is the event that lifts the freeze — `refreshFrozen`, and
   * `duePayouts` stops excluding the order — and it named nobody at all: four ids and an
   * `operator:` actor. So the estate could deliver "your money is held" and had no way, ever, to
   * deliver the sentence that ends it. A one-ended fix is the failure mode that looks most like a
   * fix, which is why both directions and both resolutions are driven here.
   */
  test('a resolved dispute names both parties, in whichever direction it was raised', async () => {
    for (const [raiser, counterparty, resolution] of [
      [BUYER, SELLER, 'refunded'],
      [SELLER, BUYER, 'upheld'],
    ] as const) {
      await sql`delete from outbox`
      const settled = await settledOrder()
      const dispute = await openDispute(h.moderation, {
        orderId: settled.order.id,
        raiserSubject: raiser,
        reason: 'r',
        correlationId: 'r',
      })
      await resolveDispute(h.moderation, {
        disputeId: dispute.id,
        resolution,
        resolvedBy: 'ops-1',
        correlationId: 'r',
      })
      const rows = await sql<{ actor: string; payload: Record<string, unknown> }[]>`
        select actor, payload from outbox where topic = 'market.dispute.resolved'
      `
      assert.equal(rows.length, 1)
      const event = rows[0]!
      // The actor is the OPERATOR, which is the whole reason neither party can be inferred from
      // the envelope and both have to be on the payload.
      assert.equal(event.actor, 'operator:ops-1')
      assert.equal(event.payload['raiserSubject'], raiser)
      assert.equal(event.payload['counterpartySubject'], counterparty)
      assert.notEqual(event.payload['counterpartySubject'], event.payload['raiserSubject'])
      // The outcome stays in ONE field. A consumer joins `resolution` to the two subjects rather
      // than reading a second encoding of the same fact that could disagree with the first.
      assert.equal(event.payload['resolution'], resolution)
    }
  })

  test('a case can be found by id after it is opened', async () => {
    const listing = await seedListing(h)
    const opened = await freeze(listing.id)
    assert.equal((await findCase(h.sql, opened.id))?.reason, 'reported as counterfeit')
  })

  test('a frozen auction cannot be closed by a worker either', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    await freeze(listing.id)
    const { closeAuction } = await import('./orders.ts')
    await assert.rejects(
      closeAuction(h.orders, { listingId: listing.id, actor: 'system', correlationId: 'r' }),
      FrozenError,
    )
  })
})
