/**
 * Risk indicators.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **COMPUTED, NOT EDITORIAL. FACTS, NOT A SCORE.** 04-domain-model §6.3.
 *
 * Every indicator below is a statement about the chain that a buyer could have checked
 * themselves, phrased so that it is either true or false and never a judgement. There is no
 * numeric score, no letter grade, no traffic light, and adding one would be a mistake in three
 * separate ways:
 *
 *   1. **A score is advice.** "Risk: 7/10" is the platform telling a customer what to think about
 *      somebody else's asset, which is a liability the platform has not been paid to take and
 *      cannot substantiate.
 *   2. **A score hides its inputs.** A buyer who sees "mint authority is still held" can decide
 *      what that is worth to them. A buyer who sees "72" cannot, and cannot tell whether it moved
 *      because the token changed or because we changed the weights.
 *   3. **A score is gameable in a way facts are not.** Weights become a specification for the
 *      minimum work required to look safe.
 *
 * So this module returns a list of `{ code, present, detail }` and the frontend renders each one
 * as a sentence. If somebody ever adds `score: number` to the return type, that is the change to
 * argue about, not the number it produces.
 *
 * **Nothing here is stored.** The indicators are derived from the indexer at read time, so they
 * are as fresh as the chain rather than as fresh as the last time somebody ran a job. A stored
 * indicator is a claim about the chain that was true once, and there is no way to tell from the
 * row whether it still is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { TokenFacts } from './indexerclient.ts'

/** The closed set. A code is a stable identifier a frontend can key its copy off. */
export const INDICATOR_CODES = Object.freeze([
  'mint_authority_present',
  'ownership_not_renounced',
  'supply_concentrated',
  'recently_deployed',
  'deployer_wallet_exported',
  'few_holders',
] as const)

export type IndicatorCode = (typeof INDICATOR_CODES)[number]

export interface Indicator {
  readonly code: IndicatorCode
  /** True when the condition HOLDS. A false indicator is still shown: absence is information. */
  readonly present: boolean
  /** The number the condition was evaluated against, so a buyer can see the working. */
  readonly detail: string
}

/** A holder above this share of supply can move the price on their own. */
const CONCENTRATION_BPS = 5_000
/** Below this many holders, "the market" is a handful of wallets. */
const FEW_HOLDERS = 25
/** A contract younger than this has no history to judge it by. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * Turn what the indexer knows into the six statements a buyer needs.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the age indicator is testable
 * without waiting a week, and so two calls in one request agree with each other.
 */
export function computeIndicators(facts: TokenFacts, now: Date): readonly Indicator[] {
  const firstSeen = facts.firstSeenAt ? Date.parse(facts.firstSeenAt) : Number.NaN
  const ageMs = Number.isNaN(firstSeen) ? Number.POSITIVE_INFINITY : now.getTime() - firstSeen

  return [
    {
      code: 'mint_authority_present',
      present: facts.mintAuthorityPresent,
      detail: facts.mintAuthorityPresent
        ? 'someone can still create more of this token'
        : 'the supply is fixed',
    },
    {
      code: 'ownership_not_renounced',
      present: !facts.ownershipRenounced,
      detail: facts.ownershipRenounced
        ? 'the contract owner has renounced control'
        : 'the contract still has an owner who can change it',
    },
    {
      code: 'supply_concentrated',
      present: facts.topHolderBps >= CONCENTRATION_BPS,
      detail: `the largest holder has ${basisPointsAsPercent(facts.topHolderBps)} of supply`,
    },
    {
      code: 'recently_deployed',
      present: ageMs < RECENT_MS,
      detail: facts.firstSeenAt
        ? `first seen on chain at ${facts.firstSeenAt}`
        : 'the indexer has no deployment date for this contract',
    },
    {
      code: 'deployer_wallet_exported',
      present: facts.deployerWalletExported,
      detail: facts.deployerWalletExported
        ? 'the deploying wallet’s key has been exported out of custody'
        : 'the deploying wallet’s key has not been exported',
    },
    {
      code: 'few_holders',
      present: facts.holderCount < FEW_HOLDERS,
      detail: `${facts.holderCount} holders`,
    },
  ]
}

/**
 * Basis points as a percentage string, computed in integer arithmetic.
 *
 * `bps / 100` in floating point gives `21.900000000000002` for 2190, which is not wrong so much
 * as unprofessional on a page whose entire job is to look like it knows what it is talking about.
 */
export function basisPointsAsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const fraction = Math.abs(bps % 100)
  return fraction === 0 ? `${whole}%` : `${whole}.${String(fraction).padStart(2, '0')}%`
}
