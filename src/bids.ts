/**
 * Bids and offers. Both escrow the buyer's money the moment they are made.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A BID THAT DOES NOT HOLD ITS MONEY IS NOT A BID, IT IS AN OPINION.**
 *
 * Every bid and every offer reserves the buyer's funds in the ledger before the row is written,
 * in the same transaction. The alternative — recording an intention and charging at settlement —
 * is what makes an auction close fail on the winner's insufficient balance, at which point the
 * item has been withdrawn from sale, the underbidders have gone, and the seller has nothing. That
 * failure is not recoverable by retrying, only by re-running the auction.
 *
 * **THE CONCURRENT BID RACE, AND HOW EXACTLY ONE BIDDER WINS IT.**
 *
 * Two bidders submit the same amount at the same instant. `placeBid` opens with
 *
 *     select … from listings where id = $1 for update
 *
 * on the LISTING, not on the bid. The listing is the contended resource — it is the thing that
 * can only have one leader — and locking it serialises the two transactions completely. The
 * second one, once it proceeds, reads the first's committed leading bid and is refused for not
 * exceeding it, because `minimumBid` is strictly greater and a tie never displaces.
 *
 * Two independent things would still catch it if that lock were ever removed:
 *
 *   * `bids_leading_uniq`, a partial unique index on `(listing_id) where status = 'leading'`.
 *     Two leaders raise 23505 rather than existing.
 *   * `orders_listing_uniq`. Even two leaders could only ever produce one order.
 *
 * The lock is the design; the indexes are what happens if somebody deletes the design.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Anti-sniping is a market-design decision, not a bug fix
 *
 * A bid landing in the last seconds extends the auction by `auctionExtensionMs`. Without it an
 * auction is won by whoever has the lowest network latency rather than by whoever values the item
 * most, and a bidder who would have paid more never gets the chance. The extension is computed
 * and applied in the database, in the same statement domain as every other auction comparison —
 * see the clock-domain note on `bids.placed_at` in `migrations.ts`.
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import { emitOn, type Db, type Tx } from './outbox.ts'
import { holdEscrow, releaseEscrow, type ReleaseDeps } from './escrow.ts'
import { idempotencyKeys, type LedgerClient } from './ledgerclient.ts'
import { minimumBid } from './money.ts'
import { FrozenError, ListingStateError, toListing, type Listing } from './listings.ts'

export const BID_PLACED_TOPIC = 'market.bid.placed'
export const OFFER_MADE_TOPIC = 'market.offer.made'

export type BidStatus = 'leading' | 'outbid' | 'won' | 'lost' | 'withdrawn'
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'withdrawn' | 'expired'

export class BidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BidError'
  }
}

/** The bid was well formed and does not beat the leader. 409, and it says what it must beat. */
export class BidTooLowError extends BidError {
  readonly minimum: bigint
  constructor(minimum: bigint) {
    super(`a bid must be at least ${minimum}`)
    this.name = 'BidTooLowError'
    this.minimum = minimum
  }
}

/** The auction is over, or has not started. 409. */
export class AuctionClosedError extends BidError {
  constructor(message = 'this auction is closed') {
    super(message)
    this.name = 'AuctionClosedError'
  }
}

export interface Bid {
  readonly id: string
  readonly listingId: string
  readonly bidderSubject: string
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly escrowId: string | null
  readonly status: BidStatus
  readonly placedAt: Date
}

interface BidRow {
  readonly id: string
  readonly listing_id: string
  readonly bidder_subject: string
  readonly amount: string
  readonly asset_code: string
  readonly escrow_id: string | null
  readonly status: BidStatus
  readonly placed_at: Date
}

const BID_COLUMNS = `id, listing_id, bidder_subject, amount::text as amount, asset_code, escrow_id,
                     status, placed_at`

function toBid(row: BidRow): Bid {
  return {
    id: row.id,
    listingId: row.listing_id,
    bidderSubject: row.bidder_subject,
    amount: BigInt(row.amount),
    assetCode: row.asset_code as LedgerAssetCode,
    escrowId: row.escrow_id,
    status: row.status,
    placedAt: row.placed_at,
  }
}

const LISTING_COLUMNS = `id, seller_subject, seller_wallet_id, collection_id, asset_kind, item_urn,
  quantity::text as quantity, item_asset_code, pricing_mode, price::text as price,
  reserve_price::text as reserve_price, asset_code, settlement_mode, royalty_bps, platform_fee_bps,
  auction_ends_at, expires_at, status, frozen, escrow_id, onchain_escrow_tx,
  dispute_window_ms::text as dispute_window_ms, created_at, activated_at, ended_at`

export interface BidDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
  /** Anti-sniping window, in milliseconds. Zero disables it. */
  readonly auctionExtensionMs: number
}

export interface PlaceBidInput {
  readonly listingId: string
  readonly bidderSubject: string
  readonly amount: bigint
  readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
  readonly correlationId: string
}

export interface PlaceBidResult {
  readonly bid: Bid
  readonly listing: Listing
  /** The bid this one displaced, if any. Its escrow has already been released. */
  readonly outbid: Bid | null
  readonly extendedTo: Date | null
}

/**
 * Place a bid, displacing the current leader and refunding them, atomically.
 *
 * The ordering inside the transaction is the part that is easy to get backwards:
 *
 *   1. Lock the listing. Everything after this is serialised per listing.
 *   2. Read the leader and check the minimum. Refuse before any money moves.
 *   3. Release the previous leader's escrow, and mark their bid `outbid`.
 *   4. Reserve the new bidder's funds.
 *   5. Insert the new leading bid.
 *
 * Step 3 before step 4 matters. If the new bidder cannot afford their bid, step 4 throws, the
 * whole transaction rolls back, and the previous leader's escrow is restored along with their
 * `leading` status — they never find out. Reserving first and releasing second would leave a
 * window in which BOTH bidders' funds are held, which is correct on commit and a double hold on
 * any failure between them.
 */
export async function placeBid(deps: BidDeps, input: PlaceBidInput): Promise<PlaceBidResult> {
  if (input.amount <= 0n) throw new BidError('a bid must be positive')

  const outcome = await deps.sql.begin(async (tx) => {
    // 1. THE serialisation point. See the file header.
    const claimed = await tx<Array<ListingRowShape & { still_open: boolean }>>`
      select ${tx.unsafe(LISTING_COLUMNS)},
             (auction_ends_at is not null and auction_ends_at > now()) as still_open
        from listings
       where id = ${input.listingId}
         for update
    `
    const row = claimed[0]
    if (!row) throw new ListingStateError('no such listing')
    const listing = toListing(row)
    if (listing.frozen) throw new FrozenError()
    if (listing.status !== 'active') throw new AuctionClosedError(`this listing is ${listing.status}`)
    if (listing.pricingMode !== 'auction') {
      throw new BidError('this listing is not an auction; make an offer or buy it outright')
    }
    if (!row.still_open) throw new AuctionClosedError()
    if (listing.sellerSubject === input.bidderSubject) {
      // Shill bidding. Refused rather than merely discouraged: a seller bidding on their own
      // listing raises the price other bidders pay and, if they win, the settlement moves their
      // own money between their own accounts and pays the platform a fee on a sale that did not
      // happen. Both are frauds the market would be performing on its own users' behalf.
      throw new BidError('a seller may not bid on their own listing')
    }

    // 2. The leader, under the listing's lock.
    const leaders = await tx<BidRow[]>`
      select ${tx.unsafe(BID_COLUMNS)} from bids
       where listing_id = ${listing.id} and status = 'leading'
    `
    const leader = leaders[0] ? toBid(leaders[0]) : null
    // The listing's `price` is the STARTING price for an auction. A reserve, if set, is a
    // separate and secret floor checked at close — see `orders.ts`. Checking it here would leak
    // it: a bidder could binary-search the reserve from the refusals.
    const minimum = minimumBid(leader?.amount ?? null, listing.price ?? 1n)
    if (input.amount < minimum) throw new BidTooLowError(minimum)

    // 3. Refund the displaced leader. Before the new hold; see the doc comment.
    const releaseDeps: ReleaseDeps = {
      ledger: deps.ledger,
      actor: input.actor,
      correlationId: input.correlationId,
    }
    let outbid: Bid | null = null
    if (leader) {
      await tx`update bids set status = 'outbid' where id = ${leader.id} and status = 'leading'`
      if (leader.escrowId) await releaseEscrow(tx, releaseDeps, leader.escrowId)
      outbid = { ...leader, status: 'outbid' }
    }

    // 4 and 5. The bid row is inserted first so its id exists to derive the escrow key from —
    // `market:escrow:bid:<bidId>`. A key derived from anything the transaction does not yet know
    // would change on a retry and reserve the funds twice.
    const inserted = await tx<BidRow[]>`
      insert into bids (listing_id, bidder_subject, amount, asset_code, status)
      values (${listing.id}, ${input.bidderSubject}, ${input.amount.toString()},
              ${listing.assetCode}, 'leading')
      returning ${tx.unsafe(BID_COLUMNS)}
    `
    const bidRow = inserted[0]
    if (!bidRow) throw new BidError('the bid was not written')

    const escrow = await holdEscrow(tx, deps.ledger, {
      listingId: listing.id,
      kind: 'bid_funds',
      subject: input.bidderSubject,
      assetCode: listing.assetCode,
      amount: input.amount,
      bidId: bidRow.id,
      idempotencyKey: idempotencyKeys.reserveBid(bidRow.id),
      actor: input.actor,
      correlationId: input.correlationId,
      description: `escrow ${input.amount} ${listing.assetCode} for bid ${bidRow.id}`,
    })
    const withEscrow = await tx<BidRow[]>`
      update bids set escrow_id = ${escrow.id} where id = ${bidRow.id}
      returning ${tx.unsafe(BID_COLUMNS)}
    `
    const finalRow = withEscrow[0]
    if (!finalRow) throw new BidError('the bid vanished under its own transaction')

    // Anti-sniping, computed in the database so the comparison and the new value share a clock.
    let extendedTo: Date | null = null
    if (deps.auctionExtensionMs > 0) {
      const extended = await tx<{ auction_ends_at: Date }[]>`
        update listings
           set auction_ends_at = now() + make_interval(secs => ${deps.auctionExtensionMs / 1000}),
               updated_at = now()
         where id = ${listing.id}
           and auction_ends_at < now() + make_interval(secs => ${deps.auctionExtensionMs / 1000})
        returning auction_ends_at
      `
      extendedTo = extended[0]?.auction_ends_at ?? null
    }

    await emitOn(tx, deps.producer, {
      topic: BID_PLACED_TOPIC,
      key: listing.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        listingId: listing.id,
        bidId: bidRow.id,
        bidderSubject: input.bidderSubject,
        // A decimal string. A JSON number is an IEEE 754 double and a bid is money.
        amount: input.amount.toString(),
        assetCode: listing.assetCode,
        outbidBidId: outbid?.id ?? null,
        // The two people this event is ABOUT, neither of whom is the actor.
        //
        // Found by asking of every topic in this service the question that found the offer defect:
        // does the envelope name only the person who acted? This one did. `outbidBidId` is a row
        // id in THIS service's database — a consumer holding it cannot resolve a person from it,
        // and there is no route that would let it — so the notification this topic's own
        // quarantine entry gives as its whole reason for existing ("an auction leader was
        // displaced and refunded; their notification is the only thing that tells them") could not
        // be written. Their money moved back without anybody being able to say so.
        //
        // `sellerSubject` for the same reason as on `market.offer.made` below: a bid on an auction
        // and an offer on a fixed price are the same fact to a seller, and fixing one of the two
        // would have been fixing half of one defect. Both are subjects (`user:` or `service:`),
        // and `outbidSubject` is null exactly when `outbidBidId` is — a first bid displaces
        // nobody, which is an absence rather than a missing field.
        outbidSubject: outbid?.bidderSubject ?? null,
        sellerSubject: listing.sellerSubject,
      },
    })

    return { value: { bid: toBid(finalRow), listing, outbid, extendedTo } }
  })
  return outcome.value
}

type ListingRowShape = Parameters<typeof toListing>[0]

export async function leadingBid(sql: Db | Tx, listingId: string): Promise<Bid | null> {
  const rows = await sql<BidRow[]>`
    select ${sql.unsafe(BID_COLUMNS)} from bids
     where listing_id = ${listingId} and status = 'leading'
  `
  const row = rows[0]
  return row ? toBid(row) : null
}

export async function listBids(sql: Db, listingId: string): Promise<readonly Bid[]> {
  const rows = await sql<BidRow[]>`
    select ${sql.unsafe(BID_COLUMNS)} from bids
     where listing_id = ${listingId} order by amount desc, placed_at limit 200
  `
  return rows.map(toBid)
}

/**
 * Auctions whose end has passed and which are still open. The close sweep's read.
 *
 * `now()` in the database, for the reason in the clock-domain note on `bids.placed_at`.
 */
export async function dueAuctions(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from listings
     where status = 'active' and pricing_mode = 'auction'
       and auction_ends_at is not null and auction_ends_at <= now()
     order by auction_ends_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

/* ------------------------------------------------------------------ offers */

export interface Offer {
  readonly id: string
  readonly listingId: string
  readonly offererSubject: string
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly escrowId: string | null
  readonly status: OfferStatus
  readonly expiresAt: Date | null
  readonly createdAt: Date
  readonly resolvedAt: Date | null
}

interface OfferRow {
  readonly id: string
  readonly listing_id: string
  readonly offerer_subject: string
  readonly amount: string
  readonly asset_code: string
  readonly escrow_id: string | null
  readonly status: OfferStatus
  readonly expires_at: Date | null
  readonly created_at: Date
  readonly resolved_at: Date | null
}

const OFFER_COLUMNS = `id, listing_id, offerer_subject, amount::text as amount, asset_code,
                       escrow_id, status, expires_at, created_at, resolved_at`

function toOffer(row: OfferRow): Offer {
  return {
    id: row.id,
    listingId: row.listing_id,
    offererSubject: row.offerer_subject,
    amount: BigInt(row.amount),
    assetCode: row.asset_code as LedgerAssetCode,
    escrowId: row.escrow_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

/**
 * Make an offer, escrowing the money behind it.
 *
 * An offer holds funds exactly as a bid does, for the same reason: a seller who accepts an offer
 * must not then discover the buyer cannot pay. `offers_open_uniq` makes a second open offer from
 * the same buyer on the same listing impossible — otherwise a buyer with one intent to buy has N
 * escrows and a mysteriously empty spendable balance.
 */
export async function makeOffer(
  deps: BidDeps,
  input: {
    readonly listingId: string
    readonly offererSubject: string
    readonly amount: bigint
    readonly expiresAt?: Date | null
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<Offer> {
  if (input.amount <= 0n) throw new BidError('an offer must be positive')

  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<ListingRowShape[]>`
      select ${tx.unsafe(LISTING_COLUMNS)} from listings where id = ${input.listingId} for update
    `
    const row = claimed[0]
    if (!row) throw new ListingStateError('no such listing')
    const listing = toListing(row)
    if (listing.frozen) throw new FrozenError()
    if (listing.status !== 'active') throw new ListingStateError(`this listing is ${listing.status}`)
    if (listing.pricingMode === 'auction') {
      throw new BidError('this listing is an auction; place a bid')
    }
    if (listing.sellerSubject === input.offererSubject) {
      throw new BidError('a seller may not offer on their own listing')
    }

    const inserted = await tx<OfferRow[]>`
      insert into offers (listing_id, offerer_subject, amount, asset_code, expires_at)
      values (${listing.id}, ${input.offererSubject}, ${input.amount.toString()},
              ${listing.assetCode}, ${input.expiresAt ?? null})
      returning ${tx.unsafe(OFFER_COLUMNS)}
    `
    const offerRow = inserted[0]
    if (!offerRow) throw new BidError('the offer was not written')

    const escrow = await holdEscrow(tx, deps.ledger, {
      listingId: listing.id,
      kind: 'offer_funds',
      subject: input.offererSubject,
      assetCode: listing.assetCode,
      amount: input.amount,
      offerId: offerRow.id,
      idempotencyKey: idempotencyKeys.reserveOffer(offerRow.id),
      actor: input.actor,
      correlationId: input.correlationId,
      description: `escrow ${input.amount} ${listing.assetCode} for offer ${offerRow.id}`,
    })
    const withEscrow = await tx<OfferRow[]>`
      update offers set escrow_id = ${escrow.id} where id = ${offerRow.id}
      returning ${tx.unsafe(OFFER_COLUMNS)}
    `
    const finalRow = withEscrow[0]
    if (!finalRow) throw new BidError('the offer vanished under its own transaction')

    await emitOn(tx, deps.producer, {
      topic: OFFER_MADE_TOPIC,
      key: listing.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        listingId: listing.id,
        offerId: offerRow.id,
        offererSubject: input.offererSubject,
        // THE PERSON THE NOTIFICATION IS FOR. Everything else on this envelope names the OFFERER:
        // the actor is them, `offererSubject` is them, and the key is the listing. So the only
        // subject a consumer could resolve was the person who made the offer, and the one
        // notification this event exists to produce — "somebody offered on your listing" — would
        // have gone to the offerer telling them their own offer arrived. `micro-notify` declined
        // to write a rule for exactly that reason (`UNPRODUCED_NOTIFICATIONS`, "marketplace offer
        // received", `blockedBy: 'no-subject'`), which was the right refusal: a notification sent
        // to the wrong person about someone else's money is worse than no notification.
        //
        // Read from the listing row this transaction already holds `for update` (the `select … for
        // update` that opens this transaction), so it
        // is the seller AT THE MOMENT THE OFFER WAS MADE rather than whoever the listing belongs
        // to when a consumer gets round to reading it.
        //
        // It is a SUBJECT, not a user id — `user:<uuid>` or `service:<name>`, exactly as
        // `offererSubject` beside it and `sellerSubject` on `market.order.paid_out` already are.
        // A listing may be owned by a service principal (`server.ts` takes the seller from
        // `subjectOf(principal)`, which spells a service `service:<name>`), and a consumer that
        // stripped the prefix blindly would address a notification to a service name. Never null
        // and never empty: `listings.seller_subject` is `not null`, and the self-offer refusal
        // three lines above proves it is also never the offerer.
        sellerSubject: listing.sellerSubject,
        amount: input.amount.toString(),
        assetCode: listing.assetCode,
      },
    })
    return { value: toOffer(finalRow) }
  })
  return outcome.value
}

/**
 * Withdraw or decline an open offer, releasing its escrow exactly once.
 *
 * One function for both because the state change and the refund are identical; only who asked
 * differs, and that is the caller's business rather than this one's.
 */
export async function closeOffer(
  deps: BidDeps,
  input: {
    readonly offerId: string
    readonly to: 'withdrawn' | 'declined' | 'expired'
    /** When set, only this subject's own offer may be closed. */
    readonly offererSubject?: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<Offer> {
  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<OfferRow[]>`
      select ${tx.unsafe(OFFER_COLUMNS)} from offers where id = ${input.offerId} for update
    `
    const row = claimed[0]
    if (!row) throw new ListingStateError('no such offer')
    const offer = toOffer(row)
    if (input.offererSubject !== undefined && offer.offererSubject !== input.offererSubject) {
      throw new ListingStateError('no such offer')
    }
    // Already closed. Idempotent rather than an error: a client retrying a withdrawal it already
    // made is doing the right thing, and telling it "no" would make it retry harder.
    if (offer.status !== 'open') return { value: offer }

    if (offer.escrowId) {
      await releaseEscrow(
        tx,
        { ledger: deps.ledger, actor: input.actor, correlationId: input.correlationId },
        offer.escrowId,
      )
    }
    const updated = await tx<OfferRow[]>`
      update offers set status = ${input.to}, resolved_at = now()
       where id = ${offer.id} and status = 'open'
      returning ${tx.unsafe(OFFER_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new BidError('the offer changed state under its own row lock')
    return { value: toOffer(after) }
  })
  return outcome.value
}

export async function findOffer(sql: Db | Tx, id: string): Promise<Offer | null> {
  const rows = await sql<OfferRow[]>`
    select ${sql.unsafe(OFFER_COLUMNS)} from offers where id = ${id}
  `
  const row = rows[0]
  return row ? toOffer(row) : null
}

export async function listOffers(sql: Db, listingId: string): Promise<readonly Offer[]> {
  const rows = await sql<OfferRow[]>`
    select ${sql.unsafe(OFFER_COLUMNS)} from offers
     where listing_id = ${listingId} order by amount desc, created_at limit 200
  `
  return rows.map(toOffer)
}

/** Open offers whose expiry has passed. The expiry sweep's read; the database's clock. */
export async function expiredOffers(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from offers
     where status = 'open' and expires_at is not null and expires_at <= now()
     order by expires_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}
