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
// `CREDENTIAL_PREFIX` from `@cloudsforge/auth` used to be imported here, to tell a credential from
// a token by looking at it. It is gone because `assertServiceCredential` below asks the same
// question and four more: the prefix, the base64url alphabet, 32 decoded BYTES, an entropy floor,
// and a JWT refused BY NAME. One import rather than two, and the prefix is still the first thing it
// checks — see `@cloudsforge/secrets`' `SERVICE_CREDENTIAL` regex.
import {
  SecretError,
  assertGeneratedSecret,
  assertServiceCredential,
} from '@cloudsforge/secrets'

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

/**
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held ten exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that actually reached 44 containers on both networks: micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and was on nobody's list. A check
 * that cannot fail is worse than no check, because the absence of an alarm gets read as the
 * absence of a problem — and this service settles sales.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody
 * writes is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of a generated
 * value instead, which is the property a placeholder cannot have. It is imported rather than
 * copied so that this service cannot drift from the other sixteen.
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and
 * the command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * The estate's shared event-bus HMAC key — and on THIS service it is also the inbound verifier.
 *
 * Market consumes `billing.entitlement.revoked` and `identity.user.deleted` on the same route it
 * signs its own events with, so a weak value here is a free-delisting endpoint: anyone who can
 * reach the port asserts that a seller's entitlement was revoked and their listings come down.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. The old `minLength` parameter is gone rather
 * than kept in front: it is a strict subset of the shape check, and running it first answers a
 * 40-character placeholder with "must be at least 24 characters" — true, useless, and about the
 * wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * `null` rather than `undefined`, and rather than `''`: an empty string is falsy in exactly the
 * places a caller tests for it and truthy in `Object.keys`, so a mode chosen by `env.x ? … : …`
 * would agree with an operator who set the variable to nothing. `null` is the absence, said once.
 *
 * The empty check stays AHEAD of the assertion, because compose interpolates
 * `${MARKET_IDENTITY_CREDENTIAL:-}` and an unset credential arrives as the EMPTY STRING. That is
 * the supported mode, not a malformed one, and `migrator.ts` shares this environment while dialling
 * nobody. Turning it into `exit(1)` would fail `market-migrate`, which eleven other services wait
 * on through `service_completed_successfully`.
 *
 * What is not supported is a value that is present and rubbish: a 20-character placeholder is a
 * deployment that believes it HAS a credential, and it fails on its first call to policy with a 401
 * that `policyclient.ts` correctly records as a DEGRADED verdict — which is the silent unmoderated
 * marketplace this whole file's history is about.
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and market would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live: the testnet
 * credential also CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct
 * that is correct for the signing key above would have booted mainnet and killed testnet.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  asEnvError(() => assertServiceCredential(name, value))
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
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
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
  /**
   * Which network an escrow transaction is looked for on when the activation does not say.
   *
   * The indexer scopes every read by `(chain, network)` and refuses to span them, because XRP
   * shares one address across testnet and mainnet and a signed Payment is submittable on either.
   * A hash without a network is therefore not a question the indexer can answer, and a wrong
   * default here reports "no such transaction" for a transaction that exists.
   */
  readonly indexerNetwork: string
  /** Soft, fail-open-and-flag. See `policyclient.ts` for why a gate that fails closed is worse. */
  readonly policyUrl: string

  /**
   * Where a **BROWSER** reaches micro-studio. Not where this service reaches it.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * This service makes no call to studio at all — a listing image is a reference this service
   * records and studio serves (`listingimages.ts` says why at length). So the only thing this
   * variable is used for is composing the `bytesUrl` a listing read hands to a client, and the
   * upload address that client is told to POST its bytes to.
   *
   * **It is therefore NOT `STUDIO_URL`, and the difference is the whole point.** The estate's
   * compose file already sets `STUDIO_URL: http://studio:4000` for the services that call studio
   * server-to-server. That address is a container name on a private network: putting it in an
   * `<img src>` produces a broken image on every device in the world. The value here is the public
   * one, and naming it differently is what stops the two being conflated by whoever writes the
   * next deployment.
   *
   * **Empty is a supported state and it means "this deployment has not been told".** In that case
   * a listing read reports `bytesUrl: null` and `uploadUrl: null` rather than guessing a hostname:
   * a guessed URL is a broken image and a failed upload with no diagnosis, while an explicit null
   * is a client that can say "images are not configured here" out loud. It is not `required()`
   * because a service that refuses to boot until an unrelated deployment file is edited takes the
   * marketplace down to add a feature to it.
   *
   * NOTE FOR WHOEVER SETS IT: micro-studio has no router in `deploy/gateway/dynamic/` and no
   * `studio` entry in the surface registry today, so there is no public hostname to put here yet.
   * Until there is, images stay unconfigured and every surface says so.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly studioPublicUrl: string

  /**
   * Where a service token is minted. `IDENTITY_ISSUER` unless overridden.
   *
   * Defaulted to the issuer rather than made a second required variable, because the issuer of a
   * token is by definition where the token came from — ledger's and foresight's reasoning, and it
   * means a deployment that already names the issuer needs no new URL to get the fix.
   */
  readonly identityUrl: string

  /**
   * The long-lived `cfsc_…` credential this service exchanges for a service token.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE TEN-MINUTE CLIFF, AND WHAT IT COSTS *THIS* SERVICE.**
   *
   * `MARKET_SERVICE_TOKEN` holds a token that lives **600 seconds** (`identity/src/tokens.ts`,
   * `SERVICE_TTL_SECONDS = 10 * 60`; identity will not lengthen it, because rotation IS expiry).
   * `index.ts` read it once, at import — `const token = () => env.serviceToken` — and handed that
   * one function to the ledger, the indexer and policy for the life of the process. So this
   * service authenticated to all three **exactly once per bootstrap**, and every call after minute
   * ten presented a corpse.
   *
   * It was measured, not inferred: the token inside `cloudsforge-estate-market-1` had been expired
   * for **63,056 seconds** — seventeen and a half hours — while the container served happily, and
   * policy answered `401 unauthenticated` to market's own bearer presented from inside that
   * container.
   *
   * **And the visible symptom was silence, which is the worst of the three possible ones.**
   * `policyclient.ts` correctly treats a 401 as policy refusing US rather than as policy judging
   * the listing, so a seller is no longer told they are banned by our own misconfiguration. What
   * remains is that every listing on the estate returns `policy: {decision:"review",
   * reasons:["policy_unavailable"], degraded:true}` — the moderation gate is not degraded, it is
   * **absent**, on every listing, for ever, and the header of `policyclient.ts` says in as many
   * words that a silently absent gate is worse than either failing open or failing closed.
   *
   * The fix is the estate's, unchanged: `@cloudsforge/auth`'s `ServiceTokenProvider` exchanges this
   * credential at `POST /service-tokens/exchange`, caches, re-mints at ~80% of `expiresIn` with
   * per-token jitter, shares one in-flight exchange, and on a 401 discards exactly the rejected
   * token and replays once. `src/upstreams.ts` carries the argument; this field is the input.
   *
   * **NOT REQUIRED, and the guard on it is `assertServiceCredential`.** `migrator.ts` shares this
   * environment and dials nothing, and a deployment that has not yet been given the credential must
   * still boot — loudly wrong beats not running. The absence is not silent: `index.ts` says so at boot at `fatal`, and
   * `market_service_token_usable` is 0 on every scrape.
   */
  readonly identityCredential: string | null

  /**
   * A pre-minted service token, kept ONLY as the bridge while a deployment still supplies one.
   *
   * **This is the defective credential, and it is optional now rather than required.** Requiring it
   * would keep a boot dependency on the thing being retired: a container that has the credential
   * and not the token is correctly configured, and refusing to start it would be this file
   * insisting on the defect. `upstreams.ts` prefers the credential whenever one is present and
   * ignores this entirely; when it is not, this is presented and the boot log says, at `fatal`,
   * exactly what will break and when. **Delete this field once no deployment sets it** — it is a
   * migration aid with a stated end, not a mode.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **IT IS GUARDED BY `assertServiceCredential`, WHICH REFUSES A JWT BY NAME — micro-org #222.**
   *
   * Measured live on 2026-08-05: the value in this variable on the running estate is a **697-byte
   * JWT that expired 26 hours before it was read**, on a container reporting healthy. The compose
   * default when nothing is exported is `estate-placeholder-token-0000000000000000`, which is
   * micro-org #142 wearing a different name. Both are refused, and both refusals are correct.
   *
   * **No JWT exemption is added and no weaker assertion is substituted**, because either would be
   * this file agreeing that a ten-minute bearer read once at boot is an acceptable standing
   * credential. It is not: that is the entire defect, and a guard with a hole shaped exactly like
   * the defect is a guard that has been deleted with extra steps.
   *
   * The consequence, stated so nobody discovers it during a deploy: **a deployment that still sets
   * `MARKET_SERVICE_TOKEN` to a token will not boot** — neither `market` nor `market-migrate`, and
   * the migrator takes eleven services with it through `service_completed_successfully`. The remedy
   * is the one the compose file has been describing for a release: stop passing the token, pass
   * `MARKET_IDENTITY_CREDENTIAL`, which `estate-bootstrap.sh` has minted all along.
   *
   * The remaining sharp edge is worth naming rather than hiding: a `cfsc_…` value pasted HERE now
   * passes this guard and is then presented verbatim as a Bearer by `upstreams.ts`, which 401s
   * every upstream. The assertion narrows the accepted set to values that cannot work in this slot,
   * which is the retirement #222 asks for done without deleting the field — and the field should be
   * deleted, with `CredentialMode`'s `static` arm, in the follow-up that wallet has already made.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly serviceToken: string | null
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
    databaseUrlTestnet: source['MARKET_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    databasePoolMax: integer(source, 'MARKET_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    // The same name and the same default as `micro-community` uses, so one deployment does not
    // have to remember two spellings of one fact.
    indexerNetwork: optional(source, 'INDEXER_NETWORK', 'mainnet'),
    policyUrl: required(source, 'POLICY_URL'),
    // Trailing slashes are stripped so `${base}/v1/assets/…` cannot become `//v1/assets/…`, which
    // some proxies treat as a protocol-relative URL and others as a path. One normalisation here
    // rather than a defensive join at each of the two call sites.
    studioPublicUrl: optional(source, 'STUDIO_PUBLIC_URL', '').replace(/\/+$/, ''),

    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    identityCredential: optionalCredential(source, 'MARKET_IDENTITY_CREDENTIAL'),
    // The SAME assertion as the credential above, deliberately. See the field docblock: this
    // variable holds a JWT on the live estate and a JWT is what `assertServiceCredential` refuses
    // by name. Pointing it at a weaker check would keep #222 open in the one file that can close it.
    serviceToken: optionalCredential(source, 'MARKET_SERVICE_TOKEN'),
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
