/**
 * Collections, verification, and the listing lifecycle.
 *
 * The claim under test is 04-domain-model §6.1: **a listing that cannot reserve cannot be
 * listed.** Everything else in this file exists to show that the reservation is real — that the
 * ledger was actually called, with the right asset, for the right amount, under a derived key.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  FrozenError,
  ListingError,
  ListingStateError,
  activateListing,
  cancelListing,
  createCollection,
  createListing,
  expiredListings,
  findCollection,
  findListing,
  findVerification,
  listListings,
  listingRoyalties,
  setVerification,
} from './listings.ts'
import { escrowsForListing } from './escrow.ts'
import { placeBid } from './bids.ts'
import { LedgerRefusedError } from './ledgerclient.ts'
import {
  BUYER,
  CREATOR,
  SELLER,
  harness,
  migrateTestDb,
  openDb,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

describe('listings', { skip }, () => {
  let sql: postgres.Sql
  let h: Harness

  before(async () => {
    sql = openDb(6)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
    h = harness(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- collections */

  test('a collection carries its default royalty split', async () => {
    const collection = await createCollection(h.sql, {
      ownerSubject: SELLER,
      slug: 'ashvale-relics',
      name: 'Ashvale Relics',
      royalties: [
        { subject: CREATOR, bps: 7_000 },
        { subject: SELLER, bps: 3_000 },
      ],
    })
    const found = await findCollection(h.sql, collection.id)
    assert.equal(found?.royalties.length, 2)
    assert.equal(found?.royalties.reduce((acc, r) => acc + r.bps, 0), 10_000)
  })

  test('a royalty split that does not sum to 10,000 is refused', async () => {
    // Not "at most": a split summing to 9,000 would silently hand the missing tenth to whoever
    // largest-remainder favoured — a real payment nobody agreed to.
    await assert.rejects(
      createCollection(h.sql, {
        ownerSubject: SELLER,
        slug: 'short-split',
        name: 'Short',
        royalties: [{ subject: CREATOR, bps: 9_000 }],
      }),
      /sum to exactly 10000/,
    )
  })

  test('a royalty split with a duplicate recipient is refused', async () => {
    await assert.rejects(
      createCollection(h.sql, {
        ownerSubject: SELLER,
        slug: 'dupes',
        name: 'Dupes',
        royalties: [
          { subject: CREATOR, bps: 5_000 },
          { subject: CREATOR, bps: 5_000 },
        ],
      }),
      /appears twice/,
    )
  })

  /* ---------------------------------------------------------------- creation */

  test('a new listing is a draft and holds nothing', async () => {
    const listing = await seedListing(h, { activate: false })
    assert.equal(listing.status, 'draft')
    assert.equal(listing.escrowId, null)
    assert.equal(h.ledger.postedCount, 0)
  })

  test('a royalty above the platform maximum is refused', async () => {
    await assert.rejects(
      createListing(h.sql, 'market', {
        sellerSubject: SELLER,
        assetKind: 'collectible',
        itemUrn: 'cf:mint:token:1',
        quantity: 1n,
        itemAssetCode: 'TOKEN:cf:mint:token:1',
        pricingMode: 'fixed',
        price: 1_000n,
        assetCode: 'SHARD',
        settlementMode: 'custodial',
        royaltyBps: 2_000,
        platformFeeBps: 250,
        disputeWindowMs: 0,
        royaltyRecipients: [{ subject: CREATOR, bps: 10_000 }],
        maxRoyaltyBps: 1_000,
        actor: SELLER,
        correlationId: 'r',
      }),
      /exceeds the platform maximum/,
    )
  })

  test('a listing with a royalty must say who receives it', async () => {
    await assert.rejects(
      createListing(h.sql, 'market', {
        sellerSubject: SELLER,
        assetKind: 'collectible',
        itemUrn: 'cf:mint:token:1',
        quantity: 1n,
        itemAssetCode: 'TOKEN:cf:mint:token:1',
        pricingMode: 'fixed',
        price: 1_000n,
        assetCode: 'SHARD',
        settlementMode: 'custodial',
        royaltyBps: 500,
        platformFeeBps: 250,
        disputeWindowMs: 0,
        maxRoyaltyBps: 1_000,
        actor: SELLER,
        correlationId: 'r',
      }),
      ListingError,
    )
  })

  test('the collection’s royalty split is SNAPSHOTTED onto the listing, not joined', async () => {
    // A collection owner must not be able to edit the split while an auction is running and be
    // paid under terms no bidder ever saw. That is not a query bug, it is a way to take money.
    const collection = await createCollection(h.sql, {
      ownerSubject: SELLER,
      slug: 'snapshot-me',
      name: 'Snapshot',
      royalties: [{ subject: CREATOR, bps: 10_000 }],
    })
    const listing = await createListing(h.sql, 'market', {
      sellerSubject: SELLER,
      collectionId: collection.id,
      assetKind: 'collectible',
      itemUrn: 'cf:mint:token:1',
      quantity: 1n,
      itemAssetCode: 'TOKEN:cf:mint:token:1',
      pricingMode: 'fixed',
      price: 1_000n,
      assetCode: 'SHARD',
      settlementMode: 'custodial',
      royaltyBps: 500,
      platformFeeBps: 250,
      disputeWindowMs: 0,
      maxRoyaltyBps: 1_000,
      actor: SELLER,
      correlationId: 'r',
    })

    // The owner rewrites the collection's split in their own favour.
    await sql`update collection_royalties set subject = ${SELLER} where collection_id = ${collection.id}`

    const snapshot = await listingRoyalties(h.sql, listing.id)
    assert.deepEqual([...snapshot], [{ subject: CREATOR, bps: 10_000 }])
  })

  test('the platform fee and dispute window are snapshotted too', async () => {
    const listing = await seedListing(h, {
      activate: false,
      platformFeeBps: 500,
      disputeWindowMs: 60_000,
    })
    const stored = await findListing(h.sql, listing.id)
    assert.equal(stored?.platformFeeBps, 500)
    assert.equal(stored?.disputeWindowMs, 60_000)
  })

  /* ---------------------------------------------------------------- activation */

  test('ACTIVATION RESERVES THE ITEM IN THE LEDGER', async () => {
    const listing = await seedListing(h, { quantity: 3n })
    assert.equal(listing.status, 'active')
    assert.ok(listing.escrowId)

    const entry = h.ledger.posted(`market:escrow:listing:${listing.id}`)
    assert.ok(entry, 'the ledger was not asked to reserve anything')
    assert.equal(entry.kind, 'market_escrow')
    // The ITEM's asset code, not the price's. Reserving the wrong one produces an entry that
    // balances perfectly and reserves something the seller is not selling.
    assert.deepEqual(
      entry.postings.map((p) => [p.direction, p.amount.toString(), p.assetCode, p.account.purpose]),
      [
        ['debit', '3', 'TOKEN:cf:mint:token:0192', 'available'],
        ['credit', '3', 'TOKEN:cf:mint:token:0192', 'reserved'],
      ],
    )
  })

  test('the escrow row points at the entry that made the reservation', async () => {
    const listing = await seedListing(h)
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows.length, 1)
    assert.equal(escrows[0]?.kind, 'listing_item')
    assert.equal(escrows[0]?.state, 'held')
    assert.ok(escrows[0]?.holdEntryId, 'an escrow that cannot name its posting is an assertion')
  })

  test('A LISTING THE LEDGER WILL NOT RESERVE IS NEVER ACTIVATED', async () => {
    // The whole invariant, end to end: the ledger refuses, and nothing at all is left behind.
    const listing = await seedListing(h, { activate: false })
    h.ledger.failNext(new LedgerRefusedError(402, 'insufficient_balance', 'not enough'))
    await assert.rejects(
      activateListing(h.listings, {
        listingId: listing.id,
        sellerSubject: SELLER,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      LedgerRefusedError,
    )
    const after = await findListing(h.sql, listing.id)
    assert.equal(after?.status, 'draft')
    assert.equal(after?.escrowId, null)
    assert.equal((await escrowsForListing(h.sql, listing.id)).length, 0)
  })

  test('a listing cannot be activated twice', async () => {
    const listing = await seedListing(h)
    await assert.rejects(
      activateListing(h.listings, {
        listingId: listing.id,
        sellerSubject: SELLER,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      ListingStateError,
    )
    assert.equal(h.ledger.postedCount, 1)
  })

  test('somebody else’s draft cannot be activated, and the answer is “no such listing”', async () => {
    // The same answer as a genuine miss, deliberately: a distinct 403 is an enumeration oracle
    // for who is selling what.
    const listing = await seedListing(h, { activate: false })
    await assert.rejects(
      activateListing(h.listings, {
        listingId: listing.id,
        sellerSubject: BUYER,
        actor: BUYER as `user:${string}`,
        correlationId: 'r',
      }),
      /no such listing/,
    )
  })

  test('a frozen draft cannot be activated', async () => {
    const listing = await seedListing(h, { activate: false })
    await sql`update listings set frozen = true where id = ${listing.id}`
    await assert.rejects(
      activateListing(h.listings, {
        listingId: listing.id,
        sellerSubject: SELLER,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      FrozenError,
    )
  })

  test('activation writes market.listing.listed in the same transaction', async () => {
    const listing = await seedListing(h)
    const rows = await sql<{ topic: string; key: string; payload: Record<string, unknown> }[]>`
      select topic, key, payload from outbox order by occurred_at
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.topic, 'market.listing.listed')
    assert.equal(rows[0]?.key, listing.id)
    // Amounts on the wire are strings. A JSON number is an IEEE 754 double.
    assert.equal(rows[0]?.payload['price'], '1000')
  })

  test('an on-chain listing activates on its confirmed transaction, with no ledger call', async () => {
    // AD-14: the platform never holds the key; the user's own wallet is the counterparty.
    const listing = await seedListing(h, { activate: false, settlementMode: 'onchain' })
    const active = await activateListing(h.listings, {
      listingId: listing.id,
      sellerSubject: SELLER,
      onchainEscrowTx: '0xdeadbeef',
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(active.status, 'active')
    assert.equal(active.escrowId, null)
    assert.equal(active.onchainEscrowTx, '0xdeadbeef')
    assert.equal(h.ledger.postedCount, 0)
  })

  test('an on-chain listing with no escrow transaction is refused', async () => {
    const listing = await seedListing(h, { activate: false, settlementMode: 'onchain' })
    await assert.rejects(
      activateListing(h.listings, {
        listingId: listing.id,
        sellerSubject: SELLER,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      }),
      ListingStateError,
    )
  })

  /* ---------------------------------------------------------------- withdrawal */

  test('cancelling releases the item escrow, exactly once', async () => {
    const listing = await seedListing(h)
    const cancelled = await cancelListing(h.listings, {
      listingId: listing.id,
      sellerSubject: SELLER,
      reason: 'changed my mind',
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(cancelled.status, 'cancelled')
    const escrows = await escrowsForListing(h.sql, listing.id)
    assert.equal(escrows[0]?.state, 'released')
    assert.ok(escrows[0]?.settleEntryId)

    // The release posting is the mirror of the reservation.
    const release = h.ledger.posted(`market:release:${escrows[0]?.id}`)
    assert.deepEqual(
      release?.postings.map((p) => [p.direction, p.account.purpose]),
      [
        ['debit', 'reserved'],
        ['credit', 'available'],
      ],
    )
  })

  test('cancelling an already-cancelled listing is a no-op, not an error', async () => {
    const listing = await seedListing(h)
    await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'a',
      actor: 'system',
      correlationId: 'r',
    })
    const posted = h.ledger.postedCount
    const again = await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'b',
      actor: 'system',
      correlationId: 'r',
    })
    assert.equal(again.status, 'cancelled')
    // Idempotent: a second cancellation refunds nothing a second time.
    assert.equal(h.ledger.postedCount, posted)
  })

  test('a draft can be withdrawn without any ledger movement', async () => {
    const listing = await seedListing(h, { activate: false })
    const cancelled = await cancelListing(h.listings, {
      listingId: listing.id,
      sellerSubject: SELLER,
      reason: 'never mind',
      actor: SELLER as `user:${string}`,
      correlationId: 'r',
    })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(h.ledger.postedCount, 0)
  })

  test('withdrawal emits market.listing.removed with the reason', async () => {
    const listing = await seedListing(h)
    await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'withdrawn by the seller',
      actor: 'system',
      correlationId: 'r',
    })
    const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
      select topic, payload from outbox where topic = 'market.listing.removed'
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.payload['reason'], 'withdrawn by the seller')
    // A listing nobody bid on refunds nobody. An EMPTY ARRAY and never an absent field: a consumer
    // cannot tell "nobody" from "this producer predates the field" and would have to guess.
    assert.deepEqual(rows[0]?.payload['refundedSubjects'], [])
  })

  /**
   * The fourth topic found by asking "does the envelope name only the person who acted?".
   *
   * A cancellation releases the item escrow AND every open bid and offer, marking the bids `lost`
   * and the offers `declined`. The payload named `sellerSubject` and nothing else, and the actor is
   * the seller — or an `operator:` delisting an upheld moderation case, in which case nobody with
   * money in the listing appeared on the envelope at all. Every bidder's funds moved back and
   * nothing could say so, which is verbatim the sentence `outbidSubject` was added to
   * `market.bid.placed` for.
   */
  test('a cancellation names every bidder and offerer whose money it refunds', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    // A second, higher bid from a DIFFERENT person: the first is refunded as it is outbid, so only
    // the leader still holds funds at cancellation time. That is what makes this an assertion
    // about who is actually being refunded rather than about who ever bid.
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: CREATOR,
      amount: 900n,
      actor: CREATOR as `user:${string}`,
      correlationId: 'r',
    })
    await sql`delete from outbox`

    await cancelListing(h.listings, {
      listingId: listing.id,
      reason: 'withdrawn with a live auction',
      actor: 'system',
      correlationId: 'r',
    })
    const rows = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox where topic = 'market.listing.removed'
    `
    assert.equal(rows.length, 1)
    const refunded = rows[0]?.payload['refundedSubjects']
    assert.deepEqual(refunded, [CREATOR], 'the leader, whose funds were still held')
    // The seller is named as `sellerSubject` and must not be doubled in here: the item escrow is
    // an unlock rather than a refund, and listing them would make one field mean two things.
    assert.ok(Array.isArray(refunded) && !refunded.includes(SELLER))
    assert.equal(rows[0]?.payload['sellerSubject'], SELLER)
    // And every escrow really was released, so the field is describing something that happened.
    const still = await escrowsForListing(sql, listing.id)
    assert.equal(still.filter((each) => each.state === 'held').length, 0)
  })

  /* ---------------------------------------------------------------- queries */

  test('the browse query defaults to what is actually for sale', async () => {
    await seedListing(h)
    await seedListing(h, { activate: false, itemUrn: 'cf:mint:token:draft' })
    const active = await listListings(h.sql, { status: 'active' })
    assert.equal(active.length, 1)
    assert.equal(active[0]?.status, 'active')
  })

  test('expiredListings uses the DATABASE clock, so N replicas agree', async () => {
    // One clock domain. The lesson from billing/src/entitlements.ts, where a row stamped by
    // Postgres and compared against the application's clock made a just-granted entitlement read
    // as inactive on a host with 60ms of skew. Here that skew would expire a listing mid-auction.
    const listing = await seedListing(h, { expiresAt: new Date(Date.now() + 3_600_000) })
    assert.deepEqual([...(await expiredListings(h.sql, 10))], [])
    await sql`update listings set expires_at = now() - interval '1 second' where id = ${listing.id}`
    assert.deepEqual([...(await expiredListings(h.sql, 10))], [listing.id])
  })

  /* ---------------------------------------------------------------- verification */

  test('an unseen subject is unverified, not a 404', async () => {
    // "We have never looked at this" is a real answer and the one a buyer needs. A 404 would make
    // a client show nothing at all, which reads as "verified".
    const verification = await findVerification(h.sql, 'cf:mint:token:never-seen')
    assert.equal(verification.level, 'unverified')
    assert.equal(verification.reviewedBy, null)
  })

  test('a verification records who decided and when', async () => {
    const set = await setVerification(h.sql, {
      subjectUrn: 'cf:mint:token:1',
      level: 'verified',
      evidence: { contract: '0xabc' },
      reviewedBy: 'ops-1',
    })
    assert.equal(set.level, 'verified')
    assert.equal(set.reviewedBy, 'ops-1')
    assert.ok(set.reviewedAt)
    const again = await setVerification(h.sql, {
      subjectUrn: 'cf:mint:token:1',
      level: 'flagged',
      reviewedBy: 'ops-2',
    })
    assert.equal(again.level, 'flagged')
    assert.equal(again.reviewedBy, 'ops-2')
  })
})
