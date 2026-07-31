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

export const POLICY_SCOPES: readonly string[] = Object.freeze(['policy:evaluate'])

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
        const body = await client.request<{ decision: PolicyDecision; reasons?: string[] }>(
          '/v1/decisions/market.listing',
          { method: 'POST', body: input },
        )
        return { decision: body.decision, reasons: body.reasons ?? [], degraded: false }
      } catch (err) {
        // A 4xx is policy DECIDING, not policy failing, and a decision is never overridden by a
        // fail-open default — that would turn "deny" into "allow" for any caller that could
        // provoke a 400.
        if (err instanceof HttpError && err.peerDecided && err.status !== 429) {
          return { decision: 'deny', reasons: ['policy_rejected_the_request'], degraded: false }
        }
        return DEGRADED_VERDICT
      }
    },
  }
}
