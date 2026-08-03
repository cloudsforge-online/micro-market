/**
 * Bids and offers, including the race the whole design of `placeBid` exists to lose safely.
 *
 * The concurrency tests here run against a REAL Postgres on a REAL pool with more than one
 * connection, so `for update` genuinely blocks and the two transactions genuinely interleave. A
 * test that serialised the two calls itself would prove nothing at all.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  AuctionClosedError,
  BidError,
  BidTooLowError,
  closeOffer,
  dueAuctions,
  expiredOffers,
  findOffer,
  leadingBid,
  listBids,
  listOffers,
  makeOffer,
  placeBid,
} from './bids.ts'
import { FrozenError, ListingStateError } from './listings.ts'
import { escrowsForListing } from './escrow.ts'
import { LedgerRefusedError } from './ledgerclient.ts'
import {
  BUYER,
  SECOND_BUYER,
  SELLER,
  endAuctionNow,
  harness,
  migrateTestDb,
  openDb,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

describe('bids and offers', { skip }, () => {
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

  /* ---------------------------------------------------------------- bidding */

  test('A BID ESCROWS ITS MONEY BEFORE THE ROW EXISTS', async () => {
    // A bid that does not hold its money is not a bid, it is an opinion — and an auction close
    // that fails on the winner's balance is not recoverable by retrying, only by re-running.
    const listing = await auction()
    const result = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 150n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(result.bid.status, 'leading')
    assert.ok(result.bid.escrowId)

    const entry = h.ledger.posted(`market:escrow:bid:${result.bid.id}`)
    assert.ok(entry)
    assert.deepEqual(
      entry.postings.map((p) => [p.direction, p.amount.toString(), p.assetCode, p.account.purpose]),
      [
        ['debit', '150', 'SHARD', 'available'],
        ['credit', '150', 'SHARD', 'reserved'],
      ],
    )
  })

  test('the first bid must reach the starting price', async () => {
    const listing = await auction({ price: 500n })
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 499n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      (err: unknown) => {
        assert.ok(err instanceof BidTooLowError)
        assert.equal(err.minimum, 500n)
        return true
      },
    )
  })

  test('a tie never displaces the leader', async () => {
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: SECOND_BUYER,
        amount: 500n,
        actor: SECOND_BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      BidTooLowError,
    )
  })

  test('a higher bid displaces the leader and refunds them in the same transaction', async () => {
    const listing = await auction()
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
    assert.equal(second.outbid?.id, first.bid.id)

    const escrows = await escrowsForListing(h.sql, listing.id)
    const firstEscrow = escrows.find((escrow) => escrow.bidId === first.bid.id)
    const secondEscrow = escrows.find((escrow) => escrow.bidId === second.bid.id)
    // A losing bidder gets their money back NOW, not eventually. Money left reserved against a
    // bid that cannot win is money the customer cannot spend and has nothing to look at.
    assert.equal(firstEscrow?.state, 'released')
    assert.equal(secondEscrow?.state, 'held')
    assert.equal((await leadingBid(h.sql, listing.id))?.id, second.bid.id)
  })

  test('a bidder who cannot pay leaves the previous leader untouched', async () => {
    // Step 3 (release) before step 4 (reserve) is what makes this true: the whole transaction
    // rolls back and the displaced leader never finds out.
    const listing = await auction()
    const first = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    h.ledger.failNext(new LedgerRefusedError(402, 'insufficient_balance', 'not enough'))
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: SECOND_BUYER,
        amount: 600n,
        actor: SECOND_BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      LedgerRefusedError,
    )
    const leader = await leadingBid(h.sql, listing.id)
    assert.equal(leader?.id, first.bid.id)
    const funds = (await escrowsForListing(h.sql, listing.id)).filter(
      (escrow) => escrow.kind === 'bid_funds',
    )
    assert.equal(funds.length, 1)
    assert.equal(funds[0]?.state, 'held')
    assert.equal(funds[0]?.bidId, first.bid.id)
  })

  test('TWO SIMULTANEOUS EQUAL BIDS PRODUCE EXACTLY ONE WINNER', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // The concurrent bid race, run for real: two transactions, two connections, one listing.
    // `select … from listings … for update` serialises them; the loser then reads the winner's
    // committed bid and is refused for not exceeding it.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const listing = await auction()
    const results = await Promise.allSettled([
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 500n,
        actor: BUYER as `user:${string}`,
        correlationId: 'a',
      }),
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: SECOND_BUYER,
        amount: 500n,
        actor: SECOND_BUYER as `user:${string}`,
        correlationId: 'b',
      }),
    ])
    const won = results.filter((result) => result.status === 'fulfilled')
    assert.equal(won.length, 1, 'exactly one bid must be accepted')

    const bids = await listBids(h.sql, listing.id)
    assert.equal(bids.length, 1)
    assert.equal(bids[0]?.status, 'leading')

    // And exactly one bidder's money is held.
    const held = (await escrowsForListing(h.sql, listing.id)).filter(
      (escrow) => escrow.kind === 'bid_funds' && escrow.state === 'held',
    )
    assert.equal(held.length, 1)
    assert.equal(held[0]?.subject, bids[0]?.bidderSubject)
  })

  test('eight simultaneous bids leave exactly one leader and one held bid escrow', async () => {
    // The same race with more contenders, and with distinct amounts so the ordering is decided by
    // who commits first rather than by the amounts. Whatever order Postgres chooses, the
    // invariant is the same.
    const listing = await auction()
    const amounts = [200n, 300n, 400n, 500n, 600n, 700n, 800n, 900n]
    await Promise.allSettled(
      amounts.map((amount, index) =>
        placeBid(h.bids, {
          listingId: listing.id,
          bidderSubject: `user:bidder-${index}`,
          amount,
          actor: 'system',
          correlationId: `c-${index}`,
        }),
      ),
    )
    const leading = await sql<{ n: number }[]>`
      select count(*)::int as n from bids where listing_id = ${listing.id} and status = 'leading'
    `
    assert.equal(leading[0]?.n, 1)
    const held = (await escrowsForListing(h.sql, listing.id)).filter(
      (escrow) => escrow.kind === 'bid_funds' && escrow.state === 'held',
    )
    assert.equal(held.length, 1)
  })

  test('a seller may not bid on their own listing', async () => {
    // Shill bidding raises the price other bidders pay, and if the seller wins, settlement moves
    // their own money between their own accounts and charges the platform fee on a sale that did
    // not happen.
    const listing = await auction()
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: SELLER,
        amount: 500n,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      /may not bid on their own listing/,
    )
  })

  test('a bid on a closed auction is refused', async () => {
    const listing = await auction()
    await endAuctionNow(sql, listing.id)
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 500n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      AuctionClosedError,
    )
  })

  test('a bid on a frozen listing is refused', async () => {
    const listing = await auction()
    await sql`update listings set frozen = true where id = ${listing.id}`
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

  test('a bid on a fixed-price listing is refused with advice', async () => {
    const listing = await seedListing(h)
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 500n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      /make an offer or buy it outright/,
    )
  })

  test('a non-positive bid is refused before anything is locked', async () => {
    const listing = await auction()
    await assert.rejects(
      placeBid(h.bids, {
        listingId: listing.id,
        bidderSubject: BUYER,
        amount: 0n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      BidError,
    )
  })

  test('the reserve is never leaked through a bid refusal', async () => {
    // A bidder who could binary-search the reserve from the refusals would know exactly what to
    // bid, which is the same as the seller not having one. The reserve is checked at CLOSE.
    const listing = await auction({ price: 100n, reservePrice: 5_000n })
    const placed = await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 150n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(placed.bid.status, 'leading')
  })

  /* ---------------------------------------------------------------- anti-sniping */

  test('a late bid extends the auction', async () => {
    const sniped = harness(sql, { auctionExtensionMs: 60_000 })
    const listing = await seedListing(sniped, {
      pricingMode: 'auction',
      price: 100n,
      auctionEndsAt: new Date(Date.now() + 5_000),
    })
    const result = await placeBid(sniped.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 150n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.ok(result.extendedTo, 'a bid inside the window must push the end out')
    assert.ok(result.extendedTo.getTime() > Date.now() + 30_000)
  })

  test('an early bid does not extend the auction', async () => {
    const sniped = harness(sql, { auctionExtensionMs: 5_000 })
    const listing = await seedListing(sniped, {
      pricingMode: 'auction',
      price: 100n,
      auctionEndsAt: new Date(Date.now() + 3_600_000),
    })
    const result = await placeBid(sniped.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 150n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(result.extendedTo, null)
  })

  /* ---------------------------------------------------------------- due auctions */

  test('dueAuctions uses the database clock and finds only what is actually over', async () => {
    const open = await auction()
    const over = await auction({ itemUrn: 'cf:mint:token:other' })
    await endAuctionNow(sql, over.id)
    const due = await dueAuctions(h.sql, 10)
    assert.deepEqual([...due], [over.id])
    assert.ok(!due.includes(open.id))
  })

  /* ---------------------------------------------------------------- offers */

  test('an offer escrows its money', async () => {
    const listing = await seedListing(h, { pricingMode: 'offers_only', price: null })
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(offer.status, 'open')
    assert.ok(offer.escrowId)
    assert.ok(h.ledger.posted(`market:escrow:offer:${offer.id}`))
  })

  test('a second open offer from one buyer is refused', async () => {
    // Otherwise a buyer with one intent to buy has N escrows and a mysteriously empty balance.
    const listing = await seedListing(h)
    await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await assert.rejects(
      makeOffer(h.bids, {
        listingId: listing.id,
        offererSubject: BUYER,
        amount: 850n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      /offers_open_uniq/,
    )
  })

  test('two different buyers may both have open offers', async () => {
    const listing = await seedListing(h)
    await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: SECOND_BUYER,
      amount: 900n,
      actor: SECOND_BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal((await listOffers(h.sql, listing.id)).length, 2)
  })

  test('an offer on an auction is refused with advice', async () => {
    const listing = await auction()
    await assert.rejects(
      makeOffer(h.bids, {
        listingId: listing.id,
        offererSubject: BUYER,
        amount: 800n,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      /place a bid/,
    )
  })

  test('withdrawing an offer releases its escrow, exactly once', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await closeOffer(h.bids, {
      offerId: offer.id,
      to: 'withdrawn',
      offererSubject: BUYER,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const posted = h.ledger.postedCount
    // Again. A client retrying a withdrawal it already made is doing the right thing.
    const again = await closeOffer(h.bids, {
      offerId: offer.id,
      to: 'withdrawn',
      offererSubject: BUYER,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(again.status, 'withdrawn')
    assert.equal(h.ledger.postedCount, posted)
    assert.equal((await findOffer(h.sql, offer.id))?.status, 'withdrawn')
  })

  test('somebody else’s offer cannot be withdrawn', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await assert.rejects(
      closeOffer(h.bids, {
        offerId: offer.id,
        to: 'withdrawn',
        offererSubject: SECOND_BUYER,
        actor: SECOND_BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      ListingStateError,
    )
  })

  test('expiredOffers finds only offers whose expiry has actually passed', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      expiresAt: new Date(Date.now() + 3_600_000),
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    assert.deepEqual([...(await expiredOffers(h.sql, 10))], [])
    await sql`update offers set expires_at = now() - interval '1 second' where id = ${offer.id}`
    assert.deepEqual([...(await expiredOffers(h.sql, 10))], [offer.id])
  })

  test('cancelling a listing releases every open bid AND offer', async () => {
    const { cancelListing } = await import('./listings.ts')
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'withdrawn',
      actor: 'system',
      correlationId: 'r',
    })
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.length, 2)
    // A cancellation that released the item and forgot the bids would leave every bidder's funds
    // reserved for ever against a listing that no longer exists, and nothing would notice.
    for (const escrow of escrows) assert.equal(escrow.state, 'released')
  })

  /* ------------------------------------------- the party the event is about is not the actor */

  /**
   * These two read the OUTBOX ROW, and both assert against a concrete third subject rather than
   * against a shape.
   *
   * That is the point rather than a style. The failure this suite is guarding against is a check
   * that stays green while the payload is wrong, and the estate has just had one: an end-to-end
   * feed test passed with its classifier deliberately broken, because the payload lacked the
   * field and **an absent field is `null` to every reader**. So nothing below asserts "there is a
   * subject" or "it is not null" — each asserts that the value equals a specific person who is
   * neither the actor nor the payload's other subject, which is false both when the field is
   * missing (`undefined`) and when it names the wrong one of the two people involved.
   */
  test('an offer names the SELLER, who is the person the notification is for', async () => {
    const listing = await seedListing(h, { pricingMode: 'offers_only', price: null })
    await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const rows = await sql<{ actor: string; payload: Record<string, unknown> }[]>`
      select actor, payload from outbox where topic = 'market.offer.made'
    `
    assert.equal(rows.length, 1)
    const event = rows[0]!

    // Everything else on the envelope names the offerer. `micro-notify` refused to write a rule
    // for this topic on exactly that ground, and would have had to keep refusing without this
    // field: the only notification the topic can produce goes to the person who did NOT act.
    assert.equal(event.actor, BUYER)
    assert.equal(event.payload['offererSubject'], BUYER)
    assert.equal(event.payload['sellerSubject'], SELLER)
    assert.notEqual(event.payload['sellerSubject'], event.payload['offererSubject'])
  })

  test('a bid names the displaced leader and the seller, neither of whom placed it', async () => {
    const listing = await auction()
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 150n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: SECOND_BUYER,
      amount: 250n,
      actor: SECOND_BUYER as `user:${string}`,
      correlationId: 'r',
    })
    const rows = await sql<{ actor: string; payload: Record<string, unknown> }[]>`
      select actor, payload from outbox where topic = 'market.bid.placed' order by occurred_at
    `
    assert.equal(rows.length, 2)

    // A first bid displaces nobody. Null here is an ABSENCE that the emit site chose, and it is
    // the only reason the second assertion below is worth anything: a payload that never carried
    // the field would look exactly like this one for every event.
    assert.equal(rows[0]!.payload['outbidSubject'], null)
    assert.equal(rows[0]!.payload['outbidBidId'], null)
    assert.equal(rows[0]!.payload['sellerSubject'], SELLER)

    const second = rows[1]!
    assert.equal(second.actor, SECOND_BUYER)
    assert.equal(second.payload['bidderSubject'], SECOND_BUYER)
    // The refunded leader. Their money moved back; `outbidBidId` alone is a row id in THIS
    // service's database, which no consumer can turn into a person.
    assert.equal(second.payload['outbidSubject'], BUYER)
    assert.ok(second.payload['outbidBidId'])
    assert.equal(second.payload['sellerSubject'], SELLER)
  })
})
