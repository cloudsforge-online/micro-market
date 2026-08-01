/**
 * Background work: the outbox relay, the inbox, and the leased jobs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE.** The tests below assert on the keys themselves,
 * not only on the behaviour, because the key is the design and a refactor that changes it changes
 * the correctness without changing any observable outcome until the day there are two replicas.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type EnqueueOptions, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Metrics } from '@cloudsforge/telemetry'
import {
  AUCTION_CLOSE_KIND,
  AUCTION_SWEEP_KIND,
  EXPIRE_KIND,
  PAYOUT_KIND,
  RECURRING,
  RELAY_KIND,
  REAP_KIND,
  auctionKey,
  payoutKey,
  registerHandlers,
  rescheduleRecurring,
  runAuctionSweep,
  runExpiry,
  runPayoutSweep,
  seedRecurring,
  type JobDeps,
} from './jobs.ts'
import { createRelay, signEvent, verifyEventSignature, withInbox, withOutbox } from './outbox.ts'
import { findListing } from './listings.ts'
import { findOffer, makeOffer, placeBid } from './bids.ts'
import { escrowsForListing } from './escrow.ts'
import { findOrder, settleSale } from './orders.ts'
import {
  BUYER,
  SELLER,
  endAuctionNow,
  harness,
  migrateTestDb,
  openDb,
  payoutDueNow,
  quietLogger,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

/* ------------------------------------------------------------------ signing, no database */

test('a signature verifies over the exact bytes', () => {
  const body = JSON.stringify({ topic: 'market.listing.sold', key: 'l-1' })
  assert.ok(verifyEventSignature(body, 'secret-value', signEvent(body, 'secret-value')))
})

test('a tampered body does not verify', () => {
  const body = JSON.stringify({ amount: '100' })
  const signature = signEvent(body, 'secret-value')
  assert.equal(verifyEventSignature(JSON.stringify({ amount: '999' }), 'secret-value', signature), false)
})

test('a signature under a different secret does not verify', () => {
  const body = '{}'
  assert.equal(verifyEventSignature(body, 'secret-a', signEvent(body, 'secret-b')), false)
})

test('a signature of the wrong length is refused without a timing-unsafe comparison', () => {
  // `timingSafeEqual` throws on differing lengths, so the length check has to come first — and it
  // has to return false rather than throw, or a malformed header would be a 500.
  assert.equal(verifyEventSignature('{}', 'secret-value', 'sha256=short'), false)
})

test('the recurring set names its lease keys explicitly', () => {
  const byKind = new Map(RECURRING.map((job) => [job.kind, job.key]))
  // All five are `stream`, and that is safe only because four of them enqueue, deliver or delete.
  // `market.expire` is the exception; see the header of jobs.ts.
  assert.equal(byKind.get(RELAY_KIND), 'stream')
  assert.equal(byKind.get(AUCTION_SWEEP_KIND), 'stream')
  assert.equal(byKind.get(EXPIRE_KIND), 'stream')
  assert.equal(byKind.get(REAP_KIND), 'stream')
  // The two that touch one row each are NOT recurring: they are enqueued per resource.
  assert.ok(!byKind.has(AUCTION_CLOSE_KIND))
  assert.ok(!byKind.has(PAYOUT_KIND))
})

test('THE AUCTION CLOSE IS KEYED ON THE AUCTION, NOT THE STREAM', () => {
  // Two workers closing ONE auction is the defect class settlement proved with a chain-keyed
  // lease. Two DIFFERENT auctions are independent, so keying on the stream would serialise the
  // whole marketplace behind whichever auction is slowest.
  assert.equal(auctionKey('l-1'), 'auction:l-1')
  assert.notEqual(auctionKey('l-1'), auctionKey('l-2'))
})

test('the payout is keyed on the order', () => {
  assert.equal(payoutKey('o-1'), 'order:o-1')
  assert.notEqual(payoutKey('o-1'), payoutKey('o-2'))
})

/* ------------------------------------------------------------------ against Postgres */

describe('jobs and the outbox, against a real Postgres', { skip }, () => {
  let sql: postgres.Sql
  let h: Harness
  let queue: JobQueue
  let enqueued: EnqueueOptions[]
  let deps: JobDeps

  before(async () => {
    sql = openDb(8)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
    h = harness(sql)
    queue = new JobQueue(sql as unknown as JobsSql, { owner: 'worker-a', leaseMs: 30_000 })
    enqueued = []
    deps = {
      sql: h.sql,
      logger: quietLogger(),
      metrics: new Metrics(),
      signingSecret: 'a-real-looking-secret-of-sufficient-length',
      orders: h.orders,
      bids: h.bids,
      queue: {
        async enqueue(options) {
          enqueued.push(options)
          await queue.enqueue(options)
        },
      },
      sweepLimit: 50,
      idempotencyTtlDays: 14,
      actor: 'service:market',
    }
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- the outbox */

  test('withOutbox writes the event and the change together, or neither', async () => {
    await assert.rejects(
      withOutbox(h.sql, 'market', async (tx, emit) => {
        await tx`insert into collections (owner_subject, slug, name) values ('user:a', 'coll-one', 'C')`
        emit({ topic: 'market.listing.listed', key: 'l-1', payload: { listingId: 'l-1' } })
        throw new Error('something failed after the emit')
      }),
      /something failed/,
    )
    const events = await sql<{ n: number }[]>`select count(*)::int as n from outbox`
    const collections = await sql<{ n: number }[]>`select count(*)::int as n from collections`
    assert.equal(events[0]?.n, 0)
    assert.equal(collections[0]?.n, 0)
  })

  test('the inbox dedupes on (topic, event_id)', async () => {
    let handled = 0
    const handle = async () => {
      handled += 1
      return handled
    }
    const id = '11111111-1111-4111-8111-111111111111'
    const first = await withInbox(h.sql, 'billing.entitlement.revoked', id, handle)
    const second = await withInbox(h.sql, 'billing.entitlement.revoked', id, handle)
    assert.equal(first.status, 'processed')
    assert.equal(second.status, 'duplicate')
    assert.equal(handled, 1)
  })

  test('a handler that throws leaves NO inbox row, so the redelivery is processed', async () => {
    // The mistake this avoids: "record then handle" swallows the event when the handler fails,
    // and the redelivery is deduped against a row for work that never happened.
    const id = '22222222-2222-4222-8222-222222222222'
    await assert.rejects(
      withInbox(h.sql, 'billing.entitlement.revoked', id, async () => {
        throw new Error('handler failed')
      }),
      /handler failed/,
    )
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from inbox`
    assert.equal(rows[0]?.n, 0)
    const retry = await withInbox(h.sql, 'billing.entitlement.revoked', id, async () => 'ok')
    assert.equal(retry.status, 'processed')
  })

  test('the relay delivers to every active subscription and signs the exact bytes', async () => {
    const received: Array<{ path: string; body: unknown; headers: Record<string, string> }> = []
    await sql`
      insert into event_subscriptions (topic, url)
      values ('market.listing.sold', 'http://subscriber.test/hooks/market')
    `
    await withOutbox(h.sql, 'market', async (_tx, emit) => {
      emit({ topic: 'market.listing.sold', key: 'l-1', payload: { amount: '1000' } })
    })

    const relay = createRelay({
      sql: h.sql,
      logger: quietLogger(),
      signingSecret: 'a-real-looking-secret-of-sufficient-length',
      clientFor: () => ({
        async request(path: string, options?: Record<string, unknown>) {
          received.push({
            path,
            body: options?.['body'],
            headers: (options?.['headers'] ?? {}) as Record<string, string>,
          })
          return {} as never
        },
      }),
    })
    await relay(
      { id: 'j', kind: RELAY_KIND, key: 'stream', attempts: 1, maxAttempts: 5, payload: {} },
      { heartbeat: async () => true, signal: new AbortController().signal },
    )

    assert.equal(received.length, 1)
    assert.equal(received[0]?.path, '/hooks/market')
    const envelope = received[0]?.body as Record<string, unknown>
    assert.equal(envelope['topic'], 'market.listing.sold')
    // The MAC is over the exact bytes the client will send: the same object, stringified with the
    // same key order, so a subscriber recomputing it over the received body matches.
    const signature = received[0]?.headers['cf-signature'] as string
    assert.ok(
      verifyEventSignature(
        JSON.stringify(envelope),
        'a-real-looking-secret-of-sufficient-length',
        signature,
      ),
    )
    const published = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
    assert.ok(published[0]?.published_at)
  })

  test('an unreachable subscriber is retried rather than losing the event', async () => {
    await sql`
      insert into event_subscriptions (topic, url)
      values ('market.listing.sold', 'http://down.test/hook')
    `
    await withOutbox(h.sql, 'market', async (_tx, emit) => {
      emit({ topic: 'market.listing.sold', key: 'l-1', payload: {} })
    })
    let attempts = 0
    const relay = createRelay({
      sql: h.sql,
      logger: quietLogger(),
      signingSecret: 'a-real-looking-secret-of-sufficient-length',
      clientFor: () => ({
        async request() {
          attempts += 1
          throw new Error('connection refused')
        },
      }),
    })
    const job = { id: 'j', kind: RELAY_KIND, key: 'stream', attempts: 1, maxAttempts: 5, payload: {} }
    const ctx = { heartbeat: async () => true, signal: new AbortController().signal }
    // Logged, not thrown: one unreachable subscriber must not stop the rest of the batch.
    await relay(job, ctx)
    await relay(job, ctx)
    assert.equal(attempts, 2)
    const published = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
    assert.equal(published[0]?.published_at, null, 'an undelivered event must stay unpublished')
  })

  /* ---------------------------------------------------------------- the sweeps */

  test('the auction sweep enqueues one close per due auction, keyed on the auction', async () => {
    const due = await seedListing(h, { pricingMode: 'auction', price: 100n })
    const open = await seedListing(h, { pricingMode: 'auction', price: 100n, itemUrn: 'cf:x:2' })
    await endAuctionNow(sql, due.id)

    assert.equal(await runAuctionSweep(deps), 1)
    assert.deepEqual(
      enqueued.map((job) => [job.kind, job.key]),
      [[AUCTION_CLOSE_KIND, auctionKey(due.id)]],
    )
    assert.ok(!enqueued.some((job) => job.key === auctionKey(open.id)))
  })

  test('three sweeps before the first close runs produce ONE queued job', async () => {
    // `keep` on conflict. Otherwise a slow closer accumulates a queue of identical work.
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await endAuctionNow(sql, listing.id)
    await runAuctionSweep(deps)
    await runAuctionSweep(deps)
    await runAuctionSweep(deps)
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from jobs where kind = ${AUCTION_CLOSE_KIND}
    `
    assert.equal(rows[0]?.n, 1)
  })

  test('the sweep NEVER settles — it enqueues and nothing else', async () => {
    // The only reason it may share a runner with the closer at all.
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 500n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    const posted = h.ledger.postedCount
    await runAuctionSweep(deps)
    assert.equal(h.ledger.postedCount, posted)
    assert.equal((await findListing(h.sql, listing.id))?.status, 'active')
  })

  test('the payout sweep enqueues one payout per due order, keyed on the order', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await settleSale(h.orders, {
      listingId: listing.id,
      buyerSubject: BUYER,
      amount: 1_000n,
      source: 'purchase',
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await payoutDueNow(sql, result.order.id)
    assert.equal(await runPayoutSweep(deps), 1)
    assert.deepEqual(
      enqueued.map((job) => [job.kind, job.key]),
      [[PAYOUT_KIND, payoutKey(result.order.id)]],
    )
  })

  test('the expiry sweep expires a listing and releases what it held', async () => {
    const listing = await seedListing(h, { expiresAt: new Date(Date.now() + 60_000) })
    await sql`update listings set expires_at = now() - interval '1 second' where id = ${listing.id}`
    const result = await runExpiry(deps)
    assert.equal(result.listings, 1)
    assert.equal((await findListing(h.sql, listing.id))?.status, 'expired')
    assert.equal((await escrowsForListing(h.sql, listing.id))[0]?.state, 'released')
  })

  test('the expiry sweep expires an offer and refunds it', async () => {
    const listing = await seedListing(h)
    const offer = await makeOffer(h.bids, {
      listingId: listing.id,
      offererSubject: BUYER,
      amount: 800n,
      expiresAt: new Date(Date.now() + 60_000),
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await sql`update offers set expires_at = now() - interval '1 second' where id = ${offer.id}`
    const result = await runExpiry(deps)
    assert.equal(result.offers, 1)
    assert.equal((await findOffer(h.sql, offer.id))?.status, 'expired')
  })

  test('THE EXPIRY SWEEP DOES NOT STALL ON A LISTING SOMEBODY ELSE ALREADY SOLD', async () => {
    // The race the header of jobs.ts describes: `market.expire` and `auction.close` are two rows
    // in the jobs table and two workers may hold them at once. A ListingStateError from one
    // contended row must not fail the whole sweep and stop every expiry behind it.
    const sold = await seedListing(h, { expiresAt: new Date(Date.now() + 60_000) })
    const expiring = await seedListing(h, {
      itemUrn: 'cf:x:2',
      expiresAt: new Date(Date.now() + 60_000),
    })
    await settleSale(h.orders, {
      listingId: sold.id,
      buyerSubject: BUYER,
      amount: 1_000n,
      source: 'purchase',
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await sql`update listings set expires_at = now() - interval '1 second'`

    const result = await runExpiry(deps)
    assert.equal(result.listings, 1, 'the second listing was not expired')
    assert.equal((await findListing(h.sql, sold.id))?.status, 'sold')
    assert.equal((await findListing(h.sql, expiring.id))?.status, 'expired')
  })

  /* ---------------------------------------------------------------- the runner */

  test('the runner claims a close job under a lease and only one worker gets it', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 900n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)
    await runAuctionSweep(deps)

    const other = new JobQueue(sql as unknown as JobsSql, { owner: 'worker-b', leaseMs: 30_000 })
    const [mine, theirs] = await Promise.all([
      queue.claim(5, [AUCTION_CLOSE_KIND]),
      other.claim(5, [AUCTION_CLOSE_KIND]),
    ])
    // `for update skip locked`: the loser skips the row rather than waiting for it.
    assert.equal(mine.length + theirs.length, 1)
  })

  test('the registered close handler settles the auction', async () => {
    const listing = await seedListing(h, { pricingMode: 'auction', price: 100n })
    await placeBid(h.bids, {
      listingId: listing.id,
      bidderSubject: BUYER,
      amount: 900n,
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await endAuctionNow(sql, listing.id)

    const runner = registerHandlers(new JobRunner({ queue, concurrency: 2, pollMs: 10 }), deps)
    await runAuctionSweep(deps)
    await runner.tick()

    const orders = await sql<{ n: number }[]>`
      select count(*)::int as n from orders where listing_id = ${listing.id}
    `
    assert.equal(orders[0]?.n, 1)
    assert.equal((await findListing(h.sql, listing.id))?.status, 'sold')
  })

  test('the registered payout handler releases the proceeds', async () => {
    const listing = await seedListing(h, { disputeWindowMs: 3_600_000 })
    const result = await settleSale(h.orders, {
      listingId: listing.id,
      buyerSubject: BUYER,
      amount: 1_000n,
      source: 'purchase',
      actor: BUYER as `user:${string}`,
      correlationId: 'r',
    })
    await payoutDueNow(sql, result.order.id)

    const runner = registerHandlers(new JobRunner({ queue, concurrency: 2, pollMs: 10 }), deps)
    await runPayoutSweep(deps)
    await runner.tick()
    assert.equal((await findOrder(h.sql, result.order.id))?.proceedsState, 'released')
  })

  test('a close job with no listingId dead-letters rather than retrying for ever', async () => {
    // A payload that cannot be acted on is a permanent fault. Retrying will not make it valid.
    const runner = registerHandlers(
      new JobRunner({ queue, concurrency: 1, pollMs: 10 }),
      deps,
    )
    await queue.enqueue({ kind: AUCTION_CLOSE_KIND, key: 'auction:none', payload: {}, maxAttempts: 1 })
    await runner.tick()
    const rows = await sql<{ dead: boolean; last_error: string | null }[]>`
      select dead, last_error from jobs where kind = ${AUCTION_CLOSE_KIND}
    `
    assert.equal(rows[0]?.dead, true)
    assert.match(rows[0]?.last_error ?? '', /requires a string listingId/)
  })

  test('seedRecurring is safe from N replicas booting together', async () => {
    await seedRecurring(queue)
    await seedRecurring(queue)
    await seedRecurring(queue)
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs`
    assert.equal(rows[0]?.n, RECURRING.length)
  })

  test('a completed recurring job is re-armed; a dead one is not', async () => {
    const armed: EnqueueOptions[] = []
    const reschedule = rescheduleRecurring(
      { async enqueue(options) { armed.push(options) } },
      quietLogger(),
    )
    reschedule({ type: 'completed', kind: RELAY_KIND, key: 'stream' })
    // A dead-lettered recurring job stays dead: the row remains, jobs_dead_total increments and
    // jobs_overdue climbs, which is how an operator finds out.
    reschedule({ type: 'dead', kind: RELAY_KIND, key: 'stream' })
    reschedule({ type: 'completed', kind: AUCTION_CLOSE_KIND, key: 'auction:l-1' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(armed.length, 1)
    assert.equal(armed[0]?.kind, RELAY_KIND)
    assert.equal(armed[0]?.onConflict, 'earliest')
  })

  test('the reaper handler runs and removes nothing when there is nothing to remove', async () => {
    const runner = registerHandlers(new JobRunner({ queue, concurrency: 1, pollMs: 10 }), deps)
    await queue.enqueue({ kind: REAP_KIND, key: 'stream', payload: {} })
    await runner.tick()
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = ${REAP_KIND}`
    assert.equal(rows[0]?.n, 0, 'a successful job deletes its row')
  })

  test('this repository contains no setInterval doing domain work', async () => {
    // Rule 8, asserted here as well as in CI. Comment lines are excluded: this repository
    // DISCUSSES the frozen estate's timers, and a check that cannot tell a timer from a sentence
    // about one is a check people learn to ignore.
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = new URL('.', import.meta.url)
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    for (const name of files) {
      const source = await readFile(new URL(name, dir), 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        assert.ok(
          !/\bsetInterval\s*\(/.test(line),
          `${name}:${index + 1} has a setInterval; background work is a leased job`,
        )
      }
    }
  })
})
