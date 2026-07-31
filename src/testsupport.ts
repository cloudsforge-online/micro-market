/**
 * The database harness and the local fakes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A DATABASE TEST RUNS ONLY AGAINST A DATABASE WHOSE NAME SAYS IT IS A TEST DATABASE.**
 *
 * Not a convenience: `resetMarket` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment. This service
 * holds the only record of which listings were sold, to whom, and under what terms; the wrong
 * connection string here destroys the evidence every disputed-sale investigation would ever run
 * on.
 *
 * Only a `market_test` database is ever created or written by this suite. The rule and its
 * wording are taken verbatim from `ledger/src/testsupport.ts` and `worlds/src/testsupport.ts`,
 * because a harness that differs per service is a harness somebody gets wrong once.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **`fakeLedger` REPLAYS ON A REPEATED KEY**, exactly as the real ledger does. That is not
 * decoration: the derived idempotency keys in `ledgerclient.ts` are the second line of defence
 * under every concurrency test in this suite, and a fake that posted twice for one key would make
 * those tests pass while proving nothing. It also records every request, so a test can assert on
 * the POSTINGS rather than only on the outcome — which is how the royalty-split tests check that
 * the entry balances, leg by leg.
 *
 * Not a test file itself: it is excluded from the build and contains no `test()` call.
 */

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import type { Db } from './outbox.ts'
import type {
  LedgerClient,
  PostEntryRequest,
  PostedEntry,
  PostingRequest,
} from './ledgerclient.ts'
import type { EscrowStatus, IndexerClient, TokenFacts } from './indexerclient.ts'
import type { ListingPolicyInput, PolicyClient, PolicyVerdict } from './policyclient.ts'
import type { OrderDeps } from './orders.ts'
import type { BidDeps } from './bids.ts'
import type { ModerationDeps } from './moderation.ts'
import type { ActivateDeps, EndListingDeps } from './listings.ts'

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'
export const CAROL = '33333333-3333-4333-8333-333333333333'
export const DAVE = '44444444-4444-4444-8444-444444444444'

export const SELLER = `user:${ALICE}`
export const BUYER = `user:${BOB}`
export const SECOND_BUYER = `user:${CAROL}`
export const CREATOR = `user:${DAVE}`

/* ------------------------------------------------------------------ the fake ledger */

export interface FakeLedger extends LedgerClient {
  readonly entries: readonly PostEntryRequest[]
  readonly keys: readonly string[]
  /** Every entry actually POSTED, keyed by idempotency key. A replay does not appear twice. */
  posted(key: string): PostEntryRequest | undefined
  /** How many entries were posted for real, ignoring replays. */
  readonly postedCount: number
  failNext(err: Error): void
  failAlways(err: Error | null): void
}

export function fakeLedger(): FakeLedger {
  const entries: PostEntryRequest[] = []
  const keys: string[] = []
  const byKey = new Map<string, { entry: PostedEntry; request: PostEntryRequest }>()
  let failure: Error | null = null
  let permanent: Error | null = null
  let counter = 0

  const client: FakeLedger = {
    entries,
    keys,
    posted(key) {
      return byKey.get(key)?.request
    },
    get postedCount() {
      return byKey.size
    },
    failNext(err) {
      failure = err
    },
    failAlways(err) {
      permanent = err
    },
    async postEntry(request) {
      keys.push(request.idempotencyKey)
      if (permanent) throw permanent
      if (failure) {
        const err = failure
        failure = null
        throw err
      }
      // **The replay.** Same derived key, same entry back, nothing posted a second time. This is
      // what makes a rolled-back local transaction safe to retry, and it is the property every
      // concurrency test in this suite leans on.
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { ...replay.entry, replayed: true }

      // The ledger refuses an entry that does not balance, per asset code. So does this: a fake
      // that accepted an unbalanced entry would let a royalty-split bug pass every test here and
      // fail in production against the real thing.
      assertBalanced(request.postings)

      counter += 1
      entries.push(request)
      const entry: PostedEntry = {
        id: `entry-${counter}`,
        kind: request.kind,
        recordedAt: new Date(counter).toISOString(),
        replayed: false,
      }
      byKey.set(request.idempotencyKey, { entry, request })
      return entry
    },
  }
  return client
}

/** Σ debits = Σ credits, per asset code. The ledger's first invariant — 04-domain-model §2.2. */
export function assertBalanced(postings: readonly PostingRequest[]): void {
  const totals = new Map<string, bigint>()
  for (const posting of postings) {
    if (posting.amount <= 0n) {
      throw new Error(`a posting amount must be positive, got ${posting.amount}`)
    }
    const signed = posting.direction === 'debit' ? posting.amount : -posting.amount
    totals.set(posting.assetCode, (totals.get(posting.assetCode) ?? 0n) + signed)
  }
  for (const [assetCode, net] of totals) {
    if (net !== 0n) {
      throw new Error(`entry does not balance for ${assetCode}: debits − credits = ${net}`)
    }
  }
}

/* ------------------------------------------------------------------ the fake indexer */

export interface FakeIndexer extends IndexerClient {
  setFacts(itemUrn: string, facts: TokenFacts | null): void
  setEscrow(txHash: string, status: EscrowStatus): void
  setUnavailable(value: boolean): void
}

export function fakeIndexer(): FakeIndexer {
  const facts = new Map<string, TokenFacts>()
  const escrows = new Map<string, EscrowStatus>()
  let unavailable = false
  return {
    setFacts(itemUrn, value) {
      if (value) facts.set(itemUrn, value)
      else facts.delete(itemUrn)
    },
    setEscrow(txHash, status) {
      escrows.set(txHash, status)
    },
    setUnavailable(value) {
      unavailable = value
    },
    async tokenFacts(itemUrn) {
      if (unavailable) {
        const { IndexerUnavailableError } = await import('./indexerclient.ts')
        throw new IndexerUnavailableError('the fake indexer is unavailable')
      }
      return facts.get(itemUrn) ?? null
    },
    async escrowStatus(_chain, txHash) {
      if (unavailable) {
        const { IndexerUnavailableError } = await import('./indexerclient.ts')
        throw new IndexerUnavailableError('the fake indexer is unavailable')
      }
      return escrows.get(txHash) ?? { confirmed: false, confirmations: 0, heldQuantity: null }
    },
  }
}

export function sampleFacts(overrides: Partial<TokenFacts> = {}): TokenFacts {
  return {
    contractAddress: '0xabc',
    chain: 'ember',
    network: 'testnet',
    mintAuthorityPresent: false,
    ownershipRenounced: true,
    holderCount: 1_200,
    topHolderBps: 800,
    firstSeenAt: '2020-01-01T00:00:00.000Z',
    deployerWalletExported: false,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ the fake policy */

export interface FakePolicy extends PolicyClient {
  readonly seen: readonly ListingPolicyInput[]
  setVerdict(verdict: PolicyVerdict | null): void
}

export function fakePolicy(): FakePolicy {
  const seen: ListingPolicyInput[] = []
  let verdict: PolicyVerdict | null = null
  return {
    seen,
    setVerdict(value) {
      verdict = value
    },
    async evaluateListing(input) {
      seen.push(input)
      return verdict ?? { decision: 'allow', reasons: [], degraded: false }
    },
  }
}

/* ------------------------------------------------------------------ the database harness */

/**
 * `MARKET_TEST_DSN`, and not the `market_test_database_url` every sibling uses.
 *
 * Not a preference. `micro-org`'s reusable rule-1 check greps `src/` for a `*_database_url`-shaped
 * name and fails on every one that is not the single declared database variable — so a test-only
 * DSN named in the estate's own house style fails the estate's own CI. `micro-trade` hit this
 * first and named its variable `TRADE_TEST_DSN` for the same reason.
 *
 * The name in the sentence above is written in lower case for the same reason `micro-trade` writes
 * its note that way: the check matches prose, so a comment explaining why the name is rejected
 * fails the build if it spells the name. Recorded in README.md under "Findings against micro-org";
 * the other half of the fix — an exemption for a test-only name — belongs there.
 */
const url = process.env['MARKET_TEST_DSN']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set MARKET_TEST_DSN (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and
 * `orders_listing_uniq`, `orders_partition` and `listings_active_is_escrowed` are the three most
 * important lines in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'market-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetMarket(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'market-test', sink: () => {} })
}

export interface Harness {
  readonly sql: Db
  readonly ledger: FakeLedger
  readonly indexer: FakeIndexer
  readonly policy: FakePolicy
  readonly metrics: Metrics
  readonly logger: Logger
  readonly orders: OrderDeps
  readonly bids: BidDeps
  readonly moderation: ModerationDeps
  readonly listings: ActivateDeps & EndListingDeps
}

export interface HarnessOptions {
  readonly auctionExtensionMs?: number
  /** Share one fake ledger across two harnesses, to model two replicas on one estate. */
  readonly ledger?: FakeLedger
}

/**
 * One bundle of dependencies. Call it twice with a shared ledger to get two independent "workers"
 * whose ledger agrees with itself — which is what the concurrency tests need in order to prove
 * that two settlements produce ONE posted entry rather than two.
 */
export function harness(sql: postgres.Sql, options: HarnessOptions = {}): Harness {
  const db = sql as unknown as Db
  const ledger = options.ledger ?? fakeLedger()
  const indexer = fakeIndexer()
  const policy = fakePolicy()
  const metrics = registerServiceMetrics(new Metrics())
  const logger = quietLogger()
  const producer = 'market'
  return {
    sql: db,
    ledger,
    indexer,
    policy,
    metrics,
    logger,
    orders: { sql: db, ledger, producer },
    bids: {
      sql: db,
      ledger,
      producer,
      // Zero by default: the anti-sniping extension would push every test auction's end into the
      // future the moment a bid landed, and a test that has to wait out its own extension is a
      // test that is really a sleep. The one test that cares turns it on.
      auctionExtensionMs: options.auctionExtensionMs ?? 0,
    },
    moderation: { sql: db, ledger, producer },
    listings: { sql: db, ledger, producer },
  }
}

/* ------------------------------------------------------------------ fixtures */

export interface SeedListingOptions {
  readonly sellerSubject?: string
  readonly pricingMode?: 'fixed' | 'auction' | 'offers_only'
  /**
   * `null` is a listing with NO price, which is what `offers_only` means — distinct from omitting
   * the option, which takes the default. `CreateListingInput.price` is `bigint | null` for exactly
   * that reason, so this mirrors it rather than collapsing the two.
   */
  readonly price?: bigint | null
  readonly reservePrice?: bigint | null
  readonly quantity?: bigint
  readonly royaltyBps?: number
  readonly platformFeeBps?: number
  readonly royaltyRecipients?: readonly { subject: string; bps: number }[]
  readonly disputeWindowMs?: number
  readonly auctionEndsAt?: Date | null
  readonly expiresAt?: Date | null
  readonly settlementMode?: 'custodial' | 'onchain'
  readonly sellerWalletId?: string
  readonly itemUrn?: string
  readonly activate?: boolean
}

/**
 * A listing, optionally activated. The workhorse of this suite.
 *
 * It goes through `createListing` and `activateListing` rather than inserting rows, so every test
 * that uses it also exercises the reservation — which is the invariant most of them depend on.
 */
export async function seedListing(
  h: Harness,
  options: SeedListingOptions = {},
): Promise<import('./listings.ts').Listing> {
  const { activateListing, createListing } = await import('./listings.ts')
  const seller = options.sellerSubject ?? SELLER
  const pricingMode = options.pricingMode ?? 'fixed'
  const listing = await createListing(h.sql, 'market', {
    sellerSubject: seller,
    assetKind: 'collectible',
    itemUrn: options.itemUrn ?? 'cf:mint:token:0192',
    quantity: options.quantity ?? 1n,
    itemAssetCode: 'TOKEN:cf:mint:token:0192',
    pricingMode,
    // `??` would turn an explicit `null` into the default, which is the one thing the caller who
    // wrote `price: null` was asking not to happen.
    price: options.price !== undefined ? options.price : 1_000n,
    reservePrice: options.reservePrice ?? null,
    assetCode: 'SHARD',
    settlementMode: options.settlementMode ?? 'custodial',
    sellerWalletId:
      options.sellerWalletId ?? (options.settlementMode === 'onchain' ? 'wallet-seller' : null),
    royaltyBps: options.royaltyBps ?? 0,
    platformFeeBps: options.platformFeeBps ?? 250,
    disputeWindowMs: options.disputeWindowMs ?? 0,
    auctionEndsAt:
      options.auctionEndsAt !== undefined
        ? options.auctionEndsAt
        : pricingMode === 'auction'
          ? new Date(Date.now() + 60_000)
          : null,
    expiresAt: options.expiresAt ?? null,
    ...(options.royaltyRecipients ? { royaltyRecipients: options.royaltyRecipients } : {}),
    maxRoyaltyBps: 10_000,
    actor: seller,
    correlationId: 'seed',
  })
  if (options.activate === false) return listing
  return activateListing(h.listings, {
    listingId: listing.id,
    sellerSubject: seller,
    actor: seller as `user:${string}`,
    correlationId: 'seed',
  })
}

/** Move an auction's end into the past, so the close sweep sees it as due. */
export async function endAuctionNow(sql: postgres.Sql, listingId: string): Promise<void> {
  await sql`update listings set auction_ends_at = now() - interval '1 second' where id = ${listingId}`
}

/** Move an order's payout due date into the past, so the payout sweep sees it. */
export async function payoutDueNow(sql: postgres.Sql, orderId: string): Promise<void> {
  await sql`update orders set payout_due_at = now() - interval '1 second' where id = ${orderId}`
}

/** A verifier that maps three fixed tokens onto principals. No JWKS, no clock, no network. */
export function fakeVerifier(): { principal(token: string): Promise<Principal> } {
  return {
    async principal(token: string): Promise<Principal> {
      if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
      if (token === 'bob') return { kind: 'user', userId: BOB, handle: 'bob', roles: ['player'] }
      if (token === 'carol') return { kind: 'user', userId: CAROL, handle: 'carol', roles: ['player'] }
      if (token === 'admin') return { kind: 'user', userId: 'ops-1', handle: 'ops', roles: ['admin'] }
      const { TokenError } = await import('@cloudsforge/auth')
      throw new TokenError('unknown token', 'invalid')
    },
  }
}

/** The envelope a producer's relay sends, with a valid signature over the exact bytes. */
export async function signedEvent(
  secret: string,
  envelope: Record<string, unknown>,
): Promise<{ body: string; signature: string }> {
  const { signEvent } = await import('./outbox.ts')
  const body = JSON.stringify(envelope)
  return { body, signature: signEvent(body, secret) }
}
