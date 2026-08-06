/**
 * Moderation cases and disputes — the two things that can stop a sale.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FREEZE IS A COLUMN ON THE LISTING, SET IN THE SAME TRANSACTION AS THE CASE.**
 *
 * The obvious design is for settlement to query the moderation table: "is there an open freeze on
 * this listing?" It has a race in it, and the race is the whole point. Between the read and the
 * settlement's write, a freeze can land — so a listing frozen at 12:00:00.000 can still be sold
 * at 12:00:00.001 by a request that read the table a millisecond earlier. A freeze that can be
 * raced is not a freeze; it is a delay.
 *
 * So `openCase` sets `listings.frozen` in the same transaction that writes the case, and
 * `settleSale`'s claim carries `and frozen = false` in its WHERE. There is no instant at which a
 * frozen listing is settleable, because the flag and the claim are the same row and Postgres
 * serialises writers to a row.
 *
 * `moderation_open_freeze_uniq` — one open freeze per listing — is what makes lifting a freeze
 * safe. With two open freezes, resolving the first would unfreeze a listing the second still
 * considers frozen, and nobody would notice until the item sold.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## A refund is a REVERSAL, never an edit
 *
 * 04-domain-model §2.2 invariant 3. `resolveDispute` posts a new entry with `reversesEntryId` set
 * to the settlement's, and touches nothing about the order's amounts. The order stays exactly as
 * it settled, for ever, and the dispute row is what says what happened next — which is the only
 * arrangement in which "what did this customer actually pay" has an answer six months later.
 *
 * ## A refund requires the proceeds to still be held
 *
 * `refundPostings` debits the seller's `payout_due`. Once the payout job has moved that money to
 * `available`, the seller may have spent it, and a refund would drive their liability negative —
 * which the ledger refuses, correctly, after the operator has already told the buyer they were
 * being repaid. So the refusal happens HERE, where it can say why, and an operator who wants to
 * refund a paid-out sale has to claw the money back deliberately rather than by accident.
 */

import type { Db } from './outbox.ts'
import { emitOn } from './outbox.ts'
import { idempotencyKeys, refundPostings, type LedgerClient } from './ledgerclient.ts'
import { ListingStateError } from './listings.ts'
import { OrderError, findOrder, orderRoyalties, type Order } from './orders.ts'

export const CASE_OPENED_TOPIC = 'market.moderation.opened'
export const CASE_RESOLVED_TOPIC = 'market.moderation.resolved'
export const DISPUTE_OPENED_TOPIC = 'market.dispute.opened'
export const DISPUTE_RESOLVED_TOPIC = 'market.dispute.resolved'

export type CaseSubjectKind = 'listing' | 'collection' | 'seller' | 'item'
export type CaseAction = 'none' | 'freeze' | 'delist'
export type CaseState = 'open' | 'upheld' | 'dismissed'
export type DisputeState = 'open' | 'resolved_refunded' | 'resolved_upheld' | 'withdrawn'

export class ModerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModerationError'
  }
}

export interface ModerationCase {
  readonly id: string
  readonly subjectKind: CaseSubjectKind
  readonly subjectUrn: string
  readonly listingId: string | null
  readonly reason: string
  readonly action: CaseAction
  readonly state: CaseState
  readonly openedBy: string
  readonly openedAt: Date
  readonly resolvedBy: string | null
  readonly resolvedAt: Date | null
  readonly notes: string | null
}

interface CaseRow {
  readonly id: string
  readonly subject_kind: CaseSubjectKind
  readonly subject_urn: string
  readonly listing_id: string | null
  readonly reason: string
  readonly action: CaseAction
  readonly state: CaseState
  readonly opened_by: string
  readonly opened_at: Date
  readonly resolved_by: string | null
  readonly resolved_at: Date | null
  readonly notes: string | null
}

const CASE_COLUMNS = `id, subject_kind, subject_urn, listing_id, reason, action, state, opened_by,
                      opened_at, resolved_by, resolved_at, notes`

function toCase(row: CaseRow): ModerationCase {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectUrn: row.subject_urn,
    listingId: row.listing_id,
    reason: row.reason,
    action: row.action,
    state: row.state,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    notes: row.notes,
  }
}

export interface ModerationDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
}

/**
 * Open a case, and freeze what it acts on, atomically.
 *
 * A `freeze` blocks settlement and leaves the listing on the market — the right answer when
 * something needs looking at. A `delist` blocks settlement too and is upgraded to a cancellation
 * when the case is upheld, which releases every escrow. Neither is applied later by a job: a
 * freeze that arrives a second after the decision is a freeze that arrives after the sale.
 */
export async function openCase(
  deps: ModerationDeps,
  input: {
    readonly subjectKind: CaseSubjectKind
    readonly subjectUrn: string
    readonly listingId?: string | null
    readonly reason: string
    readonly action: CaseAction
    readonly openedBy: string
    readonly correlationId: string
  },
): Promise<ModerationCase> {
  if (input.action !== 'none' && !input.listingId) {
    throw new ModerationError('a freezing or delisting case must name the listing it acts on')
  }
  const outcome = await deps.sql.begin(async (tx) => {
    if (input.listingId) {
      // Locked first, so the flag and every settlement claim on this listing are ordered against
      // one another rather than racing. See the file header.
      const found = await tx<{ id: string; status: string }[]>`
        select id, status from listings where id = ${input.listingId} for update
      `
      if (!found[0]) throw new ListingStateError('no such listing')
    }
    const rows = await tx<CaseRow[]>`
      insert into moderation_cases (subject_kind, subject_urn, listing_id, reason, action, opened_by)
      values (${input.subjectKind}, ${input.subjectUrn}, ${input.listingId ?? null},
              ${input.reason}, ${input.action}, ${input.openedBy})
      returning ${tx.unsafe(CASE_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new ModerationError('the case was not written')

    if (input.action !== 'none' && input.listingId) {
      await tx`update listings set frozen = true, updated_at = now() where id = ${input.listingId}`
    }
    await emitOn(tx, deps.producer, {
      topic: CASE_OPENED_TOPIC,
      key: input.subjectUrn,
      actor: `operator:${input.openedBy}`,
      correlationId: input.correlationId,
      payload: {
        caseId: row.id,
        subjectKind: input.subjectKind,
        subjectUrn: input.subjectUrn,
        listingId: input.listingId ?? null,
        action: input.action,
        reason: input.reason,
      },
    })
    return { value: toCase(row) }
  })
  return outcome.value
}

/**
 * Resolve a case. Dismissal lifts the freeze; upholding a `delist` withdraws the listing.
 *
 * The freeze is lifted only when no OTHER open case still wants it frozen. Recomputing the flag
 * from the open set rather than blindly clearing it is what stops a second, unrelated case from
 * being silently overridden — the failure mode where two investigations are running and closing
 * the trivial one unfreezes the serious one.
 */
export async function resolveCase(
  deps: ModerationDeps,
  input: {
    readonly caseId: string
    readonly state: 'upheld' | 'dismissed'
    readonly resolvedBy: string
    readonly notes?: string
    readonly correlationId: string
  },
): Promise<ModerationCase> {
  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<CaseRow[]>`
      select ${tx.unsafe(CASE_COLUMNS)} from moderation_cases where id = ${input.caseId} for update
    `
    const row = claimed[0]
    if (!row) throw new ModerationError('no such case')
    if (row.state !== 'open') return { value: toCase(row) }

    const updated = await tx<CaseRow[]>`
      update moderation_cases
         set state = ${input.state}, resolved_by = ${input.resolvedBy}, resolved_at = now(),
             notes = ${input.notes ?? null}
       where id = ${row.id} and state = 'open'
      returning ${tx.unsafe(CASE_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new ModerationError('the case changed state under its own row lock')

    if (row.listing_id) {
      await refreshFrozen(tx, row.listing_id)
    }
    await emitOn(tx, deps.producer, {
      topic: CASE_RESOLVED_TOPIC,
      key: row.subject_urn,
      actor: `operator:${input.resolvedBy}`,
      correlationId: input.correlationId,
      payload: { caseId: row.id, state: input.state, listingId: row.listing_id },
    })
    return { value: toCase(after) }
  })

  // A delist that is upheld withdraws the listing, which releases every escrow it holds. Done
  // AFTER the case's transaction rather than inside it: `endListing` opens its own transaction and
  // calls the ledger once per escrow, and nesting that inside the case's transaction would hold
  // the moderation row's lock across N network calls.
  if (input.state === 'upheld' && outcome.value.action === 'delist' && outcome.value.listingId) {
    const { endListing } = await import('./listings.ts')
    await endListing(
      { sql: deps.sql, ledger: deps.ledger, producer: deps.producer },
      {
        listingId: outcome.value.listingId,
        to: 'cancelled',
        reason: `delisted by moderation case ${outcome.value.id}`,
        actor: `operator:${input.resolvedBy}`,
        correlationId: input.correlationId,
      },
    )
  }
  return outcome.value
}

/**
 * Recompute a listing's `frozen` flag from the open case and dispute set.
 *
 * Derived rather than toggled. Toggling means two independent freezes fight, and whichever is
 * lifted last wins — which is exactly wrong: a listing should stay frozen while ANY reason to
 * freeze it is still open.
 */
async function refreshFrozen(
  tx: Parameters<typeof emitOn>[0],
  listingId: string,
): Promise<void> {
  await tx`
    update listings
       set frozen = exists (
             select 1 from moderation_cases m
              where m.listing_id = ${listingId} and m.state = 'open'
                and m.action in ('freeze','delist')
           ) or exists (
             select 1 from disputes d
               join orders o on o.id = d.order_id
              where o.listing_id = ${listingId} and d.state = 'open'
           ),
           updated_at = now()
     where id = ${listingId}
  `
}

export async function findCase(sql: Db, id: string): Promise<ModerationCase | null> {
  const rows = await sql<CaseRow[]>`
    select ${sql.unsafe(CASE_COLUMNS)} from moderation_cases where id = ${id}
  `
  const row = rows[0]
  return row ? toCase(row) : null
}

export async function listCases(
  sql: Db,
  query: { readonly state?: CaseState; readonly subjectUrn?: string; readonly limit?: number } = {},
): Promise<readonly ModerationCase[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await sql<CaseRow[]>`
    select ${sql.unsafe(CASE_COLUMNS)} from moderation_cases
     where (${query.state ?? null}::text is null or state = ${query.state ?? null})
       and (${query.subjectUrn ?? null}::text is null or subject_urn = ${query.subjectUrn ?? null})
     order by opened_at desc
     limit ${limit}
  `
  return rows.map(toCase)
}

/* ------------------------------------------------------------------ disputes */

export interface Dispute {
  readonly id: string
  readonly orderId: string
  readonly raiserSubject: string
  readonly reason: string
  readonly state: DisputeState
  readonly resolutionEntryId: string | null
  readonly openedAt: Date
  readonly resolvedBy: string | null
  readonly resolvedAt: Date | null
}

interface DisputeRow {
  readonly id: string
  readonly order_id: string
  readonly raiser_subject: string
  readonly reason: string
  readonly state: DisputeState
  readonly resolution_entry_id: string | null
  readonly opened_at: Date
  readonly resolved_by: string | null
  readonly resolved_at: Date | null
}

const DISPUTE_COLUMNS = `id, order_id, raiser_subject, reason, state, resolution_entry_id,
                         opened_at, resolved_by, resolved_at`

function toDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    orderId: row.order_id,
    raiserSubject: row.raiser_subject,
    reason: row.reason,
    state: row.state,
    resolutionEntryId: row.resolution_entry_id,
    openedAt: row.opened_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
  }
}

/**
 * Raise a dispute against a settled order, and freeze the listing behind it.
 *
 * The freeze is what stops the payout job from making the money spendable while the argument is
 * running — and `duePayouts` also excludes disputed orders directly, so the block survives a
 * listing whose flag is cleared for an unrelated reason. Two defences, in the same direction.
 */
export async function openDispute(
  deps: ModerationDeps,
  input: {
    readonly orderId: string
    readonly raiserSubject: string
    readonly reason: string
    readonly correlationId: string
  },
): Promise<Dispute> {
  const outcome = await deps.sql.begin(async (tx) => {
    const orders = await tx<{ id: string; listing_id: string; buyer_subject: string; seller_subject: string }[]>`
      select id, listing_id, buyer_subject, seller_subject from orders
       where id = ${input.orderId} for update
    `
    const order = orders[0]
    if (!order) throw new OrderError('no such order')
    if (
      order.buyer_subject !== input.raiserSubject &&
      order.seller_subject !== input.raiserSubject
    ) {
      // Only the two parties may dispute. A third party's complaint is a moderation case, which
      // is a different table with a different resolution path and no power to move money.
      throw new ModerationError('only the buyer or the seller may dispute an order')
    }

    const rows = await tx<DisputeRow[]>`
      insert into disputes (order_id, raiser_subject, reason)
      values (${order.id}, ${input.raiserSubject}, ${input.reason})
      returning ${tx.unsafe(DISPUTE_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new ModerationError('the dispute was not written')
    await tx`update listings set frozen = true, updated_at = now() where id = ${order.listing_id}`
    await emitOn(tx, deps.producer, {
      topic: DISPUTE_OPENED_TOPIC,
      key: order.listing_id,
      actor: input.raiserSubject as `user:${string}`,
      correlationId: input.correlationId,
      payload: {
        disputeId: row.id,
        orderId: order.id,
        raiserSubject: input.raiserSubject,
        // The other side of the order — the third instance of the defect that made
        // `market.offer.made` findable, and the one with the most at stake. The actor is the
        // raiser, `raiserSubject` is the raiser, and the key is the listing, so every subject on
        // this envelope was the person who complained. The person whose money this event has just
        // FROZEN (the `update listings set frozen = true` above, and `duePayouts` excluding
        // disputed orders) was named nowhere on it, and learns about it by finding a payout that
        // never arrives.
        //
        // Derivable rather than guessed: the check five lines above has already established that
        // the raiser is one of exactly two subjects on this order, so the counterparty is the
        // other one and there is no third case. A subject, as everywhere else here.
        counterpartySubject:
          order.buyer_subject === input.raiserSubject ? order.seller_subject : order.buyer_subject,
        reason: input.reason,
      },
    })
    return { value: toDispute(row) }
  })
  return outcome.value
}

export interface ResolveDisputeResult {
  readonly dispute: Dispute
  readonly order: Order
  /** The reversal entry, when the resolution was a refund. */
  readonly reversalEntryId: string | null
}

/**
 * Resolve a dispute, refunding the buyer or upholding the sale.
 *
 * A refund is a NEW entry with `reversesEntryId` set — never an edit of the order. The order's
 * amounts are what settled, for ever; the dispute row is what happened next.
 */
export async function resolveDispute(
  deps: ModerationDeps,
  input: {
    readonly disputeId: string
    readonly resolution: 'refunded' | 'upheld'
    readonly resolvedBy: string
    readonly correlationId: string
  },
): Promise<ResolveDisputeResult> {
  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<DisputeRow[]>`
      select ${tx.unsafe(DISPUTE_COLUMNS)} from disputes where id = ${input.disputeId} for update
    `
    const row = claimed[0]
    if (!row) throw new ModerationError('no such dispute')
    if (row.state !== 'open') throw new ModerationError(`this dispute is already ${row.state}`)

    const order = await findOrder(tx, row.order_id)
    if (!order) throw new OrderError('the disputed order has vanished')

    let reversalEntryId: string | null = null
    if (input.resolution === 'refunded') {
      if (order.settlementMode !== 'custodial') {
        // An on-chain sale was never the platform's to reverse: the buyer paid the seller's own
        // wallet and no ledger entry exists to reverse. The operator's remedy is off-ledger.
        throw new ModerationError('an on-chain sale cannot be refunded through the ledger')
      }
      if (order.proceedsState !== 'held') {
        // See the file header. Refused here, where it can say why.
        throw new ModerationError(
          'this order’s proceeds have already been paid out; a refund must be arranged with the seller',
        )
      }
      if (!order.journalEntryId) throw new OrderError('the order has no entry to reverse')

      const entry = await deps.ledger.postEntry({
        kind: 'reversal',
        actor: `operator:${input.resolvedBy}`,
        correlationId: input.correlationId,
        idempotencyKey: idempotencyKeys.refund(row.id),
        description: `refund order ${order.id} under dispute ${row.id}`,
        reversesEntryId: order.journalEntryId,
        postings: refundPostings({
          buyerSubject: order.buyerSubject,
          sellerSubject: order.sellerSubject,
          assetCode: order.assetCode,
          split: {
            price: order.amount,
            platformFee: order.feeAmount,
            royaltyTotal: order.royaltyAmount,
            sellerProceeds: order.sellerProceeds,
            royaltyShares: await orderRoyalties(tx, order.id),
          },
        }),
      })
      reversalEntryId = entry.id
      // The proceeds escrow is spent by the reversal, not released to the seller. `captured` says
      // exactly that: the value left the escrow and did not go back to its owner.
      await tx`
        update escrows
           set state = 'captured', settle_entry_id = ${entry.id}, settled_at = now()
         where order_id = ${order.id} and kind = 'proceeds' and state = 'held'
      `
      await tx`
        update orders set proceeds_state = 'released', payout_entry_id = ${entry.id}
         where id = ${order.id}
      `
    }

    const updated = await tx<DisputeRow[]>`
      update disputes
         set state = ${input.resolution === 'refunded' ? 'resolved_refunded' : 'resolved_upheld'},
             resolution_entry_id = ${reversalEntryId},
             resolved_by = ${input.resolvedBy}, resolved_at = now()
       where id = ${row.id} and state = 'open'
      returning ${tx.unsafe(DISPUTE_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new ModerationError('the dispute changed state under its own row lock')

    await refreshFrozen(tx, order.listingId)
    await emitOn(tx, deps.producer, {
      topic: DISPUTE_RESOLVED_TOPIC,
      key: order.listingId,
      actor: `operator:${input.resolvedBy}`,
      correlationId: input.correlationId,
      payload: {
        disputeId: row.id,
        orderId: order.id,
        resolution: input.resolution,
        reversalEntryId,
        // THE FOURTH INSTANCE, and the one that made the other three look incomplete.
        //
        // The same question was asked of every topic this service emits — "does the envelope name
        // only the person who acted?" — and this one answered worse than that: it named NOBODY.
        // The actor is `operator:<id>`, the key is the listing, and the payload was four ids. Two
        // people have money moving on this event and neither appeared anywhere on it.
        //
        // What makes it the worst of the four is the pair it completes. `market.dispute.opened`
        // above was fixed to carry `counterpartySubject` for one stated reason: the person whose
        // payout that event FREEZES was learning about it by finding a payout that never arrived.
        // This is the event that unfreezes it — `refreshFrozen` four lines up, and `duePayouts`
        // stops excluding the order — and it named them nowhere. So the repair to `opened` had
        // delivered "your money is frozen" and left the estate unable to ever send the sentence
        // that ends it. A half-fixed pair reads as fixed from either end alone.
        //
        // Both spellings, for the two different readers this event has:
        //   - `raiserSubject` off the dispute row this transaction holds `for update`, so
        //     it is the raiser as recorded rather than as re-derived.
        //   - `counterpartySubject` by the same derivation `openDispute` uses, and legitimate for
        //     the same reason: `openDispute` admits only the buyer or the seller, so the raiser is
        //     one of exactly two subjects on this order and the counterparty is the other. There
        //     is no third case and nothing is being guessed.
        //
        // Deliberately NOT "refundedSubject"/"paidSubject". Which one is good news depends on
        // `resolution`, which is already on the payload; naming the parties by their ROLE IN THE
        // DISPUTE keeps the one fact in one field and lets a consumer join the two, rather than
        // encoding the outcome twice in a way that can disagree with itself.
        raiserSubject: after.raiser_subject,
        counterpartySubject:
          order.buyerSubject === after.raiser_subject ? order.sellerSubject : order.buyerSubject,
      },
    })

    const refreshed = await findOrder(tx, order.id)
    return {
      value: {
        dispute: toDispute(after),
        order: refreshed ?? order,
        reversalEntryId,
      } satisfies ResolveDisputeResult,
    }
  })
  return outcome.value
}

export async function findDispute(sql: Db, id: string): Promise<Dispute | null> {
  const rows = await sql<DisputeRow[]>`
    select ${sql.unsafe(DISPUTE_COLUMNS)} from disputes where id = ${id}
  `
  const row = rows[0]
  return row ? toDispute(row) : null
}

export async function listDisputes(
  sql: Db,
  query: { readonly state?: DisputeState; readonly orderId?: string; readonly limit?: number } = {},
): Promise<readonly Dispute[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await sql<DisputeRow[]>`
    select ${sql.unsafe(DISPUTE_COLUMNS)} from disputes
     where (${query.state ?? null}::text is null or state = ${query.state ?? null})
       and (${query.orderId ?? null}::uuid is null or order_id = ${query.orderId ?? null})
     order by opened_at desc
     limit ${limit}
  `
  return rows.map(toDispute)
}
