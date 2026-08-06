/**
 * The three peers this service calls, and the credential it presents to all of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE MODERATION GATE THAT WAS NOT ABSENT BY DESIGN
 *
 * `MARKET_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The composition root read it once, at import:
 *
 *     const token = () => env.serviceToken        // index.ts, for the life of the process
 *
 * and handed that one function to the ledger, the indexer and policy. There
 * was no `ServiceTokenProvider`, no `POST /service-tokens/exchange` and no `cfsc_` anywhere in
 * `src/` — checked by grep, not inferred. So every outbound call this service makes authenticated
 * **once per bootstrap** and never again, while the container ran for days.
 *
 * **Measured on the live estate rather than reasoned about.** The token inside
 * `cloudsforge-estate-market-1` had been expired for 63,056 seconds — seventeen and a half hours.
 * Presenting it to policy from inside that container returned
 * `401 {"error":{"code":"unauthenticated","message":"a valid bearer token is required"}}`, and a
 * real seller listing then came back 201 with
 * `policy: {decision:"review", reasons:["policy_unavailable"], degraded:true}`.
 *
 * ## WHY THIS IS THE SECOND HALF OF A FIX AND NOT THE WHOLE OF ONE
 *
 * `policyclient.ts` (commit 51b3dd0) already reads a 401 as **policy refusing US**, not as
 * policy judging the listing, so no seller is told they are banned because of our misconfiguration.
 * That was the urgent half and it is done. What it cannot do is make the call succeed. With it, the
 * marketplace is open and **unmoderated on every single listing** — and the header of
 * `policyclient.ts` already states the rule this breaks: failing open *silently* is worse than
 * failing open or failing closed, because during it the gate is not degraded, it is absent, and an
 * attacker who can keep policy unreachable gets an unmoderated marketplace with no trace. A dead
 * credential is exactly "policy permanently unreachable", self-inflicted.
 *
 * The `degraded` flag does leave evidence — `market_policy_degraded_total` and an automatic
 * moderation case per listing — but evidence that fires on *every* listing is a queue no human
 * drains, which is the same as none.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a **wiring** defect, and wiring that lives in the composition root is
 * wiring no test can reach: `index.ts` opens a pool, asserts a schema, starts a job runner and
 * calls `listen()`, so importing it from a test starts a server. `ledger/src/upstreams.ts` and
 * `foresight/src/upstreams.ts` learned this the same way. This service had a full green suite over
 * a composition root that authenticated once and died — because every test builds its own client,
 * and a suite full of tests that build their own clients cannot see a composition root that builds
 * a different one.
 *
 * `servicetoken.test.ts` beside this file goes through `buildUpstreams`, and reverting the body
 * below to `() => env.serviceToken` turns it red.
 *
 * ## BOTH HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token` keeps the credential fresh on a schedule computed from this process's clock. `fetch`
 * catches a 401 from a peer, re-mints and replays once. Without the second, correctness would rest
 * on this process and policy agreeing about what time it is.
 *
 * ## THE READINESS PROBE: SOFT, DELIBERATELY, AND LOUD INSTEAD
 *
 * `serviceTokenProbe` exists in `@cloudsforge/auth` and is deliberately not wired here, for the
 * reason `ledger/src/upstreams.ts` gives and which is stronger in this repository than in that one:
 *
 *   1. **Every public read is served from this service's own tables.** Browsing listings, a listing
 *      page, an auction's bid history — none of them makes an outbound call. A hard probe on the
 *      credential would take the whole marketplace out of the balancer over a variable those routes
 *      cannot touch.
 *   2. **The write paths that do need it already fail safely at the point of use.** Policy fails
 *      open and flags (`policyclient.ts`); the ledger's own `/livez` is already a HARD probe
 *      (`index.ts`), so a ledger this service genuinely cannot use still pulls the replica.
 *   3. **Pulling the replica would fix nothing.** Every replica reads the same environment. A probe
 *      would only decide which container refuses, not whether one does.
 *
 * So: soft, and loud instead. `index.ts` logs `fatal` at boot naming what will break, and
 * `market_service_token_usable` answers "can this process authenticate right now" on every scrape —
 * the question that had no answer anywhere while the token quietly died for seventeen hours.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { ServiceTokenProvider, ServiceTokenUnavailableError, type ProviderEvent } from '@cloudsforge/auth'
import { httpIndexerClient, type IndexerClient } from './indexerclient.ts'
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { httpPolicyClient, type PolicyClient } from './policyclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That is
// the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'serviceToken'
  | 'ledgerUrl'
  | 'indexerUrl'
  | 'policyUrl'
  | 'upstreamDeadlineMs'
>

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
  /** The service name stamped on ledger postings. `SERVICE`, passed in to keep `env.ts` out. */
  readonly originatingService: string
}

/**
 * How this process obtains a bearer, named rather than inferred from whether a string is set.
 *
 * `exchanged` is correct. `static` is the defect, still running wherever a deployment has not yet
 * been given the credential its bootstrap already mints. `none` cannot authenticate at all. Three
 * states, because "the token is not working" and "there is no token" send an operator to different
 * places — which is the whole lesson of the seventeen silent hours this fixes.
 */
export type CredentialMode = 'exchanged' | 'static' | 'none'

export interface Upstreams {
  readonly mode: CredentialMode
  /** `null` unless `mode` is `exchanged`. The thing `index.ts` samples for the readiness gauge. */
  readonly identityTokens: ServiceTokenProvider | null
  readonly ledger: LedgerClient
  readonly indexer: IndexerClient
  readonly policy: PolicyClient
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // Not narrowed. Identity issues the service's whole allowlist, and at boot this process
        // cannot know which of its call sites will be reached first — a listing that reserves
        // against the ledger, a risk indicator off the indexer, or the policy decision on the
        // listing itself. A narrowing that drifted from the deploy's derived grant map would 403
        // with nothing in either log naming the cause.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  const mode: CredentialMode = identityTokens ? 'exchanged' : env.serviceToken ? 'static' : 'none'

  /**
   * What every client asks for the `Authorization` header.
   *
   * **Rejects rather than resolving `undefined` when there is nothing to present.** `HttpClient`
   * omits the header entirely for `undefined`, so the request would go out unauthenticated, come
   * back 401, and — through `policyclient.ts`'s deliberate 401 branch — be recorded as a degraded
   * policy call, indistinguishable from policy being down. It is not down; nobody gave this service
   * a credential. Those are different mornings, and keeping them different is the point.
   * `ServiceTokenUnavailableError` maps to 503, never 401, for the same reason `Verifier` answers
   * 503 on an unreachable JWKS: a fault in the thing that decides authentication is not evidence
   * that the caller is unauthenticated.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token()
    if (env.serviceToken) return Promise.resolve(env.serviceToken)
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set MARKET_IDENTITY_CREDENTIAL (long-lived, from POST /service-credentials)',
      ),
    )
  }

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // three clients get, and it is the layer where a 401 is visible and where the header was set.
  const fetch = identityTokens?.authorizedFetch ?? options.fetch
  const common = { token, deadlineMs: env.upstreamDeadlineMs, ...(fetch ? { fetch } : {}) }

  return {
    mode,
    identityTokens,
    ledger: httpLedgerClient({
      baseUrl: env.ledgerUrl,
      originatingService: options.originatingService,
      ...common,
    }),
    indexer: httpIndexerClient({ baseUrl: env.indexerUrl, ...common }),
    policy: httpPolicyClient({ baseUrl: env.policyUrl, ...common }),
  }
}
