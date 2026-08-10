/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work and CI greps for one. The estate runs eight
 * of them today, each guarded only by a module-local boolean — a variable that is, by
 * construction, invisible to a second process.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.**
 *
 * This is the single decision most likely to be got wrong by someone extending this file. Ask:
 * what would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work             | Key                  | Why                                             |
 *   |------------------|----------------------|-------------------------------------------------|
 *   | auction.close    | `auction:<listingId>`| **The auction.** Not the stream, and not the     |
 *   |                  |                      | seller. Two workers closing ONE auction is the   |
 *   |                  |                      | defect class `settlement` proved with a          |
 *   |                  |                      | chain-keyed lease: two withdrawal workers, one   |
 *   |                  |                      | nonce, one payment permanently lost. Here the    |
 *   |                  |                      | equivalent is two orders against one item — one  |
 *   |                  |                      | buyer charged for something the other received.  |
 *   |                  |                      | Two DIFFERENT auctions are genuinely             |
 *   |                  |                      | independent, so keying on the stream would       |
 *   |                  |                      | serialise the whole marketplace behind whichever |
 *   |                  |                      | auction is slowest to settle.                    |
 *   | auction.sweep    | `stream`             | The backlog of due auctions. It enqueues and     |
 *   |                  |                      | does NOTHING else — no ledger call, no status    |
 *   |                  |                      | change — which is the only reason it may share a |
 *   |                  |                      | runner with the closer at all.                   |
 *   | payout.release   | `order:<orderId>`    | The order's proceeds. One payout per order.      |
 *   | payout.sweep     | `stream`             | Enqueues only. Same argument as auction.sweep.   |
 *   | market.expire    | `stream`             | The expiry backlog. This one DOES move money —   |
 *   |                  |                      | it releases escrows — so the key is deliberately |
 *   |                  |                      | narrow. See the note below.                      |
 *   | outbox.relay     | `stream`             | The outbox stream. Keying on the event id would  |
 *   |                  |                      | let two relays deliver one batch twice.          |
 *   | idempotency.reap | `stream`             | Housekeeping. Two of them delete the same rows   |
 *   |                  |                      | and the second finds none.                       |
 *
 * **A KEY IS NOT A LOCK ACROSS KINDS.** The jobs table is unique on `(kind, key)`, so
 * `auction.sweep / stream`, `market.expire / stream`, `payout.sweep / stream`, `outbox.relay /
 * stream` and `idempotency.reap / stream` are five rows, and five workers may hold them at the
 * same instant. Four of those five are safe because they enqueue, deliver or delete and never
 * touch listing state.
 *
 * **`market.expire` is the exception and it is the dangerous one.** It releases escrows, which
 * moves money, and it changes a listing's status — so it can genuinely collide with
 * `auction.close` over one listing. That collision is safe for two reasons, both of which must
 * stay true:
 *
 *   * `endListing` claims `status in ('draft','active')` and `settleSale` claims
 *     `status = 'active'`. Postgres serialises writers to a row, so exactly one of them wins and
 *     the other sees zero rows. The sweep treats that as "somebody else got there", not as a
 *     failure — see `runExpiry` below, which catches `ListingStateError` per listing.
 *   * `releaseEscrow` is exactly-once whatever calls it.
 *
 * **If `market.expire` ever stops routing its releases through `releaseEscrow`, or starts
 * settling rather than expiring, it must be merged into `auction.close` rather than given its own
 * key.** Sharing a key with a different KIND buys nothing at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import { closeAuction, duePayouts, releaseProceeds, type OrderDeps } from './orders.ts'
import { paySettlementSubsidy } from './engagement.ts'
import { ListingStateError, endListing, expiredListings, findListing } from './listings.ts'
import { closeOffer, dueAuctions, expiredOffers, type BidDeps } from './bids.ts'
import { reapIdempotencyKeys } from './idempotency.ts'

export const RELAY_KIND = 'outbox.relay'
/** The ONLY job that settles an auction. Keyed on the auction. */
export const AUCTION_CLOSE_KIND = 'auction.close'
/** Finds due auctions and enqueues them. Never settles — see the header. */
export const AUCTION_SWEEP_KIND = 'auction.sweep'
/** The only job that pays a seller out. Keyed on the order. */
export const PAYOUT_KIND = 'payout.release'
export const PAYOUT_SWEEP_KIND = 'payout.sweep'
/** Expires listings and offers, releasing what they hold. Moves money — see the header. */
export const EXPIRE_KIND = 'market.expire'
export const REAP_KIND = 'idempotency.reap'

/** The lease key for one auction's close: the auction. */
export function auctionKey(listingId: string): string {
  return `auction:${listingId}`
}

/** The lease key for one order's payout: the order. */
export function payoutKey(orderId: string): string {
  return `order:${orderId}`
}

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
  readonly payload?: Record<string, unknown>
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000, payload: {} },
  // Every second. An auction that ends at 12:00:00 and closes at 12:00:03 is a marketplace that
  // looks broken to the bidder watching the clock, and the sweep is one indexed query.
  { kind: AUCTION_SWEEP_KIND, key: 'stream', everyMs: 1_000, payload: {} },
  { kind: PAYOUT_SWEEP_KIND, key: 'stream', everyMs: 30_000, payload: {} },
  { kind: EXPIRE_KIND, key: 'stream', everyMs: 15_000, payload: {} },
  { kind: REAP_KIND, key: 'stream', everyMs: 3_600_000, payload: {} },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({
      kind: job.kind,
      key: job.key,
      onConflict: 'keep',
      ...(job.payload ? { payload: job.payload } : {}),
    })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out.
 */
export function rescheduleRecurring(
  queue: Pick<JobQueue, 'enqueue'>,
  logger: Logger,
): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind} ${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind} ${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        ...(job.payload ? { payload: job.payload } : {}),
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly orders: OrderDeps
  readonly bids: BidDeps
  /**
   * The queue the sweeps enqueue onto.
   *
   * Passed in rather than closed over at module scope. A module-local queue would be exactly the
   * shape of the module-local boolean rule 8 exists to keep out: invisible to a second process,
   * and impossible to substitute in a test.
   */
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly sweepLimit: number
  /** How long an idempotency key that produced nothing is kept. Must outlive every retry horizon. */
  readonly idempotencyTtlDays: number
  readonly actor: `service:${string}`
}

/* ------------------------------------------------------------------ the handlers, as functions */

/** Exposed so tests drive them directly, without a runner, a lease or a sleep. */
export async function runAuctionSweep(deps: JobDeps): Promise<number> {
  const due = await dueAuctions(deps.sql, deps.sweepLimit)
  for (const listingId of due) {
    // `keep`, so three sweeps before the first close runs produce one close, not three.
    await deps.queue.enqueue({
      kind: AUCTION_CLOSE_KIND,
      key: auctionKey(listingId),
      payload: { listingId },
      onConflict: 'keep',
    })
  }
  deps.metrics.set('market_auctions_due', due.length)
  return due.length
}

export async function runPayoutSweep(deps: JobDeps): Promise<number> {
  const due = await duePayouts(deps.sql, deps.sweepLimit)
  for (const orderId of due) {
    await deps.queue.enqueue({
      kind: PAYOUT_KIND,
      key: payoutKey(orderId),
      payload: { orderId },
      onConflict: 'keep',
    })
  }
  deps.metrics.set('market_payouts_due', due.length)
  return due.length
}

/**
 * Expire listings and offers whose time has run out, releasing everything they hold.
 *
 * `ListingStateError` is caught PER LISTING rather than allowed to fail the job. A listing that
 * expired at the same instant somebody bought it is a race that has already been decided
 * correctly by the row lock, and failing the whole sweep for it would stop every other expiry
 * behind it — a queue that stalls on one contended row is how a backlog becomes an incident.
 */
export async function runExpiry(deps: JobDeps): Promise<{ listings: number; offers: number }> {
  let listings = 0
  for (const listingId of await expiredListings(deps.sql, deps.sweepLimit)) {
    try {
      await endListing(deps.orders, {
        listingId,
        to: 'expired',
        reason: 'the listing expired',
        actor: deps.actor,
        correlationId: `expire:${listingId}`,
      })
      listings += 1
    } catch (err) {
      if (!(err instanceof ListingStateError)) throw err
      deps.logger.info('a listing was settled or withdrawn before its expiry ran', { listingId })
    }
  }

  let offers = 0
  for (const offerId of await expiredOffers(deps.sql, deps.sweepLimit)) {
    try {
      await closeOffer(deps.bids, {
        offerId,
        to: 'expired',
        actor: deps.actor,
        correlationId: `expire:${offerId}`,
      })
      offers += 1
    } catch (err) {
      if (!(err instanceof ListingStateError)) throw err
      deps.logger.info('an offer was resolved before its expiry ran', { offerId })
    }
  }
  deps.metrics.set('market_expired_last_pass', listings + offers)
  return { listings, offers }
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  runner.register(AUCTION_SWEEP_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const due = await runAuctionSweep(deps)
    if (due > 0) deps.logger.info('auction sweep', { due })
  })

  runner.register<{ listingId?: string }>(
    AUCTION_CLOSE_KIND,
    async (job: Job<{ listingId?: string }>, ctx) => {
      const listingId = job.payload.listingId
      if (typeof listingId !== 'string' || listingId.length === 0) {
        // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt
        // budget and dead-letters it, which is correct — retrying will not make it valid.
        throw new Error(`${AUCTION_CLOSE_KIND} requires a string listingId`)
      }
      const result = await closeAuction(deps.orders, {
        listingId,
        actor: deps.actor,
        correlationId: `close:${listingId}`,
      })
      if (ctx.signal.aborted) return
      deps.metrics.increment('market_auction_closes_total', { outcome: result.outcome })
      // 21 §5: an auction settled inside a zero-fee window has its waived fee funded out of
      // engagement:market, exactly as a direct purchase does. Best-effort — a subsidy that
      // cannot be paid must not dead-letter the auction close, which has already settled money.
      if (result.outcome === 'settled' && result.order) {
        const listing = await findListing(deps.sql, listingId)
        if (listing?.engagementWindowId) {
          await paySettlementSubsidy(
            { sql: deps.sql, ledger: deps.orders.ledger },
            {
              listingId,
              windowId: listing.engagementWindowId,
              waivedFeeBps: listing.engagementWaivedFeeBps,
              price: result.order.amount,
              assetCode: listing.assetCode,
              correlationId: `close:${listingId}`,
            },
          ).catch((err: unknown) => {
            deps.logger.warn('a listing-fee subsidy could not be funded after an auction close', {
              listingId,
              err,
            })
          })
        }
      }
      deps.logger.info('auction close', { listingId, outcome: result.outcome, orderId: result.order?.id })
    },
  )

  runner.register(PAYOUT_SWEEP_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const due = await runPayoutSweep(deps)
    if (due > 0) deps.logger.info('payout sweep', { due })
  })

  runner.register<{ orderId?: string }>(PAYOUT_KIND, async (job: Job<{ orderId?: string }>, ctx) => {
    const orderId = job.payload.orderId
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error(`${PAYOUT_KIND} requires a string orderId`)
    }
    const result = await releaseProceeds(deps.orders, {
      orderId,
      actor: deps.actor,
      correlationId: `payout:${orderId}`,
    })
    if (ctx.signal.aborted) return
    deps.metrics.increment('market_payouts_total', { outcome: result.outcome })
    deps.logger.info('payout', { orderId, outcome: result.outcome })
  })

  runner.register(EXPIRE_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const result = await runExpiry(deps)
    if (result.listings + result.offers > 0) deps.logger.info('expiry sweep', { ...result })
  })

  runner.register(REAP_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const removed = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
    if (removed > 0) deps.logger.info('idempotency keys reaped', { removed })
  })

  return runner
}
