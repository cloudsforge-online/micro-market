/**
 * Escrow: the reference, and its exactly-once lifecycle.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ESCROW ROW IS A POINTER AT A LEDGER RESERVATION. IT IS NOT A BALANCE.**
 *
 * `hold_entry_id` is the journal entry that moved the value from `available` to `reserved`.
 * `settle_entry_id` is the entry that moved it back, or into a sale. This service never adds
 * anything up. 04-domain-model §11 — no user balance column anywhere outside the ledger's
 * projection — and if `amount` ever starts being decremented in place, market has become a second
 * ledger and the trial balance has stopped meaning anything.
 *
 * **RELEASED EXACTLY ONCE, AND THERE ARE THREE INDEPENDENT REASONS IT IS.**
 *
 *   1. `select … for update` on the escrow row. Two concurrent releasers serialise; the loser
 *      re-evaluates `state = 'held'` against the committed row version, finds nothing, and
 *      answers "already released" without calling the ledger at all. This is the design.
 *   2. The ledger's idempotency key is `market:release:<escrowId>` — DERIVED, so even if both
 *      callers reached it, the second is answered from the stored response and posts nothing.
 *   3. `escrows_held_has_no_settlement` and `escrows_settled_names_entry`. A row cannot be
 *      released without naming its entry, and cannot hold one while still held.
 *
 * Three, because the cost of a double release is that a bidder is refunded twice — real money,
 * created out of nothing, invisible until the trial balance goes non-zero and by then spread
 * across every refund since the bug shipped.
 *
 * **THE LEDGER CALL HAPPENS INSIDE THE DATABASE TRANSACTION**, which means a Postgres transaction
 * is held open across a network call. That is a deliberate cost, taken for the same reason
 * `worlds/src/rewards.ts` takes it: the alternative is a window in which the row says "released"
 * and no posting exists, or a posting exists and no row says so. The upstream deadline bounds how
 * long the transaction can be held; a ledger that is slow enough to matter is an incident either
 * way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Db, Tx } from './outbox.ts'
import {
  idempotencyKeys,
  payoutPostings,
  releasePostings,
  reservePostings,
  type LedgerClient,
} from './ledgerclient.ts'

export type EscrowKind = 'listing_item' | 'bid_funds' | 'offer_funds' | 'proceeds'
export type EscrowState = 'held' | 'released' | 'captured'

export class EscrowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EscrowError'
  }
}

export interface Escrow {
  readonly id: string
  readonly listingId: string
  readonly kind: EscrowKind
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly bidId: string | null
  readonly offerId: string | null
  readonly orderId: string | null
  readonly state: EscrowState
  readonly holdEntryId: string
  readonly settleEntryId: string | null
  readonly heldAt: Date
  readonly settledAt: Date | null
}

interface EscrowRow {
  readonly id: string
  readonly listing_id: string
  readonly kind: EscrowKind
  readonly subject: string
  readonly asset_code: string
  readonly amount: string
  readonly bid_id: string | null
  readonly offer_id: string | null
  readonly order_id: string | null
  readonly state: EscrowState
  readonly hold_entry_id: string
  readonly settle_entry_id: string | null
  readonly held_at: Date
  readonly settled_at: Date | null
}

const COLUMNS = `id, listing_id, kind, subject, asset_code, amount::text as amount, bid_id,
                 offer_id, order_id, state, hold_entry_id, settle_entry_id, held_at, settled_at`

function toEscrow(row: EscrowRow): Escrow {
  return {
    id: row.id,
    listingId: row.listing_id,
    kind: row.kind,
    subject: row.subject,
    assetCode: row.asset_code as LedgerAssetCode,
    // `::text` then `BigInt`, never `Number`. postgres.js hands a numeric back as a string
    // already, but the cast makes that a property of the query rather than of the driver version.
    amount: BigInt(row.amount),
    bidId: row.bid_id,
    offerId: row.offer_id,
    orderId: row.order_id,
    state: row.state,
    holdEntryId: row.hold_entry_id,
    settleEntryId: row.settle_entry_id,
    heldAt: row.held_at,
    settledAt: row.settled_at,
  }
}

export interface HoldInput {
  readonly listingId: string
  readonly kind: EscrowKind
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly bidId?: string | null
  readonly offerId?: string | null
  readonly orderId?: string | null
  /** The derived key. See `idempotencyKeys` — never random, or a retry double-reserves. */
  readonly idempotencyKey: string
  readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
  readonly correlationId: string
  readonly description: string
}

/**
 * Reserve value in the ledger and record the reference, in one transaction.
 *
 * The ledger call comes FIRST, inside the transaction. If it refuses — an insufficient balance is
 * the common case, and it is an answer rather than a fault — nothing is written and the caller
 * gets a 402. If it succeeds and the transaction then rolls back, the retry presents the same
 * derived key and the ledger replays its own entry, so no value is reserved twice.
 */
export async function holdEscrow(
  tx: Tx,
  ledger: LedgerClient,
  input: HoldInput,
): Promise<Escrow> {
  if (input.amount <= 0n) throw new EscrowError('an escrow amount must be positive')

  const entry = await ledger.postEntry({
    kind: 'market_escrow',
    actor: input.actor,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    postings: reservePostings({
      subject: input.subject,
      assetCode: input.assetCode,
      amount: input.amount,
    }),
  })

  const rows = await tx<EscrowRow[]>`
    insert into escrows (listing_id, kind, subject, asset_code, amount, bid_id, offer_id,
                         order_id, hold_entry_id)
    values (${input.listingId}, ${input.kind}, ${input.subject}, ${input.assetCode},
            ${input.amount.toString()}, ${input.bidId ?? null}, ${input.offerId ?? null},
            ${input.orderId ?? null}, ${entry.id})
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new EscrowError('the escrow row was not written')
  return toEscrow(row)
}

/**
 * Record an escrow whose hold was made by an entry that already exists.
 *
 * The `proceeds` escrow is the only user. A sale's proceeds arrive in the seller's `payout_due`
 * as one leg of the settlement entry — they are not reserved by a second posting, and posting one
 * would move the money twice. So this writes the reference and names the settlement entry as the
 * hold, which is the truth: that entry is what put the value there.
 *
 * Separate from `holdEscrow` rather than a flag on it, because "make a reservation" and "point at
 * one somebody else made" are different operations and a boolean parameter that switches between
 * paying money and not paying money is the wrong shape for the difference.
 */
export async function recordEscrowFromEntry(
  tx: Tx,
  input: Omit<HoldInput, 'idempotencyKey' | 'actor' | 'correlationId' | 'description'> & {
    readonly holdEntryId: string
  },
): Promise<Escrow> {
  if (input.amount <= 0n) throw new EscrowError('an escrow amount must be positive')
  const rows = await tx<EscrowRow[]>`
    insert into escrows (listing_id, kind, subject, asset_code, amount, bid_id, offer_id,
                         order_id, hold_entry_id)
    values (${input.listingId}, ${input.kind}, ${input.subject}, ${input.assetCode},
            ${input.amount.toString()}, ${input.bidId ?? null}, ${input.offerId ?? null},
            ${input.orderId ?? null}, ${input.holdEntryId})
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new EscrowError('the escrow row was not written')
  return toEscrow(row)
}

export type ReleaseOutcome =
  | { readonly status: 'released'; readonly escrow: Escrow }
  /** It was already released or captured. Not an error — this is what idempotence looks like. */
  | { readonly status: 'already'; readonly escrow: Escrow }
  | { readonly status: 'missing' }

export interface ReleaseDeps {
  readonly ledger: LedgerClient
  readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
  readonly correlationId: string
}

/**
 * Return a held escrow's value to its owner's `available`, exactly once.
 *
 * Safe to call from two workers, from a retry, and from a caller that has no idea whether it has
 * already been called. See the file header for the three independent reasons that is true.
 */
export async function releaseEscrow(
  tx: Tx,
  deps: ReleaseDeps,
  escrowId: string,
): Promise<ReleaseOutcome> {
  // `for update` and NOT `for update skip locked`. Skipping would let a concurrent caller conclude
  // "no such escrow" and carry on as if nothing were held — here the second caller must WAIT and
  // then observe the first's committed decision.
  const claimed = await tx<EscrowRow[]>`
    select ${tx.unsafe(COLUMNS)} from escrows where id = ${escrowId} for update
  `
  const row = claimed[0]
  if (!row) return { status: 'missing' }
  const escrow = toEscrow(row)
  if (escrow.state !== 'held') return { status: 'already', escrow }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // **WHICH ACCOUNT THE VALUE COMES BACK FROM DEPENDS ON HOW IT GOT THERE, AND THERE ARE TWO.**
  //
  // A `listing_item`, `bid_funds` or `offer_funds` escrow put the value in the owner's `reserved`
  // account, so releasing it is `reserved → available`. A `proceeds` escrow did not: the sale's
  // settlement entry credited the SELLER's `payout_due`, which is a different account with a
  // different meaning — money that is theirs and not yet spendable. Releasing that with
  // `releasePostings` would debit a `reserved` account holding nothing, and the ledger's
  // "a liability may not go negative" rule would refuse the entry after the dispute window had
  // already been declared over.
  //
  // The branch is here rather than at the two call sites so that a future third kind of escrow
  // has one place to be got right.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const move = { subject: escrow.subject, assetCode: escrow.assetCode, amount: escrow.amount }
  const entry = await deps.ledger.postEntry({
    kind: 'market_escrow',
    actor: deps.actor,
    correlationId: deps.correlationId,
    idempotencyKey: idempotencyKeys.release(escrow.id),
    description: `release ${escrow.kind} escrow ${escrow.id}`,
    postings: escrow.kind === 'proceeds' ? payoutPostings(move) : releasePostings(move),
  })

  const updated = await tx<EscrowRow[]>`
    update escrows
       set state = 'released', settle_entry_id = ${entry.id}, settled_at = now()
     where id = ${escrow.id} and state = 'held'
    returning ${tx.unsafe(COLUMNS)}
  `
  const after = updated[0]
  // Unreachable while the row lock above is held, and asserted rather than assumed: if a future
  // change drops the lock, this is what turns a double release into a failure instead of a
  // refund paid twice.
  if (!after) throw new EscrowError(`escrow ${escrow.id} changed state under its own row lock`)
  return { status: 'released', escrow: toEscrow(after) }
}

/**
 * Mark an escrow captured by a settlement, exactly once.
 *
 * Distinct from `releaseEscrow` because the value did NOT go back to its owner: it was spent, by
 * the settlement entry named in `settleEntryId`. No postings are made here — the sale is a single
 * entry built by `settlePostings`, and this records which escrows that one entry consumed.
 * Posting again would double the sale.
 */
export async function captureEscrow(
  tx: Tx,
  escrowId: string,
  settlementEntryId: string,
  orderId: string,
): Promise<Escrow> {
  const rows = await tx<EscrowRow[]>`
    update escrows
       set state = 'captured', settle_entry_id = ${settlementEntryId}, settled_at = now(),
           order_id = coalesce(order_id, ${orderId})
     where id = ${escrowId} and state = 'held'
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    // The settlement path holds the listing row's claim before it gets here, so an escrow that is
    // no longer held means something else already spent it. Refusing is the only safe answer:
    // continuing would produce an order whose funds were consumed by a different sale.
    throw new EscrowError(`escrow ${escrowId} is no longer held and cannot be captured`)
  }
  return toEscrow(row)
}

export async function findEscrow(sql: Db | Tx, id: string): Promise<Escrow | null> {
  const rows = await sql<EscrowRow[]>`
    select ${sql.unsafe(COLUMNS)} from escrows where id = ${id}
  `
  const row = rows[0]
  return row ? toEscrow(row) : null
}

/** Every escrow attached to a listing. Used by cancellation, which must release all of them. */
export async function escrowsForListing(
  sql: Db | Tx,
  listingId: string,
  state?: EscrowState,
): Promise<readonly Escrow[]> {
  const rows = state
    ? await sql<EscrowRow[]>`
        select ${sql.unsafe(COLUMNS)} from escrows
         where listing_id = ${listingId} and state = ${state}
         order by held_at
      `
    : await sql<EscrowRow[]>`
        select ${sql.unsafe(COLUMNS)} from escrows
         where listing_id = ${listingId}
         order by held_at
      `
  return rows.map(toEscrow)
}
