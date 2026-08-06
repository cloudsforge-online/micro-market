/**
 * The policy service, as this service uses it.
 *
 * Policy gates listing creation for new accounts and high-value items — 07-dependency-map lists
 * it as **soft (fail-open, flagged for review)**, and that phrasing is doing a lot of work.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **FAIL OPEN, AND LEAVE EVIDENCE. NOT ONE WITHOUT THE OTHER.**
 *
 * Failing CLOSED here would mean a policy outage stops every seller on the platform from listing
 * anything — the marketplace is shut by somebody else's incident, and the failure looks to a
 * seller exactly like being banned.
 *
 * Failing open SILENTLY is worse than either. It means that during an outage the gate is not
 * merely degraded, it is absent, and nothing anywhere records which listings went up unchecked.
 * An attacker who can make policy unreachable gets an unmoderated marketplace and no trace.
 *
 * So an unreachable policy service produces `review` with `degraded: true`, the listing is
 * created, and a moderation case is opened against it automatically. The listing goes up, and a
 * human is told. That is what "fail-open, flagged for review" has to mean to be worth writing
 * down.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call policy. Named here so the deploy can be
 * derived from it (`micro-deploy`'s `scripts/derive-grants.mjs`).
 *
 * ── IT SAID `policy:evaluate`, AND NO SUCH SCOPE HAS EVER EXISTED ────────────────────────────
 *
 * `@cloudsforge/contracts-auth` registers `policy:decide`, and policy gates the only route this
 * file calls on exactly that: `DECIDE_SCOPE = 'policy:decide'` (`policy/src/server.ts`). The
 * registry was checked on both sides before this line was edited — the report naming it was
 * treated as a claim, not evidence — and the registry is the correct side.
 *
 * The failure mode is not a 403. identity validates `IDENTITY_SERVICE_TOKEN_GRANTS` against the
 * registry at import and refuses to start on an unknown name, so a deploy that took this constant
 * at face value would kill the IDENTITY container: not market's policy calls degraded, the whole
 * estate's token minting gone.
 *
 * ── AND THE ANNOTATION IS THE REAL FIX ───────────────────────────────────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. A scope the registry does not have is a
 * COMPILE ERROR here, in this file, at the moment it is written. It has to be, because nothing
 * else looks: `service-ci.yml`'s scope audit reads a repository's INBOUND route gates, and this
 * is an outbound demand. That direction had never been checked by anything, which is how a
 * misspelling survived the life of the service. Same shape as the topic registry importing
 * `EventVersion` so a wire version could not be written as an integer.
 *
 * ── AND WHY `LiveScope` RATHER THAN `Scope` ──────────────────────────────────────────────────
 *
 * The first version of this annotation said `Scope`, and it stopped one step short. `Scope` is
 * `keyof typeof SCOPES` — EVERY registered key, deprecated ones included — so it caught
 * `policy:evaluate`, which is not a key, and would not have caught `wallet:provision`, which is.
 * A deprecated scope is one identity refuses to mint, so declaring one is the same dead identity
 * container by a different route.
 *
 * `LiveScope = Exclude<Scope, DeprecatedScope>` and `DeprecatedScope` is computed FROM `SCOPES`
 * by a conditional type over the `deprecated` field, not hand-listed, so it cannot drift from the
 * registry (`contracts/packages/auth/src/index.ts`). `Scope` keeps its wide meaning on
 * purpose: reading a token is wide — one may arrive carrying a scope that has since died — and
 * demanding is narrow. This is the demanding direction.
 */
export const POLICY_SCOPES: readonly LiveScope[] = Object.freeze(['policy:decide'])

export type PolicyDecision = 'allow' | 'review' | 'deny'

export interface PolicyVerdict {
  readonly decision: PolicyDecision
  readonly reasons: readonly string[]
  /** True when policy could not be reached and this verdict is the fail-open default. */
  readonly degraded: boolean
}

export interface ListingPolicyInput {
  readonly sellerSubject: string
  readonly assetKind: string
  readonly itemUrn: string
  /** As a decimal string. Policy is a different service; an amount crosses as text. */
  readonly amount: string
  readonly assetCode: string
  readonly settlementMode: string
}

export interface PolicyClient {
  evaluateListing(input: ListingPolicyInput): Promise<PolicyVerdict>
}

export interface PolicyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

/** The verdict an unreachable policy service produces. Exported so a test can assert on it. */
export const DEGRADED_VERDICT: PolicyVerdict = Object.freeze({
  decision: 'review' as const,
  reasons: Object.freeze(['policy_unavailable']),
  degraded: true,
})

export function httpPolicyClient(options: PolicyClientOptions): PolicyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'policy',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async evaluateListing(input) {
      try {
        // `POST /decisions`, not `/v1/decisions/market.listing`. Policy has NO `/v1` routes at
        // all (`policy/src/server.ts`) and takes the action in the body rather than the
        // path, so every call this client made returned 404 — and the fail-open branch below
        // swallowed it as `review` + `degraded`. The gate was therefore not degraded, it was
        // ABSENT, which is precisely the failure the header above says is worse than either
        // alternative. Found by micro-foresight while it built its own policy client against
        // policy's actual route table; same class as the recorded
        // `wallet/src/pricingclient.ts`, and the reason consumer-driven contract tests
        // exist.
        //
        // The action is `market.listing.create`, spelled as policy's closed registry spells it
        // (`policy/src/actions.ts`). An unregistered action is a deliberate 400 rather than a
        // guess, so `market.listing` would have kept failing even against the right path.
        const body = await client.request<{
          decision?: { decision?: string; reasons?: readonly string[] }
        }>('/decisions', {
          method: 'POST',
          body: {
            subject: input.sellerSubject,
            action: 'market.listing.create',
            // A URN rather than a bare id, so a decision row read months later says what it was
            // about without a lookup table. Policy stores this verbatim.
            resource: input.itemUrn,
            context: {
              // A DECIMAL STRING. Policy rejects a JSON number outright rather than coercing it,
              // because a threshold comparison on a float is the bug that service exists not to
              // have (`policy/src/server.ts`).
              amount: input.amount,
              asset: input.assetCode,
              assetKind: input.assetKind,
              settlementMode: input.settlementMode,
            },
          },
        })

        // Policy answers 201 with `{decision: {...}}`. A success whose body cannot be read is not
        // an allow: treating an unparseable 201 as permission would make a response-shape change
        // silently open the gate.
        const verdict = body.decision?.decision
        if (verdict !== 'allow' && verdict !== 'review' && verdict !== 'deny') {
          return DEGRADED_VERDICT
        }
        return { decision: verdict, reasons: [...(body.decision?.reasons ?? [])], degraded: false }
      } catch (err) {
        // A 4xx is policy DECIDING, not policy failing, and a decision is never overridden by a
        // fail-open default — that would turn "deny" into "allow" for any caller that could
        // provoke a 400.
        // A 404 or 405 is NOT policy deciding — it is policy not having that route, which is a
        // deployment or client error and says nothing about this listing. Treating it as a
        // decision is how the broken path above became a 403 on every single listing: `deny` is
        // honoured at `server.ts`, so a misspelled route closed the entire marketplace rather
        // than leaving it unmoderated. Between "shut the market because we misconfigured
        // ourselves" and "list it and flag it", this file's header already chose: fail open, and
        // leave evidence.
        // 401 and 403 belong here for the same reason, and this is how the marketplace was found
        // shut a SECOND time: `market` was started holding the compose placeholder token, policy
        // answered 401, `peerDecided` was true, and every listing by every seller was denied.
        //
        // A 401 says THIS CALLER IS NOT AUTHENTICATED. A 403 says this caller may not ask. Neither
        // is a sentence about the listing — they are sentences about us. Reading them as `deny`
        // makes our own misconfiguration indistinguishable from a moderator's judgement, which is
        // the same shape as a reconciliation failure that cannot be told apart from "no chain".
        //
        // 400 deliberately still denies: a malformed request is one a caller can provoke, so
        // failing open on it would hand an override to anyone who could send bad JSON.
        if (
          err instanceof HttpError
          && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 405)
        ) {
          return DEGRADED_VERDICT
        }
        if (err instanceof HttpError && err.peerDecided && err.status !== 429) {
          return { decision: 'deny', reasons: ['policy_rejected_the_request'], degraded: false }
        }
        return DEGRADED_VERDICT
      }
    },
  }
}
