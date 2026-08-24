/**
 * Boot the REAL service on a real socket, sell a real item, and print the ledger entry that paid
 * for it.
 *
 * A transcript, not a test. The suite already proves the races; what this proves is that the
 * composition root, the routes, the idempotency wrapper, the escrow, the settlement and the outbox
 * work together in one process the way a deploy would run them — which is the one thing a unit of
 * `node:test` per module never shows.
 *
 * `createServer` is the production one. `settleSale`, `activateListing`, `placeBid` and
 * `closeAuction` reached through it are the production ones. Three things are substituted, at the
 * narrowest seam each has, because none of them is what is being verified here:
 *
 *   * the ledger — a fake that REPLAYS on a repeated idempotency key and refuses an entry that
 *     does not balance, exactly as the real one does. That is what makes the printed postings
 *     evidence rather than decoration;
 *   * the indexer and policy — both are soft dependencies with designed degradations;
 *   * the token verifier — three fixed tokens, no JWKS and no network.
 *
 * The job runner is NOT started. The auction close is driven one tick at a time by the operator
 * side-car below, so the transcript shows the state transition rather than a race against a
 * printer. In production that same call is a job claimed under a lease.
 *
 *     MARKET_TEST_DATABASE_URL=postgres://…/market_test pnpm verify
 */

import { singleNetworkSql } from '../src/testsupport.ts'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { createServer, registerServiceMetrics } from '../src/server.ts'
import { closeAuction } from '../src/orders.ts'
import {
  ALICE,
  BOB,
  CAROL,
  fakeIndexer,
  fakeLedger,
  fakePolicy,
  fakeVerifier,
  migrateTestDb,
  openDb,
  resetMarket,
  sampleFacts,
} from '../src/testsupport.ts'
import type { Db } from '../src/outbox.ts'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

const sql = openDb(8)
await migrateTestDb(sql)
await resetMarket(sql)
const db = sql as unknown as Db

const ledger = fakeLedger()
const indexer = fakeIndexer()
const policy = fakePolicy()
indexer.setFacts('cf:mint:token:0192', sampleFacts())

const logger = new Logger({ service: 'market-verify', level: 'error' })
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
const verifier = fakeVerifier()

const queued: Array<{ kind: string; payload: Record<string, unknown> }> = []

const orders = { sql: db, ledger, producer: 'market' }
const bids = { sql: db, ledger, producer: 'market', auctionExtensionMs: 0 }

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: singleNetworkSql(db),
  singleNetwork: 'mainnet' as const,
  producer: 'market',
  listings: { sql: db, ledger, producer: 'market' },
  orders,
  bids,
  moderation: { sql: db, ledger, producer: 'market' },
  indexer,
  indexerNetwork: 'testnet',
  policy,
  queue: {
    async enqueue(options) {
      queued.push({ kind: options.kind, payload: (options.payload ?? {}) as Record<string, unknown> })
    },
  },
  eventSigningSecret: SECRET,
  platformFeeBps: 250,
  maxRoyaltyBps: 1_000,
  // Zero, so the transcript shows proceeds landing spendable rather than in payout_due. The
  // suite covers the other setting; a verify script that has to wait out a dispute window is a
  // verify script that is really a sleep.
  disputeWindowMs: 0,
  listingEnabled: true,
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as AddressInfo).port
lifecycle.markReady()

/**
 * The operator side-car. `/close?listingId=…` runs one auction close, which in production is a
 * leased job — and calling it twice is the whole point: the second call must answer
 * `already_closed` rather than settling again.
 */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const send = (body: unknown): void => {
    const payload = `${JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  if (url.pathname === '/close') {
    const listingId = url.searchParams.get('listingId') ?? ''
    void closeAuction(orders, { listingId, actor: 'system', correlationId: 'verify' })
      .then((result) => send({ listingId, result }))
      .catch((err: unknown) => send({ listingId, error: err instanceof Error ? err.message : String(err) }))
    return undefined
  }
  if (url.pathname === '/ledger') {
    return send({
      postedCount: ledger.postedCount,
      keys: ledger.keys,
      entries: ledger.entries,
    })
  }
  return send({ queued, users: { alice: ALICE, bob: BOB, carol: CAROL } })
})
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', () => resolve()))
const controlPort = (control.address() as AddressInfo).port

process.stdout.write(
  `${JSON.stringify({ service: port, control: controlPort, secret: SECRET, tokens: ['alice', 'bob', 'carol', 'admin'] })}\n`,
)
