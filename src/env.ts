/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from worlds, which took them from custody:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## `MARKET_PLATFORM_FEE_BPS` and `MARKET_MAX_ROYALTY_BPS` are money controls
 *
 * A fee and a royalty are both taken out of a seller's proceeds. Together they can, in principle,
 * exceed the sale price — at which point `sellerProceeds` is negative and the ledger refuses the
 * entry after the buyer's funds have already been claimed. So the two ceilings are validated
 * against each other **here**, at boot, where the variables are named, rather than being
 * discovered by the first sale that trips them. See `money.ts`, which enforces the same bound per
 * listing.
 *
 * ## `MARKET_DISPUTE_WINDOW_MS` is not a tuning knob either
 *
 * It is how long a seller's proceeds sit in `payout_due` before they become spendable, and it is
 * the entire window in which AD-14's "reversible by an operator during a dispute window" is true.
 * Zero is permitted and means "no window": proceeds land in `available` at settlement and a
 * refund then has to claw back money the seller may already have spent. That is a real business
 * choice, so it is allowed — but it is not the default.
 */

import { hostname } from 'node:os'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'market'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * HMAC key for outbound event signatures — and for VERIFYING the inbound ones.
   *
   * Market consumes `billing.entitlement.revoked` and `identity.user.deleted` on the same inbound
   * route it signs its own events with. An unsigned inbound event route on THIS service is a
   * free-delisting endpoint: anyone who can reach the port can assert that a seller's entitlement
   * was revoked and have their listings pulled.
   */
  readonly outboxSigningSecret: string
  readonly instanceId: string

  /** **Hard.** Every reservation, escrow, settlement, fee and royalty is a call to this. */
  readonly ledgerUrl: string
  /** Soft for risk indicators; hard for confirming an on-chain settlement — 07 §dependency map. */
  readonly indexerUrl: string
  /** Soft, fail-open-and-flag. See `policyclient.ts` for why a gate that fails closed is worse. */
  readonly policyUrl: string
  /** The scoped service credential. Not shared: SD-05. */
  readonly serviceToken: string
  readonly upstreamDeadlineMs: number

  /**
   * The platform's cut of a sale, in basis points. Deducted from the seller's proceeds, never
   * added to the buyer's price — a buyer pays what the listing says.
   */
  readonly platformFeeBps: number
  /** The ceiling a listing's `royalty_bps` may not exceed. A creator cannot set 100%. */
  readonly maxRoyaltyBps: number
  /**
   * How long a seller's proceeds sit in `payout_due` after settlement before a payout job moves
   * them to `available`. Zero disables the window; see the file header.
   */
  readonly disputeWindowMs: number
  /**
   * Anti-sniping. A bid landing within this long of an auction's end pushes the end out by the
   * same amount. Zero disables it.
   */
  readonly auctionExtensionMs: number
  /** Listing creation can be paused without pausing the service. Nothing already listed is lost. */
  readonly listingEnabled: boolean
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/** Basis points. 10,000 = 100%. The denominator of every fee and royalty in this service. */
export const BPS_SCALE = 10_000

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const platformFeeBps = integer(source, 'MARKET_PLATFORM_FEE_BPS', 250, 0, BPS_SCALE)
  const maxRoyaltyBps = integer(source, 'MARKET_MAX_ROYALTY_BPS', 1_000, 0, BPS_SCALE)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Checked HERE, against each other, because the failure they produce is invisible until a sale.
  // If the platform fee and the maximum royalty can together reach 100%, a listing at the royalty
  // ceiling settles for a seller's proceeds of exactly zero — and one basis point past it, for a
  // negative number the ledger refuses AFTER the buyer's funds have been claimed for the entry.
  // A configuration that can produce that is refused at boot, where the two variables are named,
  // rather than at 03:00 on the day a creator sets the maximum.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  if (platformFeeBps + maxRoyaltyBps >= BPS_SCALE) {
    throw new EnvError(
      `MARKET_PLATFORM_FEE_BPS (${platformFeeBps}) + MARKET_MAX_ROYALTY_BPS (${maxRoyaltyBps}) ` +
        `must leave the seller something: they must sum to less than ${BPS_SCALE}`,
    )
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'MARKET_DATABASE_URL'),
    databasePoolMax: integer(source, 'MARKET_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    policyUrl: required(source, 'POLICY_URL'),
    serviceToken: requiredSecret(source, 'MARKET_SERVICE_TOKEN'),
    upstreamDeadlineMs: integer(source, 'MARKET_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    platformFeeBps,
    maxRoyaltyBps,
    // Default 24 hours. Long enough that a buyer who has been defrauded has noticed, short enough
    // that an honest seller is not financing the platform.
    disputeWindowMs: integer(source, 'MARKET_DISPUTE_WINDOW_MS', 86_400_000, 0, 30 * 86_400_000),
    // Default two minutes. Without it an auction is won by whoever has the lowest latency rather
    // than by whoever values the item most, which is a market design failure and not a bug.
    auctionExtensionMs: integer(source, 'MARKET_AUCTION_EXTENSION_MS', 120_000, 0, 3_600_000),
    listingEnabled: boolean(source, 'MARKET_LISTING_ENABLED', true),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
