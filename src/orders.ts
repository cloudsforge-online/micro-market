/**
 * Settlement. The one place in this service where a sale becomes real.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONE LISTING SETTLES ONCE, AND FOUR INDEPENDENT THINGS SAY SO.**
 *
 *   1. **The status claim.** `update listings set status = 'settling' where id = $1 and
 *      status = 'active' and frozen = false returning …`. The first transaction takes the row
 *      lock; the second blocks, re-evaluates `status = 'active'` against the committed version,
 *      and gets zero rows. This is the design, and it is why the claim is an UPDATE with a
 *      predicate rather than a SELECT followed by an UPDATE — the gap between those two is the
 *      whole bug.
 *   2. **The derived ledger key**, `market:settle:<listingId>`. Derived from the LISTING, which
 *      exists before the money moves, rather than from the order, which does not exist until the
 *      transaction that would create it. A key derived from the order would be a different key on
 *      every retry and would pay twice.
 *   3. **`orders_listing_uniq`.** One listing, at most one order row, enforced by Postgres.
 *   4. **`captureEscrow`**, which refuses an escrow that is not `held`. If two settlements
 *      somehow both reached this point, the second could not consume funds the first had spent.
 *
 * Four, because this is the class of bug `settlement` proved with a chain-keyed lease: two
 * workers, one nonce, one payment permanently lost. Here the equivalent is two orders against one
 * item — one buyer charged for something the other received.
 *
 * **AND THE FIFTH, WHICH IS NOT A DEFENCE BUT A DIFFERENT KIND OF ANSWER.** A settlement that
 * arrives at a listing already `sold` returns the ORDER THAT EXISTS, marked `replayed`. That is
 * not an error: it is a client retrying after a lost response, and telling it "conflict" would
 * make it retry harder or, worse, tell a customer their purchase failed when it succeeded.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The freeze is a WHERE clause, not an `if`
 *
 * `and frozen = false` sits in the claim itself. A moderation case sets the flag in the same
 * transaction as the case, so there is no instant at which a frozen listing is settleable. The
 * obvious alternative — read the moderation table, decide, then settle — has a window between the
 * decision and the write in which a freeze can land, and a freeze that can be raced is not a
 * freeze.
 *
 * ## A sale is ONE ledger entry
 *
 * See `ledgerclient.ts`. The buyer's payment, the seller's proceeds, the platform fee, every
 * royalty share and the item itself are legs of a single balanced entry. Two entries would admit
 * a state where the sale committed and the royalty did not.
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Db, Tx } from './outbox.ts'
import { emitOn } from './outbox.ts'
import {
  captureEscrow,
  recordEscrowFromEntry,
  releaseEscrow,
  type Escrow,
  type ReleaseDeps,
} from './escrow.ts'
import {
  idempotencyKeys,
  settlePostings,
  type LedgerClient,
} from './ledgerclient.ts'
import { splitSale, type SaleSplit } from './money.ts'
import {
  FrozenError,
  ListingStateError,
  SOLD_TOPIC,
  listingRoyalties,
  toListing,
  type Listing,
} from './listings.ts'
import { holdEscrow } from './escrow.ts'

export const PAID_OUT_TOPIC = 'market.order.paid_out'

/*
 * `market.order.refunded` WAS declared here and no code path ever emitted it.
 *
 * It is deleted rather than wired up, because the fact it names is already on the wire and has
 * been all along: a refund in this service IS a dispute resolution, and `market.dispute.resolved`
 * (moderation.ts) carries `resolution: 'refunded'` together with `reversalEntryId` — the
 * ledger reversal the money actually moved through. A second topic for the same fact would be a
 * name a consumer could subscribe to and never once receive, which is the `emitSessionRevoked`
 * shape: a topic produced by nothing, whose subscribers are dead code that no test can see.
 *
 * The general lesson is now a check rather than a comment: `topics.test.ts` reads the topic
 * literals back out of `src/` and fails on a declared topic that no emit site produces.
 */

export type OrderSource = 'purchase' | 'auction' | 'offer'

export class OrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

/** The auction ended below its reserve. Not a failure — the seller's floor did its job. */
export class ReserveNotMetError extends OrderError {
  constructor(reserve: bigint, best: bigint | null) {
    super(`the best bid ${best ?? 0n} did not reach the reserve of ${reserve}`)
    this.name = 'ReserveNotMetError'
  }
}

export interface Order {
  readonly id: string
  readonly listingId: string
  readonly buyerSubject: string
  readonly sellerSubject: string
  readonly itemUrn: string
  readonly itemAssetCode: LedgerAssetCode
  readonly quantity: bigint
  readonly amount: bigint
  readonly feeAmount: bigint
  readonly royaltyAmount: bigint
  readonly sellerProceeds: bigint
  readonly assetCode: LedgerAssetCode
  readonly settlementMode: 'custodial' | 'onchain'
  readonly journalEntryId: string | null
  readonly outboundTransactionId: string | null
  readonly source: OrderSource
  readonly proceedsState: 'held' | 'released'
  readonly payoutDueAt: Date | null
  readonly payoutEntryId: string | null
  readonly settledAt: Date
  readonly royalties: readonly { subject: string; amount: bigint }[]
}

interface OrderRow {
  readonly id: string
  readonly listing_id: string
  readonly buyer_subject: string
  readonly seller_subject: string
  readonly item_urn: string
  readonly item_asset_code: string
  readonly quantity: string
  readonly amount: string
  readonly fee_amount: string
  readonly royalty_amount: string
  readonly seller_proceeds: string
  readonly asset_code: string
  readonly settlement_mode: 'custodial' | 'onchain'
  readonly journal_entry_id: string | null
  readonly outbound_transaction_id: string | null
  readonly source: OrderSource
  readonly proceeds_state: 'held' | 'released'
  readonly payout_due_at: Date | null
  readonly payout_entry_id: string | null
  readonly settled_at: Date
}

const ORDER_COLUMNS = `id, listing_id, buyer_subject, seller_subject, item_urn, item_asset_code,
  quantity::text as quantity, amount::text as amount, fee_amount::text as fee_amount,
  royalty_amount::text as royalty_amount, seller_proceeds::text as seller_proceeds, asset_code,
  settlement_mode, journal_entry_id, outbound_transaction_id, source, proceeds_state,
  payout_due_at, payout_entry_id, settled_at`

const LISTING_COLUMNS = `id, seller_subject, seller_wallet_id, collection_id, asset_kind, item_urn,
  quantity::text as quantity, item_asset_code, pricing_mode, price::text as price,
  reserve_price::text as reserve_price, asset_code, settlement_mode, royalty_bps, platform_fee_bps,
  auction_ends_at, expires_at, status, frozen, escrow_id, onchain_escrow_tx,
  dispute_window_ms::text as dispute_window_ms, created_at, activated_at, ended_at`

function toOrder(row: OrderRow, royalties: readonly { subject: string; amount: bigint }[]): Order {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerSubject: row.buyer_subject,
    sellerSubject: row.seller_subject,
    itemUrn: row.item_urn,
    itemAssetCode: row.item_asset_code as LedgerAssetCode,
    quantity: BigInt(row.quantity),
    amount: BigInt(row.amount),
    feeAmount: BigInt(row.fee_amount),
    royaltyAmount: BigInt(row.royalty_amount),
    sellerProceeds: BigInt(row.seller_proceeds),
    assetCode: row.asset_code as LedgerAssetCode,
    settlementMode: row.settlement_mode,
    journalEntryId: row.journal_entry_id,
    outboundTransactionId: row.outbound_transaction_id,
    source: row.source,
    proceedsState: row.proceeds_state,
    payoutDueAt: row.payout_due_at,
    payoutEntryId: row.payout_entry_id,
    settledAt: row.settled_at,
    royalties,
  }
}

export interface OrderDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
}

export interface SettleResult {
  readonly order: Order
  readonly listing: Listing
  readonly split: SaleSplit
  /** True when the listing was already sold and this is the order that already existed. */
  readonly replayed: boolean
}

export interface SettleInput {
  readonly listingId: string
  readonly buyerSubject: string
  readonly amount: bigint
  readonly source: OrderSource
  /**
   * The buyer's already-held funds escrow, for an auction or an accepted offer. Omitted for a
   * fixed-price purchase, which reserves the funds inside the settlement transaction.
   */
  readonly fundsEscrowId?: string | null
  /** The offer being accepted, so it is marked `accepted` in the same transaction as the sale. */
  readonly offerId?: string | null
  /** For `onchain` settlement: the confirmed transaction that moved the item. Never signed here. */
  readonly onchainTransactionId?: string | null
  readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
  readonly correlationId: string
}

/**
 * Settle a sale.
 *
 * Every path — buy-now, auction close, offer acceptance — comes through here, so there is exactly
 * one implementation of "money moves and an order exists" and exactly one thing to test.
 */
export async function settleSale(deps: OrderDeps, input: SettleInput): Promise<SettleResult> {
  const outcome = await deps.sql.begin(async (tx) => {
    // 1. THE CLAIM. An UPDATE with a predicate, not a SELECT then an UPDATE. See the file header.
    const claimed = await tx<ListingRowShape[]>`
      update listings
         set status = 'settling', updated_at = now()
       where id = ${input.listingId} and status = 'active' and frozen = false
      returning ${tx.unsafe(LISTING_COLUMNS)}
    `
    const claimedRow = claimed[0]
    if (!claimedRow) {
      // Nothing was claimed. Work out why, because the three reasons need three different answers.
      const existing = await tx<ListingRowShape[]>`
        select ${tx.unsafe(LISTING_COLUMNS)} from listings where id = ${input.listingId}
      `
      const row = existing[0]
      if (!row) throw new ListingStateError('no such listing')
      const listing = toListing(row)
      if (listing.frozen) throw new FrozenError()
      if (listing.status === 'sold' || listing.status === 'settling') {
        const replayed = await loadOrderByListing(tx, listing.id)
        // A settlement in flight has claimed the listing but not yet written its order. The honest
        // answer is "ask again", not "no order exists" — which a client would read as a failure.
        if (!replayed) throw new ListingStateError('this listing is being settled; retry shortly')
        return {
          value: {
            order: replayed,
            listing,
            split: splitFromOrder(replayed),
            replayed: true,
          } satisfies SettleResult,
        }
      }
      throw new ListingStateError(`a ${listing.status} listing cannot be bought`)
    }

    const listing = toListing(claimedRow)
    if (listing.sellerSubject === input.buyerSubject) {
      throw new OrderError('a seller may not buy their own listing')
    }
    if (input.source === 'purchase') {
      if (listing.pricingMode !== 'fixed') {
        throw new ListingStateError('this listing is not sold at a fixed price')
      }
      // The buyer pays what the listing says, exactly. Not "at least": accepting an overpayment
      // silently would take money nobody asked for, and the ledger would balance perfectly while
      // doing it.
      if (input.amount !== listing.price) {
        throw new OrderError(`this listing costs ${listing.price ?? 0n}, not ${input.amount}`)
      }
    }

    // 2. The arithmetic. bigint throughout, and the seller's proceeds are the remainder — so the
    //    three parts sum to the price for every price and every pair of rates. See money.ts.
    const recipients = await listingRoyalties(tx, listing.id)
    const split = splitSale({
      price: input.amount,
      platformFeeBps: listing.platformFeeBps,
      royaltyBps: listing.royaltyBps,
      royaltyRecipients: recipients,
    })

    const releaseDeps: ReleaseDeps = {
      ledger: deps.ledger,
      actor: input.actor,
      correlationId: input.correlationId,
    }

    let journalEntryId: string | null = null
    let fundsEscrow: Escrow | null = null
    const holdProceeds = listing.settlementMode === 'custodial' && listing.disputeWindowMs > 0

    if (listing.settlementMode === 'custodial') {
      // 3. The buyer's funds. Already escrowed for an auction or an offer; reserved here for a
      //    fixed-price purchase, in the same transaction, so a buyer who cannot pay is refused
      //    before the listing is marked sold rather than after.
      if (input.fundsEscrowId) {
        fundsEscrow = await requireHeldEscrow(tx, input.fundsEscrowId)
        if (fundsEscrow.amount !== input.amount) {
          throw new OrderError('the escrowed amount does not match the settlement amount')
        }
      } else {
        fundsEscrow = await holdEscrow(tx, deps.ledger, {
          listingId: listing.id,
          kind: 'bid_funds',
          subject: input.buyerSubject,
          assetCode: listing.assetCode,
          amount: input.amount,
          // Derived from the LISTING and the buyer, not from a row that does not exist yet.
          idempotencyKey: `${idempotencyKeys.settle(listing.id)}:funds:${input.buyerSubject}`,
          actor: input.actor,
          correlationId: input.correlationId,
          description: `escrow ${input.amount} ${listing.assetCode} to buy listing ${listing.id}`,
        })
      }

      // 4. ONE entry. Buyer's payment, seller's proceeds, platform fee, every royalty share, and
      //    the item — all legs of the same balanced entry, which cannot half-commit.
      const entry = await deps.ledger.postEntry({
        kind: 'market_settled',
        actor: input.actor,
        correlationId: input.correlationId,
        idempotencyKey: idempotencyKeys.settle(listing.id),
        description: `settle listing ${listing.id}: ${listing.quantity} × ${listing.itemUrn}`,
        postings: settlePostings({
          buyerSubject: input.buyerSubject,
          sellerSubject: listing.sellerSubject,
          assetCode: listing.assetCode,
          itemAssetCode: listing.itemAssetCode,
          quantity: listing.quantity,
          split,
          proceedsPurpose: holdProceeds ? 'payout_due' : 'available',
        }),
      })
      journalEntryId = entry.id
    } else if (!input.onchainTransactionId) {
      throw new OrderError('an on-chain settlement must name the confirmed transaction')
    }

    // 5. The order. `orders_listing_uniq` and `orders_partition` are both checked here.
    const inserted = await tx<OrderRow[]>`
      insert into orders (
        listing_id, buyer_subject, seller_subject, item_urn, item_asset_code, quantity, amount,
        fee_amount, royalty_amount, seller_proceeds, asset_code, settlement_mode,
        journal_entry_id, outbound_transaction_id, source, proceeds_state, payout_due_at,
        settled_at
      ) values (
        ${listing.id}, ${input.buyerSubject}, ${listing.sellerSubject}, ${listing.itemUrn},
        ${listing.itemAssetCode}, ${listing.quantity.toString()}, ${split.price.toString()},
        ${split.platformFee.toString()}, ${split.royaltyTotal.toString()},
        ${split.sellerProceeds.toString()}, ${listing.assetCode}, ${listing.settlementMode},
        ${journalEntryId}, ${input.onchainTransactionId ?? null}, ${input.source},
        ${holdProceeds ? 'held' : 'released'},
        ${holdProceeds ? tx`now() + make_interval(secs => ${listing.disputeWindowMs / 1000})` : null},
        now()
      )
      returning ${tx.unsafe(ORDER_COLUMNS)}
    `
    const orderRow = inserted[0]
    if (!orderRow) throw new OrderError('the order was not written')

    for (const share of split.royaltyShares) {
      await tx`
        insert into order_royalties (order_id, subject, amount)
        values (${orderRow.id}, ${share.subject}, ${share.amount.toString()})
      `
    }

    // 6. Consume the two escrows this sale spent. `captureEscrow` refuses one that is not held, so
    //    a second settlement could not spend funds the first already used.
    if (journalEntryId) {
      if (fundsEscrow) await captureEscrow(tx, fundsEscrow.id, journalEntryId, orderRow.id)
      if (listing.escrowId) await captureEscrow(tx, listing.escrowId, journalEntryId, orderRow.id)
      if (holdProceeds) {
        // The proceeds are the seller's and are not yet spendable. The escrow row points at the
        // settlement entry, because that entry is what put them in `payout_due` — no second
        // posting is made, and making one would move the money twice.
        await recordEscrowFromEntry(tx, {
          listingId: listing.id,
          kind: 'proceeds',
          subject: listing.sellerSubject,
          assetCode: listing.assetCode,
          amount: split.sellerProceeds,
          orderId: orderRow.id,
          holdEntryId: journalEntryId,
        })
      }
    }

    // 7. Everyone who did not win gets their money back, now, not eventually. A losing bidder
    //    whose funds stay reserved cannot spend them and has nothing to look at that says why.
    const losing = await tx<{ id: string }[]>`
      select id from escrows
       where listing_id = ${listing.id} and state = 'held'
         and kind in ('bid_funds','offer_funds')
       order by held_at
    `
    for (const escrow of losing) {
      await releaseEscrow(tx, releaseDeps, escrow.id)
    }
    if (input.offerId) {
      await tx`
        update offers set status = 'accepted', resolved_at = now()
         where id = ${input.offerId} and listing_id = ${listing.id} and status = 'open'
      `
    }
    await tx`update bids set status = 'lost' where listing_id = ${listing.id} and status = 'outbid'`
    await tx`
      update bids set status = 'won'
       where listing_id = ${listing.id} and status = 'leading'
         and (${fundsEscrow?.id ?? null}::uuid is null or escrow_id = ${fundsEscrow?.id ?? null})
    `
    await tx`
      update offers set status = 'declined', resolved_at = now()
       where listing_id = ${listing.id} and status = 'open'
         and (${fundsEscrow?.id ?? null}::uuid is null or escrow_id is distinct from ${fundsEscrow?.id ?? null})
    `

    // 8. The listing is done.
    const sold = await tx<ListingRowShape[]>`
      update listings set status = 'sold', ended_at = now(), updated_at = now()
       where id = ${listing.id} and status = 'settling'
      returning ${tx.unsafe(LISTING_COLUMNS)}
    `
    const soldRow = sold[0]
    if (!soldRow) throw new OrderError('the listing changed state under its own claim')

    const order = toOrder(orderRow, [...split.royaltyShares])
    // 9. The event, in the same transaction. worlds, billing, ledger, activity, notify and
    //    analytics all read this one — 07-dependency-map. It is what hands a game item to its new
    //    owner and what grants a platform-native entitlement (AD-14).
    await emitOn(tx, deps.producer, {
      topic: SOLD_TOPIC,
      key: listing.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: orderEventPayload(order),
    })

    return { value: { order, listing: toListing(soldRow), split, replayed: false } satisfies SettleResult }
  })
  return outcome.value
}

type ListingRowShape = Parameters<typeof toListing>[0]

async function requireHeldEscrow(tx: Tx, id: string): Promise<Escrow> {
  const rows = await tx<
    Array<{
      id: string
      listing_id: string
      kind: Escrow['kind']
      subject: string
      asset_code: string
      amount: string
      state: Escrow['state']
    }>
  >`
    select id, listing_id, kind, subject, asset_code, amount::text as amount, state
      from escrows where id = ${id} for update
  `
  const row = rows[0]
  if (!row) throw new OrderError('the buyer has no escrow for this sale')
  if (row.state !== 'held') throw new OrderError('the buyer’s escrow has already been spent')
  return {
    id: row.id,
    listingId: row.listing_id,
    kind: row.kind,
    subject: row.subject,
    assetCode: row.asset_code as LedgerAssetCode,
    amount: BigInt(row.amount),
    bidId: null,
    offerId: null,
    orderId: null,
    state: row.state,
    holdEntryId: '',
    settleEntryId: null,
    heldAt: new Date(0),
    settledAt: null,
  }
}

/**
 * Rebuild the split from a stored order, for the replay path.
 *
 * Read from the ORDER's own columns rather than recomputed from the rates. The rates could have
 * been edited on the listing since — they cannot, because `listings` has no route that changes
 * them, but "cannot today" is not an argument — and more importantly the stored amounts are what
 * actually moved. A replay must describe the sale that happened, not the sale the rates imply.
 */
function splitFromOrder(order: Order): SaleSplit {
  return {
    price: order.amount,
    platformFee: order.feeAmount,
    royaltyTotal: order.royaltyAmount,
    sellerProceeds: order.sellerProceeds,
    royaltyShares: order.royalties,
  }
}

export function orderEventPayload(order: Order): Record<string, unknown> {
  return {
    orderId: order.id,
    listingId: order.listingId,
    buyerSubject: order.buyerSubject,
    sellerSubject: order.sellerSubject,
    itemUrn: order.itemUrn,
    // Every amount a decimal STRING. A JSON number is an IEEE 754 double and a large amount does
    // not survive one — it comes back subtly wrong rather than failing.
    quantity: order.quantity.toString(),
    amount: order.amount.toString(),
    feeAmount: order.feeAmount.toString(),
    royaltyAmount: order.royaltyAmount.toString(),
    sellerProceeds: order.sellerProceeds.toString(),
    assetCode: order.assetCode,
    settlementMode: order.settlementMode,
    journalEntryId: order.journalEntryId,
    outboundTransactionId: order.outboundTransactionId,
    source: order.source,
    royalties: order.royalties.map((share) => ({
      subject: share.subject,
      amount: share.amount.toString(),
    })),
  }
}

async function loadOrderByListing(sql: Db | Tx, listingId: string): Promise<Order | null> {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLUMNS)} from orders where listing_id = ${listingId}
  `
  const row = rows[0]
  if (!row) return null
  return toOrder(row, await orderRoyalties(sql, row.id))
}

export async function findOrder(sql: Db | Tx, id: string): Promise<Order | null> {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLUMNS)} from orders where id = ${id}
  `
  const row = rows[0]
  if (!row) return null
  return toOrder(row, await orderRoyalties(sql, row.id))
}

export async function orderRoyalties(
  sql: Db | Tx,
  orderId: string,
): Promise<readonly { subject: string; amount: bigint }[]> {
  const rows = await sql<{ subject: string; amount: string }[]>`
    select subject, amount::text as amount from order_royalties
     where order_id = ${orderId} order by subject
  `
  return rows.map((row) => ({ subject: row.subject, amount: BigInt(row.amount) }))
}

export async function listOrders(
  sql: Db,
  query: { readonly buyerSubject?: string; readonly sellerSubject?: string; readonly limit?: number } = {},
): Promise<readonly Order[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLUMNS)} from orders
     where (${query.buyerSubject ?? null}::text is null
            or buyer_subject = ${query.buyerSubject ?? null})
       and (${query.sellerSubject ?? null}::text is null
            or seller_subject = ${query.sellerSubject ?? null})
     order by settled_at desc
     limit ${limit}
  `
  return Promise.all(rows.map(async (row) => toOrder(row, await orderRoyalties(sql, row.id))))
}

/* ------------------------------------------------------------------ the auction close */

export interface CloseResult {
  readonly listingId: string
  readonly outcome: 'settled' | 'no_bids' | 'reserve_not_met' | 'not_due' | 'already_closed'
  readonly order: Order | null
}

/**
 * Close one auction: pick the winner, settle, refund everyone else.
 *
 * **Safe to run from two workers at once.** The claim in `settleSale` is what makes it so, and
 * `jobs.ts` keys the lease on `auction:<listingId>` — the auction, which is the contended
 * resource, rather than the stream, which is not. `auctions.test.ts` runs two workers against one
 * auction and asserts exactly one order and exactly one non-replayed ledger settlement.
 *
 * A reserve that is not met is an OUTCOME, not a failure: the listing expires, every bid is
 * refunded, and the seller keeps the item. Treating it as an error would dead-letter the job and
 * leave every bidder's funds reserved against an auction nobody will ever close.
 */
export async function closeAuction(
  deps: OrderDeps,
  input: {
    readonly listingId: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<CloseResult> {
  const rows = await deps.sql<
    Array<{ status: string; reserve_price: string | null; due: boolean }>
  >`
    select status, reserve_price::text as reserve_price,
           (auction_ends_at is not null and auction_ends_at <= now()) as due
      from listings where id = ${input.listingId}
  `
  const row = rows[0]
  if (!row) throw new ListingStateError('no such listing')
  if (row.status !== 'active') {
    return { listingId: input.listingId, outcome: 'already_closed', order: null }
  }
  if (!row.due) return { listingId: input.listingId, outcome: 'not_due', order: null }

  const leaders = await deps.sql<Array<{ id: string; amount: string; escrow_id: string | null; bidder_subject: string }>>`
    select id, amount::text as amount, escrow_id, bidder_subject
      from bids where listing_id = ${input.listingId} and status = 'leading'
  `
  const leader = leaders[0]
  const reserve = row.reserve_price === null ? null : BigInt(row.reserve_price)

  if (!leader) {
    await expireUnsold(deps, input, 'no bids')
    return { listingId: input.listingId, outcome: 'no_bids', order: null }
  }
  const best = BigInt(leader.amount)
  if (reserve !== null && best < reserve) {
    await expireUnsold(deps, input, 'the reserve was not met')
    return { listingId: input.listingId, outcome: 'reserve_not_met', order: null }
  }

  const settled = await settleSale(deps, {
    listingId: input.listingId,
    buyerSubject: leader.bidder_subject,
    amount: best,
    source: 'auction',
    fundsEscrowId: leader.escrow_id,
    actor: input.actor,
    correlationId: input.correlationId,
  })
  return {
    listingId: input.listingId,
    // A replayed settlement means another worker got there first. Reported as `already_closed`
    // rather than `settled` so the job's log line does not claim to have made a sale it did not.
    outcome: settled.replayed ? 'already_closed' : 'settled',
    order: settled.order,
  }
}

async function expireUnsold(
  deps: OrderDeps,
  input: {
    readonly listingId: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
  reason: string,
): Promise<void> {
  // Routed through `endListing` rather than reimplemented, so an unsold auction releases the item
  // AND every bid escrow by the same code that a cancellation does. An expiry path that forgot
  // the bids would leave every bidder's funds reserved for ever against a listing that is over.
  const { endListing } = await import('./listings.ts')
  await endListing(
    { sql: deps.sql, ledger: deps.ledger, producer: deps.producer },
    {
      listingId: input.listingId,
      to: 'expired',
      reason,
      actor: input.actor,
      correlationId: input.correlationId,
    },
  )
}

/* ------------------------------------------------------------------ the payout */

export type PayoutOutcome = 'paid' | 'not_due' | 'already_paid' | 'disputed' | 'missing'

/**
 * Release a seller's proceeds from `payout_due` to `available`, once the dispute window has run.
 *
 * **An open dispute blocks it, in the same statement that claims it.** Not "checked first, then
 * claimed": a dispute raised between the check and the claim would be ignored, and the money
 * would be spendable while the argument about it was still running.
 *
 * Exactly once, because `releaseEscrow` is exactly once and the order's `proceeds_state` is
 * claimed under the same row lock.
 */
export async function releaseProceeds(
  deps: OrderDeps,
  input: {
    readonly orderId: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<{ outcome: PayoutOutcome; order: Order | null }> {
  const outcome = await deps.sql.begin(async (tx) => {
    const rows = await tx<Array<OrderRow & { due: boolean; disputed: boolean }>>`
      select ${tx.unsafe(ORDER_COLUMNS)},
             (payout_due_at is not null and payout_due_at <= now()) as due,
             exists (
               select 1 from disputes d where d.order_id = orders.id and d.state = 'open'
             ) as disputed
        from orders where id = ${input.orderId}
         for update
    `
    const row = rows[0]
    if (!row) return { value: { outcome: 'missing' as PayoutOutcome, order: null } }
    if (row.proceeds_state === 'released') {
      return {
        value: {
          outcome: 'already_paid' as PayoutOutcome,
          order: toOrder(row, await orderRoyalties(tx, row.id)),
        },
      }
    }
    if (row.disputed) {
      return {
        value: {
          outcome: 'disputed' as PayoutOutcome,
          order: toOrder(row, await orderRoyalties(tx, row.id)),
        },
      }
    }
    if (!row.due) {
      return {
        value: {
          outcome: 'not_due' as PayoutOutcome,
          order: toOrder(row, await orderRoyalties(tx, row.id)),
        },
      }
    }

    const escrows = await tx<{ id: string }[]>`
      select id from escrows where order_id = ${row.id} and kind = 'proceeds' and state = 'held'
    `
    const escrowId = escrows[0]?.id
    if (!escrowId) {
      // `orders_held_proceeds_have_a_due_date` guarantees the order says proceeds are held, and
      // settlement writes the escrow in the same transaction as the order. Reaching here means one
      // of those two is broken, and paying out on a guess would be inventing money.
      throw new OrderError(`order ${row.id} holds proceeds with no escrow row to release`)
    }
    const released = await releaseEscrow(
      tx,
      { ledger: deps.ledger, actor: input.actor, correlationId: input.correlationId },
      escrowId,
    )
    const entryId = released.status === 'missing' ? null : released.escrow.settleEntryId

    const updated = await tx<OrderRow[]>`
      update orders set proceeds_state = 'released', payout_entry_id = ${entryId}
       where id = ${row.id} and proceeds_state = 'held'
      returning ${tx.unsafe(ORDER_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new OrderError('the order changed state under its own row lock')
    const order = toOrder(after, await orderRoyalties(tx, after.id))
    await emitOn(tx, deps.producer, {
      topic: PAID_OUT_TOPIC,
      key: order.listingId,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        orderId: order.id,
        sellerSubject: order.sellerSubject,
        amount: order.sellerProceeds.toString(),
        assetCode: order.assetCode,
        payoutEntryId: order.payoutEntryId,
      },
    })
    return { value: { outcome: 'paid' as PayoutOutcome, order } }
  })
  return outcome.value
}

/** Orders whose dispute window has run and which nobody is arguing about. The payout sweep. */
export async function duePayouts(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select o.id from orders o
     where o.proceeds_state = 'held'
       and o.payout_due_at is not null and o.payout_due_at <= now()
       and not exists (select 1 from disputes d where d.order_id = o.id and d.state = 'open')
     order by o.payout_due_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}
