/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this
 * file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. Here that matters twice over: below
 * `SCHEMA_VERSION` the `listings_active_is_escrowed` constraint may not exist, so a listing could
 * be opened for business holding nothing, and neither may `orders_listing_uniq`, so one item could
 * be sold twice. A service that could create those at boot is a service that could start without
 * them, and both of them are controls rather than conveniences.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import type { Db } from './outbox.ts'
import type { OrderDeps } from './orders.ts'
import type { BidDeps } from './bids.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  // Said at boot, because a marketplace with listing switched off looks exactly like a
  // marketplace that is broken until somebody reads the environment.
  listingEnabled: env.listingEnabled,
  platformFeeBps: env.platformFeeBps,
  maxRoyaltyBps: env.maxRoyaltyBps,
  disputeWindowMs: env.disputeWindowMs,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point: see
//    the file header for the two constraints a lower version would be missing.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The upstreams. Constructed before the Lifecycle so its probes can close over their URLs, and
//    all three take the same scoped service credential — never a shared one (SD-05).
//
//    ══════════════════════════════════════════════════════════════════════════════════════════
//    **THE CREDENTIAL IS EXCHANGED, NOT READ ONCE.** The line that used to be here was
//
//        const token = () => env.serviceToken
//
//    — a function called per request, returning a string read once at import from a token that
//    expires in 600 seconds. So this service authenticated to the ledger, the indexer and policy
//    exactly once per bootstrap and presented a dead token for the rest of the process's life. On
//    the live estate that token had been expired for SEVENTEEN AND A HALF HOURS while the
//    container served, policy answered 401 to every decision request, and — because
//    `policyclient.ts` correctly refuses to read a 401 as a verdict — every listing went up with
//    `degraded: true` and no moderation at all. Nothing was broken enough to notice.
//
//    The seam was right and the body was wrong, which is why the body now lives in `upstreams.ts` —
//    a module a test can import without starting a server, and the only way to write a test that
//    fails when THIS FILE regresses. That file carries the argument, including why the credential
//    is deliberately NOT wired to a hard readiness probe here.
//    ══════════════════════════════════════════════════════════════════════════════════════════
const upstreams = buildUpstreams(env, {
  originatingService: SERVICE,
  onEvent: (event) => {
    metrics.increment('market_service_token_events_total', { kind: event.kind })
    if (event.kind === 'minted') {
      // The token itself is never a field here, and must never become one. `service`, `expiresIn`
      // and the refresh interval are what an operator needs; the bearer is what an attacker needs.
      logger.info('minted a service token from the credential', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else if (event.kind === 'exchange_failed') {
      // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
      // token is still held is the outage this provider is built to ride out, and paging on it
      // would page on every identity blip.
      logger.warn('service credential exchange failed', { ...event })
    }
  },
})
const { ledger, indexer, policy } = upstreams

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Said at boot, at the level its consequence deserves, because the alternative is what actually
// happened: a marketplace that looks entirely healthy while its moderation gate is absent.
// ────────────────────────────────────────────────────────────────────────────────────────────────
if (upstreams.mode === 'none') {
  logger.fatal('NO CREDENTIAL AT ALL — every ledger, indexer and policy call will fail', {
    remedy: 'set MARKET_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
  })
} else if (upstreams.mode === 'static') {
  logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every upstream call will 401 about ten minutes from now', {
    // Said out loud so the failure an operator will hit is one they can search for.
    whatWillHappen:
      'MARKET_SERVICE_TOKEN lives 600s and nothing can renew it. From minute ten the ledger refuses ' +
      'every reservation and escrow, and policy 401s every decision — which policyclient.ts reads as ' +
      'a degraded gate, so listings keep going up UNMODERATED with no error anywhere.',
    remedy:
      'set MARKET_IDENTITY_CREDENTIAL in the deploy; estate-bootstrap.sh already mints it into tokens.env',
  })
} else {
  logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
}

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  // Generous, because a drain must not cut a settlement between the ledger entry and the order
  // row. That gap is the one place money could move with nothing in this service saying so.
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // **THE LEDGER IS HARD. EVERYTHING ELSE IS SOFT, AND THE SPLIT IS NOT A JUDGEMENT CALL.**
  //
  // 07-dependency-map marks `market → ledger` as hard for exactly the reason a probe encodes:
  // with the ledger unreachable, NOTHING this service exists to do can happen. A listing cannot
  // reserve, a bid cannot escrow, a sale cannot settle, an escrow cannot be released. A replica
  // in that state serves nothing but reads and should be taken out of rotation so the balancer
  // stops sending it work it will refuse.
  //
  // Policy and the indexer are soft because both have designed degradations — policy fails open
  // and flags, the indexer's indicators simply do not render. Marking either hard would remove
  // the whole marketplace from rotation for the duration of somebody else's incident, which is
  // the failure mode the estate already has and this arrangement exists to end.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'hard' }))
  .addProbe(httpProbe('indexer', `${env.indexerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('policy', `${env.policyUrl}/livez`, { kind: 'soft' }))

// 7. The dependency bundles, built once and shared.
const db = sql as unknown as Db
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // Longer than the default 60 seconds because an auction close holds its lease across a ledger
  // call per losing bidder. The status claim in `settleSale` is what makes two settlements
  // impossible; this is the budget for one attempt at it.
  leaseMs: 120_000,
})

const orders: OrderDeps = { sql: db, ledger, producer: SERVICE }
const bids: BidDeps = {
  sql: db,
  ledger,
  producer: SERVICE,
  auctionExtensionMs: env.auctionExtensionMs,
}

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: SERVICE,
  listings: { sql: db, ledger, producer: SERVICE },
  orders,
  bids,
  moderation: { sql: db, ledger, producer: SERVICE },
  indexer,
  indexerNetwork: env.indexerNetwork,
  policy,
  queue,
  // The same secret signs what this service emits and verifies what billing and identity send.
  // See the header of `server.ts`: an unsigned inbound event route is a free-delisting endpoint.
  eventSigningSecret: env.outboxSigningSecret,
  platformFeeBps: env.platformFeeBps,
  maxRoyaltyBps: env.maxRoyaltyBps,
  disputeWindowMs: env.disputeWindowMs,
  listingEnabled: env.listingEnabled,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)

    // Read out of the provider's own memory. `static` counts as usable because it is — for about
    // ten minutes — which is exactly why it needs the second gauge beside it rather than a kinder
    // reading of the first. Together they answer the question nothing could answer while the
    // token was dead: can this process authenticate right now, and is it even able to renew?
    metrics.set(
      'market_service_token_usable',
      upstreams.mode === 'exchanged'
        ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
          ? 1
          : 0
        : upstreams.mode === 'static'
          ? 1
          : 0,
    )
    metrics.set('market_service_token_static', upstreams.mode === 'static' ? 1 : 0)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  orders,
  bids,
  queue,
  sweepLimit: 100,
  // Fourteen days. It must outlive every caller's retry horizon: expiring a key EARLY means the
  // next replay of it buys the item a second time.
  idempotencyTtlDays: 14,
  actor: `service:${SERVICE}`,
})
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS, then the pool closes with nothing left to
//     use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
