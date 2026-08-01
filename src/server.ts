/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY MUTATING ROUTE IS IDEMPOTENT, AND THE FINGERPRINT EXCLUDES PER-ATTEMPT FIELDS.**
 *
 * A Buy button is double-clicked. A mobile client retries on a dropped connection. A job retries
 * after a lost response. Every one of those is a second POST for one intent, and on a marketplace
 * the cost of getting it wrong is a customer charged twice for one item — or, worse, told their
 * purchase failed when it succeeded.
 *
 * So `withIdempotency` wraps each mutating route: the claim and the work share one transaction,
 * a concurrent duplicate blocks and then replays, and a reused key with a genuinely different
 * body is a 409. The fingerprint deliberately **excludes** `correlationId` — a trace id is
 * supposed to change per attempt, and fingerprinting it made every honest retry 409 in the
 * ledger. That regression is documented in `ledger/src/idempotency.test.ts` and pinned here by
 * `idempotency.test.ts`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **`POST /v1/events` IS SIGNATURE-CHECKED BEFORE IT IS PARSED.** It consumes
 * `billing.entitlement.revoked` and `identity.user.deleted`, and an unsigned inbound event route
 * here is a free-delisting endpoint: anyone who can reach the port can assert that a seller's
 * entitlement was revoked and have their listings pulled off the market. The body is verified
 * against `OUTBOX_SIGNING_SECRET` over the exact bytes received, with a timing-safe comparison,
 * BEFORE `JSON.parse` is called on it.
 *
 * The fail-open / fail-closed split, which is the other thing easy to get backwards:
 *
 *   `GET /v1/listings/:id/risk`   fails OPEN. The indexer being down means a listing renders
 *                                 without its indicators — a worse page, not a wrong one.
 *   `POST /v1/listings`           fails OPEN on POLICY, and opens a moderation case. See
 *                                 `policyclient.ts`: failing closed shuts the marketplace for
 *                                 somebody else's incident, and failing open silently means an
 *                                 attacker who can DoS policy gets an unmoderated market.
 *   `POST …/activate` (onchain)   fails CLOSED on the indexer. "We could not confirm the escrow"
 *                                 must never become "list it anyway": that is a listing for an
 *                                 item the seller can still transfer.
 */

import { timingSafeEqual } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { JobQueue } from '@cloudsforge/jobs'
import { signEvent, withInbox, type Db } from './outbox.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import { MoneyError, parseAmount, type RoyaltyRecipient } from './money.ts'
import { LedgerRefusedError } from './ledgerclient.ts'
import { EscrowError } from './escrow.ts'
import {
  FrozenError,
  ListingError,
  ListingStateError,
  activateListing,
  cancelListing,
  createCollection,
  createListing,
  findListing,
  findVerification,
  listCollections,
  listListings,
  listingRoyalties,
  setVerification,
  type ActivateDeps,
  type AssetKind,
  type EndListingDeps,
  type Listing,
  type ListingStatus,
  type PricingMode,
  type SettlementMode,
  type VerificationLevel,
} from './listings.ts'
import {
  AuctionClosedError,
  BidError,
  BidTooLowError,
  closeOffer,
  findOffer,
  listBids,
  listOffers,
  makeOffer,
  placeBid,
  type BidDeps,
} from './bids.ts'
import {
  OrderError,
  findOrder,
  listOrders,
  settleSale,
  type Order,
  type OrderDeps,
} from './orders.ts'
import {
  ModerationError,
  listCases,
  listDisputes,
  openCase,
  openDispute,
  resolveCase,
  resolveDispute,
  type CaseAction,
  type CaseState,
  type CaseSubjectKind,
  type ModerationDeps,
} from './moderation.ts'
import {
  IndexerUnavailableError,
  type EscrowStatus,
  type IndexerClient,
} from './indexerclient.ts'
import { computeIndicators } from './risk.ts'
import type { PolicyClient } from './policyclient.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'market:read'
export const WRITE_SCOPE = 'market:write'
/** Moderation, verification and dispute resolution. Held by nothing that buys or sells. */
export const ADMIN_SCOPE = 'market:admin'

export const REVOKED_TOPIC = 'billing.entitlement.revoked'
export const USER_DELETED_TOPIC = 'identity.user.deleted'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly producer: string
  readonly listings: ActivateDeps & EndListingDeps
  readonly orders: OrderDeps
  readonly bids: BidDeps
  readonly moderation: ModerationDeps
  readonly indexer: IndexerClient
  /**
   * Which network an on-chain escrow is looked for on when the request does not say.
   *
   * A transaction hash is only meaningful with a network beside it — XRP's testnet and mainnet
   * share addresses outright — so the indexer requires both, and a default that is wrong answers
   * "no such transaction" for a transaction that exists.
   */
  readonly indexerNetwork: string
  readonly policy: PolicyClient
  readonly queue: Pick<JobQueue, 'enqueue'>
  /** Verifies inbound event signatures, and signs outbound ones. See the file header. */
  readonly eventSigningSecret: string
  readonly platformFeeBps: number
  readonly maxRoyaltyBps: number
  readonly disputeWindowMs: number
  readonly listingEnabled: boolean
  readonly now?: () => Date
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'market_listings_total',
      help: 'Listings created, by asset kind and settlement mode.',
      kind: 'counter',
      labels: ['asset_kind', 'settlement_mode'],
    })
    .register({
      name: 'market_orders_total',
      help: 'Orders settled, by source and settlement mode. The revenue line, counted.',
      kind: 'counter',
      labels: ['source', 'settlement_mode'],
    })
    .register({
      name: 'market_settlement_refusals_total',
      help: 'Settlements refused, by reason. A climbing `frozen` is moderation working; a climbing `ledger_refused` is buyers who cannot pay.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'market_auction_closes_total',
      help: 'Auction closes, by outcome. `already_closed` above zero means two workers raced and the claim held.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'market_payouts_total',
      help: 'Proceeds releases, by outcome. `disputed` is the dispute window doing its job.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'market_auctions_due',
      help: 'Auctions past their end and not yet closed. Sampled by the sweep, which is what closes them. Anything but a small number is a stalled closer.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'market_payouts_due',
      help: 'Orders whose dispute window has run and whose proceeds are still held.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'market_expired_last_pass',
      help: 'Listings and offers expired by the last sweep.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'market_policy_degraded_total',
      help: 'Listings created while policy was unreachable. Each opened a moderation case; a spike means the gate was absent, not merely slow.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'market_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the delisting endpoint.',
      kind: 'counter',
      labels: ['reason'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,200}$/
const MAX_BODY_BYTES = 256 * 1024
const SIGNATURE_HEADER = 'x-cloudsforge-signature'
const IDEMPOTENCY_HEADER = 'idempotency-key'
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const ASSET_KINDS = new Set<AssetKind>([
  'token',
  'game_item',
  'entitlement',
  'membership',
  'brand_asset',
  'collectible',
])
const PRICING_MODES = new Set<PricingMode>(['fixed', 'auction', 'offers_only'])
const SETTLEMENT_MODES = new Set<SettlementMode>(['custodial', 'onchain'])
const VERIFICATION_LEVELS = new Set<VerificationLevel>([
  'unverified',
  'claimed',
  'verified',
  'flagged',
])

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/v1/listings/:id` into a matcher. The segment pattern excludes `/` so a parameter
 * cannot swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

/**
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be legal. Fix it; retrying will not help.
 *   * **402** — the ledger said the buyer cannot pay. Not an error at all: an answer.
 *   * **403** — a scope, a role, or a FROZEN listing. The last gets its own code so a client can
 *     show the right sentence rather than "conflict".
 *   * **404** — something named does not exist, or belongs to somebody else. The same answer on
 *     purpose: a distinct 403 for the second is an enumeration oracle for who is selling what.
 *   * **409** — well formed, but the state refuses it: a bid that does not beat the leader, a
 *     listing already sold, an idempotency key reused with a different body.
 *   * **503** — an upstream is unreachable, or an idempotent request is still in flight.
 */
async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof FrozenError) {
      deps.metrics.increment('market_settlement_refusals_total', { reason: 'frozen' })
      // Its own code and its own status. "This is under review" is a different sentence from
      // "somebody else bought it", and a client should be able to say which.
      return errorReply(403, 'listing_frozen', err.message, ctx.requestId)
    }
    if (err instanceof BidTooLowError) {
      return {
        status: 409,
        body: {
          error: {
            code: 'bid_too_low',
            message: err.message,
            // The minimum, so a client can re-bid without a second round trip and without
            // guessing. A string: an amount is never a JSON number.
            minimum: err.minimum.toString(),
            requestId: ctx.requestId,
          },
        },
      }
    }
    if (err instanceof LedgerRefusedError) {
      deps.metrics.increment('market_settlement_refusals_total', { reason: 'ledger_refused' })
      // 402 rather than 409 or 500: the ledger looked at the request and said the money is not
      // there. That is an answer about the customer's balance, not a fault in this service.
      return errorReply(402, 'payment_refused', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reused', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      // 503 with a retry hint, not 409. The first attempt may still succeed, and telling a client
      // "conflict" for work that is about to commit is how a purchase gets reported as failed.
      return {
        status: 503,
        headers: { 'retry-after': '1' },
        body: { error: { code: 'in_flight', message: err.message, requestId: ctx.requestId } },
      }
    }
    if (
      err instanceof AuctionClosedError ||
      err instanceof ListingStateError ||
      err instanceof OrderError ||
      err instanceof EscrowError ||
      err instanceof ModerationError
    ) {
      return errorReply(409, 'state_conflict', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (
      err instanceof BadRequestError ||
      err instanceof ListingError ||
      err instanceof BidError ||
      err instanceof MoneyError ||
      err instanceof RangeError
    ) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof IndexerUnavailableError) {
      // FAIL CLOSED, and only on the route that needs the chain. See the file header.
      return errorReply(
        503,
        'indexer_unavailable',
        'the on-chain escrow could not be confirmed; try again shortly',
        ctx.requestId,
      )
    }
    if (err instanceof Error && err.name === 'LedgerUnavailableError') {
      ctx.log.error('the ledger could not be reached', { err })
      return errorReply(503, 'ledger_unavailable', 'this could not be settled; retry', ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* ------------------------------------------------------------------ inbound events */

    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      if (!presented || !verifySignature(raw, deps.eventSigningSecret, presented)) {
        deps.metrics.increment('market_events_rejected_total', { reason: 'bad_signature' })
        ctx.log.warn('an inbound event failed its signature check')
        return errorReply(401, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }

      let envelope: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object')
        }
        envelope = parsed as Record<string, unknown>
      } catch {
        deps.metrics.increment('market_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('the event body is not valid JSON')
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : ''
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : ''
      if (!UUID.test(eventId)) {
        deps.metrics.increment('market_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('an event envelope must carry a uuid id')
      }
      if (topic !== REVOKED_TOPIC && topic !== USER_DELETED_TOPIC) {
        // Accepted and ignored, with a 202. A 4xx would make the producer's relay retry an event
        // it is correct to send and we are correct not to act on, for ever.
        deps.metrics.increment('market_events_rejected_total', { reason: 'not_subscribed' })
        return { status: 202, body: { status: 'ignored', topic } }
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {}
      const subject =
        typeof payload['subject'] === 'string'
          ? payload['subject']
          : typeof payload['userId'] === 'string'
            ? `user:${payload['userId']}`
            : null
      if (!subject) throw new BadRequestError('the event payload must name a subject')

      const done = deps.lifecycle.track()
      try {
        // The handler marks the seller's listings for withdrawal and does NOT call the ledger.
        // Withdrawing a listing releases escrows, which is a network call per escrow; doing that
        // inside the webhook would couple billing's relay timeout to how many bids a seller has,
        // and a slow withdrawal would make the relay redeliver an event we have already acted on.
        const outcome = await withInbox(deps.sql, topic, eventId, async (tx) => {
          const rows = await tx<{ id: string }[]>`
            update listings set expires_at = now(), updated_at = now()
             where seller_subject = ${subject} and status in ('draft','active')
            returning id
          `
          return rows.length
        })
        if (outcome.status === 'processed') {
          ctx.log.info('seller listings marked for withdrawal', {
            topic,
            subject,
            listings: outcome.value,
          })
        }
        return {
          status: 202,
          body: {
            status: outcome.status,
            ...(outcome.status === 'processed' ? { listings: outcome.value } : {}),
          },
        }
      } finally {
        done()
      }
    }),

    /* ------------------------------------------------------------------ collections */

    define('GET', '/v1/collections', async (ctx, deps) => {
      const owner = ctx.url.searchParams.get('ownerSubject') ?? undefined
      const collections = await listCollections(deps.sql, owner)
      return { status: 200, body: { collections } }
    }),

    define('POST', '/v1/collections', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const collection = await createCollection(deps.sql, {
        ownerSubject: subjectOf(principal),
        slug: requireString(body, 'slug'),
        name: requireString(body, 'name'),
        description: typeof body['description'] === 'string' ? body['description'] : '',
        royalties: readRoyalties(body['royalties']),
      })
      return { status: 201, body: { collection } }
    }),

    /* ------------------------------------------------------------------ listings */

    define('GET', '/v1/listings', async (ctx, deps) => {
      const status = ctx.url.searchParams.get('status')
      const assetKind = ctx.url.searchParams.get('assetKind')
      const listings = await listListings(deps.sql, {
        // Defaults to `active`. A browse endpoint that defaulted to everything would show drafts
        // and cancellations to buyers, which is both confusing and a leak of what sellers tried.
        status: (status ?? 'active') as ListingStatus,
        ...(assetKind ? { assetKind: assetKind as AssetKind } : {}),
        ...(ctx.url.searchParams.get('sellerSubject')
          ? { sellerSubject: ctx.url.searchParams.get('sellerSubject') as string }
          : {}),
        ...(ctx.url.searchParams.get('collectionId')
          ? { collectionId: ctx.url.searchParams.get('collectionId') as string }
          : {}),
      })
      return { status: 200, body: { listings: listings.map(listingWire) } }
    }),

    define('GET', '/v1/listings/:id', async (ctx, deps) => {
      const listing = await findListing(deps.sql, itemIdOf(ctx))
      if (!listing) throw new NotFoundError('no such listing')
      return {
        status: 200,
        body: {
          listing: listingWire(listing),
          royalties: (await listingRoyalties(deps.sql, listing.id)).map((share) => ({
            subject: share.subject,
            bps: share.bps,
          })),
        },
      }
    }),

    define('POST', '/v1/listings', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      if (!deps.listingEnabled) {
        // Paused, not broken. Nothing already listed is affected and nothing is lost.
        return errorReply(503, 'listing_paused', 'new listings are temporarily paused', ctx.requestId)
      }
      const body = await readJson(ctx.req)
      const seller = subjectOf(principal)

      const assetKind = requireEnum(body, 'assetKind', ASSET_KINDS)
      const pricingMode = requireEnum(body, 'pricingMode', PRICING_MODES)
      const settlementMode = requireEnum(body, 'settlementMode', SETTLEMENT_MODES)
      const price = body['price'] === undefined || body['price'] === null
        ? null
        : parseAmount(body['price'], 'price')

      // The policy gate. Fail-open AND flagged — see policyclient.ts. A verdict of `deny` is a
      // decision and is honoured; an outage is a `review` that still lists.
      const verdict = await deps.policy.evaluateListing({
        sellerSubject: seller,
        assetKind,
        itemUrn: requireString(body, 'itemUrn'),
        amount: (price ?? 0n).toString(),
        assetCode: requireString(body, 'assetCode'),
        settlementMode,
      })
      if (verdict.decision === 'deny') {
        return errorReply(403, 'policy_denied', verdict.reasons.join(', ') || 'refused by policy', ctx.requestId)
      }

      return withIdempotentRoute(ctx, deps, '/v1/listings', body, async () => {
        const listing = await createListing(deps.sql, deps.producer, {
          sellerSubject: seller,
          sellerWalletId: typeof body['sellerWalletId'] === 'string' ? body['sellerWalletId'] : null,
          collectionId: typeof body['collectionId'] === 'string' ? body['collectionId'] : null,
          assetKind,
          itemUrn: requireString(body, 'itemUrn'),
          quantity: parseAmount(body['quantity'] ?? '1', 'quantity'),
          itemAssetCode: requireString(body, 'itemAssetCode') as LedgerAssetCode,
          pricingMode,
          price,
          reservePrice:
            body['reservePrice'] === undefined || body['reservePrice'] === null
              ? null
              : parseAmount(body['reservePrice'], 'reservePrice'),
          assetCode: requireString(body, 'assetCode') as LedgerAssetCode,
          settlementMode,
          royaltyBps: readBps(body['royaltyBps'] ?? 0),
          // Snapshotted from the environment, not read at settlement. See listings.ts.
          platformFeeBps: deps.platformFeeBps,
          disputeWindowMs: settlementMode === 'custodial' ? deps.disputeWindowMs : 0,
          auctionEndsAt: readDate(body['auctionEndsAt']),
          expiresAt: readDate(body['expiresAt']),
          ...(body['royaltyRecipients'] !== undefined
            ? { royaltyRecipients: readRoyalties(body['royaltyRecipients']) }
            : {}),
          maxRoyaltyBps: deps.maxRoyaltyBps,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('market_listings_total', {
          asset_kind: assetKind,
          settlement_mode: settlementMode,
        })

        // The flag half of "fail-open, flagged for review". The listing exists; a human is told.
        if (verdict.degraded || verdict.decision === 'review') {
          if (verdict.degraded) deps.metrics.increment('market_policy_degraded_total')
          await openCase(deps.moderation, {
            subjectKind: 'listing',
            subjectUrn: `cf:market:listing:${listing.id}`,
            listingId: listing.id,
            reason: verdict.degraded
              ? 'policy was unreachable when this listing was created'
              : `policy asked for review: ${verdict.reasons.join(', ')}`,
            // `none`, deliberately. A degraded gate must not freeze the marketplace during a
            // policy outage — that would be failing closed by another route. It raises a case for
            // a human and leaves the listing sellable.
            action: 'none',
            openedBy: 'system',
            correlationId: ctx.requestId,
          })
        }
        return {
          response: { listing: listingWire(listing), policy: verdict },
          artefactId: listing.id,
        }
      })
    }),

    define('POST', '/v1/listings/:id/activate', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const listingId = itemIdOf(ctx)
      const body = await readJson(ctx.req)

      const draft = await findListing(deps.sql, listingId)
      if (!draft || draft.sellerSubject !== subjectOf(principal)) {
        throw new NotFoundError('no such listing')
      }

      let onchainTx: string | null = null
      if (draft.settlementMode === 'onchain') {
        onchainTx = requireString(body, 'onchainEscrowTx')
        // FAIL CLOSED, unchanged: "we could not confirm the escrow" must never become "list it
        // anyway", and an `IndexerUnavailableError` from here is a 503 (see `errorStatus`) rather
        // than a refusal of the listing.
        //
        // What changed is the REASON a refusal carries. This route used to answer "the on-chain
        // escrow is not confirmed yet" for every activation, including the ones where the indexer
        // had never heard of the transaction, because the route it called did not exist. A seller
        // reading that waits for a confirmation that is never coming; an operator reading it
        // investigates the chain instead of the integration. So the refusal now names which of
        // the five things actually happened.
        const chain = typeof body['chain'] === 'string' ? body['chain'] : 'ember'
        const network =
          typeof body['network'] === 'string' ? body['network'] : deps.indexerNetwork
        const status = await deps.indexer.escrowStatus(chain, network, onchainTx)
        if (!status.confirmed) {
          throw new ListingStateError(escrowRefusal(status, chain, network))
        }
      }

      const listing = await activateListing(deps.listings, {
        listingId,
        sellerSubject: subjectOf(principal),
        onchainEscrowTx: onchainTx,
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { listing: listingWire(listing) } }
    }),

    define('DELETE', '/v1/listings/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const listing = await cancelListing(deps.listings, {
        listingId: itemIdOf(ctx),
        sellerSubject: subjectOf(principal),
        reason: 'withdrawn by the seller',
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { listing: listingWire(listing) } }
    }),

    /** Computed risk indicators. Fails OPEN: a listing without indicators beats no listing. */
    define('GET', '/v1/listings/:id/risk', async (ctx, deps) => {
      const listing = await findListing(deps.sql, itemIdOf(ctx))
      if (!listing) throw new NotFoundError('no such listing')
      const verification = await findVerification(deps.sql, listing.itemUrn)
      try {
        const facts = await deps.indexer.tokenFacts(listing.itemUrn)
        return {
          status: 200,
          body: {
            verification,
            indicators: facts ? computeIndicators(facts, (deps.now ?? (() => new Date()))()) : [],
            // Said explicitly rather than inferred from an empty array. "We have no indicators"
            // and "we could not fetch them" must not look the same to a client, or a broken
            // indexer renders as a clean bill of health.
            indicatorsAvailable: facts !== null,
          },
        }
      } catch (err) {
        ctx.log.warn('risk indicators unavailable', { err })
        return {
          status: 200,
          body: { verification, indicators: [], indicatorsAvailable: false },
        }
      }
    }),

    /* ------------------------------------------------------------------ buying */

    define('POST', '/v1/listings/:id/buy', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const listingId = itemIdOf(ctx)
      const body = await readJson(ctx.req)

      return withIdempotentRoute(ctx, deps, '/v1/listings/:id/buy', { listingId, ...body }, async () => {
        const result = await settleSale(deps.orders, {
          listingId,
          buyerSubject: subjectOf(principal),
          amount: parseAmount(body['amount'], 'amount'),
          source: 'purchase',
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        if (!result.replayed) {
          deps.metrics.increment('market_orders_total', {
            source: 'purchase',
            settlement_mode: result.order.settlementMode,
          })
        }
        return {
          response: { order: orderWire(result.order), replayed: result.replayed },
          artefactId: result.order.id,
        }
      })
    }),

    define('GET', '/v1/listings/:id/bids', async (ctx, deps) => {
      const bids = await listBids(deps.sql, itemIdOf(ctx))
      return {
        status: 200,
        body: {
          bids: bids.map((bid) => ({
            id: bid.id,
            bidderSubject: bid.bidderSubject,
            amount: bid.amount.toString(),
            assetCode: bid.assetCode,
            status: bid.status,
            placedAt: bid.placedAt.toISOString(),
          })),
        },
      }
    }),

    define('POST', '/v1/listings/:id/bids', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const listingId = itemIdOf(ctx)
      const body = await readJson(ctx.req)

      return withIdempotentRoute(ctx, deps, '/v1/listings/:id/bids', { listingId, ...body }, async () => {
        const result = await placeBid(deps.bids, {
          listingId,
          bidderSubject: subjectOf(principal),
          amount: parseAmount(body['amount'], 'amount'),
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        return {
          response: {
            bid: {
              id: result.bid.id,
              amount: result.bid.amount.toString(),
              assetCode: result.bid.assetCode,
              status: result.bid.status,
            },
            outbid: result.outbid?.id ?? null,
            auctionEndsAt: result.extendedTo?.toISOString() ?? null,
          },
          artefactId: result.bid.id,
        }
      })
    }),

    define('GET', '/v1/listings/:id/offers', async (ctx, deps) => {
      const offers = await listOffers(deps.sql, itemIdOf(ctx))
      return { status: 200, body: { offers: offers.map(offerWire) } }
    }),

    define('POST', '/v1/listings/:id/offers', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const listingId = itemIdOf(ctx)
      const body = await readJson(ctx.req)

      return withIdempotentRoute(ctx, deps, '/v1/listings/:id/offers', { listingId, ...body }, async () => {
        const offer = await makeOffer(deps.bids, {
          listingId,
          offererSubject: subjectOf(principal),
          amount: parseAmount(body['amount'], 'amount'),
          expiresAt: readDate(body['expiresAt']),
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        return { response: { offer: offerWire(offer) }, artefactId: offer.id }
      })
    }),

    define('DELETE', '/v1/offers/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const offer = await closeOffer(deps.bids, {
        offerId: itemIdOf(ctx),
        to: 'withdrawn',
        offererSubject: subjectOf(principal),
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { offer: offerWire(offer) } }
    }),

    /** The seller accepts an offer. Settles at the OFFER's amount, not the listing's price. */
    define('POST', '/v1/offers/:id/accept', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const offerId = itemIdOf(ctx)
      const offer = await findOffer(deps.sql, offerId)
      if (!offer) throw new NotFoundError('no such offer')
      const listing = await findListing(deps.sql, offer.listingId)
      if (!listing || listing.sellerSubject !== subjectOf(principal)) {
        throw new NotFoundError('no such offer')
      }
      if (offer.status !== 'open') throw new ListingStateError(`this offer is ${offer.status}`)

      return withIdempotentRoute(ctx, deps, '/v1/offers/:id/accept', { offerId }, async () => {
        const result = await settleSale(deps.orders, {
          listingId: offer.listingId,
          buyerSubject: offer.offererSubject,
          amount: offer.amount,
          source: 'offer',
          fundsEscrowId: offer.escrowId,
          offerId: offer.id,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        if (!result.replayed) {
          deps.metrics.increment('market_orders_total', {
            source: 'offer',
            settlement_mode: result.order.settlementMode,
          })
        }
        return {
          response: { order: orderWire(result.order), replayed: result.replayed },
          artefactId: result.order.id,
        }
      })
    }),

    /* ------------------------------------------------------------------ orders and disputes */

    define('GET', '/v1/orders', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const subject = subjectOf(principal)
      const role = ctx.url.searchParams.get('role') === 'seller' ? 'seller' : 'buyer'
      const orders = await listOrders(deps.sql, {
        ...(role === 'seller' ? { sellerSubject: subject } : { buyerSubject: subject }),
      })
      return { status: 200, body: { orders: orders.map(orderWire) } }
    }),

    define('GET', '/v1/orders/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const order = await findOrder(deps.sql, itemIdOf(ctx))
      if (!order) throw new NotFoundError('no such order')
      const subject = subjectOf(principal)
      // "Does not exist" and "is not yours" are the same answer on purpose.
      if (!isAdmin(principal) && order.buyerSubject !== subject && order.sellerSubject !== subject) {
        throw new NotFoundError('no such order')
      }
      return { status: 200, body: { order: orderWire(order) } }
    }),

    define('POST', '/v1/orders/:id/disputes', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const orderId = itemIdOf(ctx)
      // Wrapped, like every other mutating route on this service — this one was not, and
      // `openDispute` is a plain INSERT with no natural-key uniqueness behind it
      // (`moderation.ts:375`). So a double-clicked button, or any client that retried a request
      // whose response it never saw, opened TWO disputes on one order and froze the listing
      // twice. Found by micro-sdk while cataloguing which public routes require an
      // Idempotency-Key: the answer for this one was "none", and it should never have been.
      return withIdempotentRoute(ctx, deps, '/v1/orders/:id/disputes', { orderId, ...body }, async () => {
        const dispute = await openDispute(deps.moderation, {
          orderId,
          raiserSubject: subjectOf(principal),
          reason: requireString(body, 'reason'),
          correlationId: ctx.requestId,
        })
        return { response: { dispute: disputeWire(dispute) }, artefactId: dispute.id }
      })
    }),

    define('GET', '/v1/disputes', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const state = ctx.url.searchParams.get('state')
      const disputes = await listDisputes(deps.sql, {
        ...(state ? { state: state as 'open' } : {}),
      })
      return { status: 200, body: { disputes: disputes.map(disputeWire) } }
    }),

    define('POST', '/v1/disputes/:id/resolve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const body = await readJson(ctx.req)
      const resolution = body['resolution']
      if (resolution !== 'refunded' && resolution !== 'upheld') {
        throw new BadRequestError('resolution must be "refunded" or "upheld"')
      }
      const result = await resolveDispute(deps.moderation, {
        disputeId: itemIdOf(ctx),
        resolution,
        resolvedBy: operatorIdOf(principal),
        correlationId: ctx.requestId,
      })
      return {
        status: 200,
        body: {
          dispute: disputeWire(result.dispute),
          order: orderWire(result.order),
          reversalEntryId: result.reversalEntryId,
        },
      }
    }),

    /* ------------------------------------------------------------------ moderation */

    define('GET', '/v1/moderation/cases', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const state = ctx.url.searchParams.get('state')
      const cases = await listCases(deps.sql, {
        ...(state ? { state: state as CaseState } : {}),
        ...(ctx.url.searchParams.get('subjectUrn')
          ? { subjectUrn: ctx.url.searchParams.get('subjectUrn') as string }
          : {}),
      })
      return { status: 200, body: { cases } }
    }),

    define('POST', '/v1/moderation/cases', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const body = await readJson(ctx.req)
      // `moderation_cases` has no unique constraint, so a retried open makes a second case on one
      // subject and an operator queue grows duplicates of the thing it exists to surface once.
      // Same shape as the dispute route above, found while auditing which mutating routes were
      // unwrapped.
      return withIdempotentRoute(ctx, deps, '/v1/moderation/cases', body, async () => {
        const opened = await openCase(deps.moderation, {
          subjectKind: requireString(body, 'subjectKind') as CaseSubjectKind,
          subjectUrn: requireString(body, 'subjectUrn'),
          listingId: typeof body['listingId'] === 'string' ? body['listingId'] : null,
          reason: requireString(body, 'reason'),
          action: (typeof body['action'] === 'string' ? body['action'] : 'none') as CaseAction,
          openedBy: operatorIdOf(principal),
          correlationId: ctx.requestId,
        })
        return { response: { case: opened }, artefactId: opened.id }
      })
    }),

    define('POST', '/v1/moderation/cases/:id/resolve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const body = await readJson(ctx.req)
      const state = body['state']
      if (state !== 'upheld' && state !== 'dismissed') {
        throw new BadRequestError('state must be "upheld" or "dismissed"')
      }
      const resolved = await resolveCase(deps.moderation, {
        caseId: itemIdOf(ctx),
        state,
        resolvedBy: operatorIdOf(principal),
        ...(typeof body['notes'] === 'string' ? { notes: body['notes'] } : {}),
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { case: resolved } }
    }),

    /* ------------------------------------------------------------------ verification */

    define('GET', '/v1/verifications/:urn', async (ctx, deps) => {
      const urn = ctx.params['urn']
      if (!urn) throw new NotFoundError('no such subject')
      return { status: 200, body: { verification: await findVerification(deps.sql, decodeURIComponent(urn)) } }
    }),

    define('PUT', '/v1/verifications/:urn', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireOperator(principal)
      const urn = ctx.params['urn']
      if (!urn) throw new NotFoundError('no such subject')
      const body = await readJson(ctx.req)
      const level = requireEnum(body, 'level', VERIFICATION_LEVELS)
      const verification = await setVerification(deps.sql, {
        subjectUrn: decodeURIComponent(urn),
        level,
        ...(typeof body['evidence'] === 'object' && body['evidence'] !== null
          ? { evidence: body['evidence'] as Record<string, unknown> }
          : {}),
        reviewedBy: operatorIdOf(principal),
      })
      return { status: 200, body: { verification } }
    }),
  ]
}

/* ------------------------------------------------------------------ the idempotency wrapper */

/**
 * Wrap a mutating route in `withIdempotency`, keyed on the `Idempotency-Key` header.
 *
 * The header is **required**. Making it optional would mean the safe path is the one a client has
 * to remember, and the unsafe one is the default — which on a marketplace means a double-clicked
 * Buy button charges twice for anybody who did not read the documentation.
 *
 * The fingerprint is taken over the request body plus the path parameters, so the same key
 * presented against a different listing is caught rather than replayed. `correlationId` is
 * excluded inside `requestFingerprint`; see its header for the defect that taught us.
 */
async function withIdempotentRoute(
  ctx: RequestContext,
  deps: ServerDeps,
  route: string,
  fingerprintSubject: Record<string, unknown>,
  run: () => Promise<{ response: Record<string, unknown>; artefactId: string | null }>,
): Promise<Reply> {
  const key = headerOf(ctx.req, IDEMPOTENCY_HEADER)
  if (!key || !SAFE_IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestError(
      'an Idempotency-Key header of 8 to 200 characters is required on every mutating request',
    )
  }
  const outcome = await withIdempotency<Record<string, unknown>>(deps.sql, {
    originatingService: deps.producer,
    route,
    clientKey: key,
    requestHash: requestFingerprint(fingerprintSubject),
    run: async () => {
      const { response, artefactId } = await run()
      return { response, artefactId }
    },
  })
  return {
    status: outcome.replayed ? 200 : 201,
    // Said on the wire, so a client can tell "I created this" from "this already existed". A
    // client that cannot tell writes its own duplicate-detection, badly.
    body: { ...outcome.result, replayed: outcome.replayed },
  }
}

/* ------------------------------------------------------------------ wire shapes */

function listingWire(listing: Listing): Record<string, unknown> {
  return {
    id: listing.id,
    sellerSubject: listing.sellerSubject,
    collectionId: listing.collectionId,
    assetKind: listing.assetKind,
    itemUrn: listing.itemUrn,
    // Every amount a decimal STRING. A JSON number is an IEEE 754 double.
    quantity: listing.quantity.toString(),
    itemAssetCode: listing.itemAssetCode,
    pricingMode: listing.pricingMode,
    price: listing.price?.toString() ?? null,
    // The reserve is NOT on the wire. It is the seller's secret floor, and publishing it would
    // tell every bidder exactly what to bid — which is the same as not having one.
    assetCode: listing.assetCode,
    settlementMode: listing.settlementMode,
    royaltyBps: listing.royaltyBps,
    platformFeeBps: listing.platformFeeBps,
    auctionEndsAt: listing.auctionEndsAt?.toISOString() ?? null,
    expiresAt: listing.expiresAt?.toISOString() ?? null,
    status: listing.status,
    frozen: listing.frozen,
    escrowed: listing.escrowId !== null || listing.onchainEscrowTx !== null,
    createdAt: listing.createdAt.toISOString(),
  }
}

function orderWire(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    listingId: order.listingId,
    buyerSubject: order.buyerSubject,
    sellerSubject: order.sellerSubject,
    itemUrn: order.itemUrn,
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
    proceedsState: order.proceedsState,
    payoutDueAt: order.payoutDueAt?.toISOString() ?? null,
    settledAt: order.settledAt.toISOString(),
    royalties: order.royalties.map((share) => ({
      subject: share.subject,
      amount: share.amount.toString(),
    })),
  }
}

function offerWire(offer: {
  id: string
  listingId: string
  offererSubject: string
  amount: bigint
  assetCode: string
  status: string
  expiresAt: Date | null
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: offer.id,
    listingId: offer.listingId,
    offererSubject: offer.offererSubject,
    amount: offer.amount.toString(),
    assetCode: offer.assetCode,
    status: offer.status,
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    createdAt: offer.createdAt.toISOString(),
  }
}

function disputeWire(dispute: {
  id: string
  orderId: string
  raiserSubject: string
  reason: string
  state: string
  resolutionEntryId: string | null
  openedAt: Date
}): Record<string, unknown> {
  return {
    id: dispute.id,
    orderId: dispute.orderId,
    raiserSubject: dispute.raiserSubject,
    reason: dispute.reason,
    state: dispute.state,
    resolutionEntryId: dispute.resolutionEntryId,
    openedAt: dispute.openedAt.toISOString(),
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Why an on-chain escrow was refused, in words a seller can act on.
 *
 * The old message was a single sentence — "the on-chain escrow is not confirmed yet" — used for
 * every outcome, and it was false for every one of them, because the route it was derived from
 * did not exist. Five things can be true here and only one of them is "wait a bit longer"; the
 * other four are things the seller or an operator must go and DO something about. A diagnosis
 * that cannot distinguish them is worse than no diagnosis, because it directs the reader at the
 * chain when the problem is the hash, the network, or a reverted transaction.
 */
export function escrowRefusal(status: EscrowStatus, chain: string, network: string): string {
  if (!status.known) {
    return `the indexer has no record of that transaction on ${chain}/${network} — check the hash and the network`
  }
  if (status.halted) {
    return `the indexer has halted ${chain}/${network} after a deep reorganisation, so no escrow can be confirmed on it`
  }
  if (!status.canonical) {
    return `that transaction is not on the canonical chain of ${chain}/${network} (${status.status ?? 'unknown'})`
  }
  if (status.status !== 'success') {
    return `that transaction did not succeed on ${chain}/${network} (${status.status ?? 'unknown'})`
  }
  const seen = status.confirmations ?? 0
  const needed = status.requiredConfirmations
  return needed === null
    ? `the on-chain escrow is not confirmed yet (${seen} confirmations)`
    : `the on-chain escrow is not confirmed yet (${seen} of ${needed} confirmations)`
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/** Moderation, verification and dispute resolution. An ordinary buyer's token never reaches it. */
function requireOperator(principal: Principal): void {
  if (principal.kind === 'service') {
    requireScope(principal, ADMIN_SCOPE)
    return
  }
  if (!isAdmin(principal)) throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)
}

function subjectOf(principal: Principal): string {
  return principal.kind === 'user'
    ? `user:${subjectUserId(principal, undefined)}`
    : `service:${principal.service}`
}

function actorOf(principal: Principal): `user:${string}` | `service:${string}` {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

function operatorIdOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.service
}

/**
 * A path parameter that will be compared against a `uuid` column.
 *
 * Checked in the application rather than left to Postgres, because Postgres answers a malformed
 * uuid with error 22P02 — which reaches the error handler as an unrecognised fault and becomes a
 * 500. A caller typing a wrong id would then get "something went wrong on our side" for a request
 * that was simply about a thing that does not exist.
 */
function itemIdOf(ctx: RequestContext): string {
  const id = ctx.params['id'] ?? ''
  if (!UUID.test(id)) throw new NotFoundError('no such record')
  return id
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value.trim()
}

function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
): T {
  const value = requireString(body, field)
  if (!allowed.has(value as T)) {
    throw new BadRequestError(`${field} must be one of ${[...allowed].join(', ')}`)
  }
  return value as T
}

function readBps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new BadRequestError('basis points must be a whole number between 0 and 10000')
  }
  return value
}

function readDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new BadRequestError('a timestamp must be an ISO 8601 string')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${value} is not a valid timestamp`)
  return parsed
}

function readRoyalties(value: unknown): readonly RoyaltyRecipient[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadRequestError('royalties must be an array')
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new BadRequestError('each royalty recipient must be an object')
    }
    const record = entry as Record<string, unknown>
    return { subject: requireString(record, 'subject'), bps: readBps(record['bps']) }
  })
}

/**
 * Verify a MAC over the exact bytes received, in constant time.
 *
 * Timing-safe because a byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle: an
 * attacker who can measure the comparison can recover a valid signature one character at a time
 * without ever knowing the key.
 */
function verifySignature(body: Buffer, secret: string, presented: string): boolean {
  const expected = Buffer.from(signEvent(body.toString('utf8'), secret))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** The raw bytes, for the signature check. Capped before buffering. */
async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // An unbounded body is a memory exhaustion primitive that any UNAUTHENTICATED caller can
    // reach on this route, since the signature cannot be checked until the bytes are in hand.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
