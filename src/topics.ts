/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the
 * estate can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares
 * its classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule
 * for every registry topic. **The producer was pinned to nothing at all** — not to the topic names
 * and, worse, not to the shape of the envelope it wrote them into.
 *
 * Two instances of that one class have already cost the estate every event it ever relayed:
 *
 *   - **A version stamped wrong.** `EventEnvelope.version` is `` `${number}.${number}` `` in the
 *     contract — a "major.minor" STRING. Six producers typed it `number` end to end and sent `1`,
 *     and `validateEnvelope` refuses that with "version: missing". The signature verified, the
 *     delivery arrived, and the consumer threw it away at the envelope before anything looked at
 *     a payload. Each service's own suite stayed green throughout, because each tested against
 *     its own fake of the other side.
 *   - **A topic renamed on the wire.** `wallet` emitted `wallet.deposit.credited` while the
 *     registry, `notify` and `activity` all spell it `wallet.deposit.confirmed`. Nothing could
 *     ever match it.
 *
 * These are the same defect wearing two hats: **the producer is free and the consumer is pinned.**
 * So this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EventEnvelope.version` in `outbox.ts` is the contract's
 *      `EventVersion`, imported rather than restated. Assigning the stored integer to it is a type
 *      error, which is `pnpm typecheck`, which is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry, and it builds
 *      a real envelope through the relay's own `buildEnvelope` and hands it to the contract's own
 *      `validateEnvelope`. A test that compared this list with the registry would agree with
 *      itself forever while the emit sites drifted underneath it — which is exactly what happened.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  validateEnvelope,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { BID_PLACED_TOPIC, OFFER_MADE_TOPIC } from './bids.ts'
import { LISTED_TOPIC, REMOVED_TOPIC, SOLD_TOPIC } from './listings.ts'
import {
  CASE_OPENED_TOPIC,
  CASE_RESOLVED_TOPIC,
  DISPUTE_OPENED_TOPIC,
  DISPUTE_RESOLVED_TOPIC,
} from './moderation.ts'
import { PAID_OUT_TOPIC } from './orders.ts'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'market'

/**
 * Every topic this service emits.
 *
 * The constants are imported from the modules that emit them rather than redeclared, so this list
 * cannot name a topic whose spelling has since changed under it. `topics.test.ts` additionally
 * reads the literals back out of `src/`, so it cannot name one that no emit site produces either.
 */
export const EMITTED_TOPICS = Object.freeze([
  BID_PLACED_TOPIC,
  OFFER_MADE_TOPIC,
  LISTED_TOPIC,
  SOLD_TOPIC,
  REMOVED_TOPIC,
  CASE_OPENED_TOPIC,
  CASE_RESOLVED_TOPIC,
  DISPUTE_OPENED_TOPIC,
  DISPUTE_RESOLVED_TOPIC,
  PAID_OUT_TOPIC,
] as const)

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with the three properties that keep identity's honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * `keyedBy` on each is read off the emit site, never chosen here: the key is the ordering
 * partition, so it is contract rather than a producer's private preference.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  'market.bid.placed': {
    reason:
      'An auction leader was displaced and refunded. Their notification is the only thing that tells them, and today nothing can subscribe.',
    spec: {
      producer: 'market',
      payloadType: 'BidPlaced',
      version: '1.0',
      keyedBy: 'listing_id',
      description: 'A bid was placed on an auction, displacing and refunding the previous leader.',
    },
  },
  'market.offer.made': {
    reason: 'A seller with an offer nobody told them about is a sale that does not happen.',
    spec: {
      producer: 'market',
      payloadType: 'OfferMade',
      version: '1.0',
      keyedBy: 'listing_id',
      description: 'A buyer made an offer on a listing.',
    },
  },
  'market.listing.listed': {
    reason:
      'The other half of market.listing.sold, which IS registered. A registry that names the sale and not the listing gives activity a feed that starts in the middle.',
    spec: {
      producer: 'market',
      payloadType: 'ListingListed',
      version: '1.0',
      keyedBy: 'listing_id',
      description: 'A draft listing was funded into escrow and went active.',
    },
  },
  'market.listing.removed': {
    reason:
      'A cancellation releases escrow. Without the event, a consumer that saw `listed` believes the listing is still live for ever.',
    spec: {
      producer: 'market',
      payloadType: 'ListingRemoved',
      version: '1.0',
      keyedBy: 'listing_id',
      description: 'An active listing ended without a sale and its escrow was released.',
    },
  },
  'market.moderation.opened': {
    reason:
      'Keyed by SUBJECT URN rather than a listing id, and that is the point — moderation is opened against anything the estate can name.',
    spec: {
      producer: 'market',
      payloadType: 'ModerationCaseOpened',
      version: '1.0',
      keyedBy: 'subject_urn',
      description: 'An operator opened a moderation case against a subject named by URN.',
    },
  },
  'market.moderation.resolved': {
    reason: 'The close of the case above. Same keying, or the pair cannot be ordered together.',
    spec: {
      producer: 'market',
      payloadType: 'ModerationCaseResolved',
      version: '1.0',
      keyedBy: 'subject_urn',
      description: 'A moderation case was resolved by an operator.',
    },
  },
  'market.dispute.opened': {
    reason:
      'A dispute freezes a payout. `settlement` and `billing` both have a reason to hear it, and neither can today.',
    spec: {
      producer: 'market',
      payloadType: 'DisputeOpened',
      version: '1.0',
      keyedBy: 'listing_id',
      description: 'A buyer raised a dispute against a settled order, freezing its proceeds.',
    },
  },
  'market.dispute.resolved': {
    reason:
      'THIS is where a refund lives. `resolution` is "refunded" or "upheld" and `reversalEntryId` names the ledger reversal, so a consumer can reconcile the money rather than infer it.',
    spec: {
      producer: 'market',
      payloadType: 'DisputeResolved',
      version: '1.0',
      keyedBy: 'listing_id',
      description:
        'A dispute was resolved. Carries the resolution and, for a refund, the reversal entry id.',
    },
  },
  'market.order.paid_out': {
    reason:
      'A seller was paid. The only event that says the proceeds left escrow for the seller rather than back to the buyer.',
    spec: {
      producer: 'market',
      payloadType: 'OrderPaidOut',
      version: '1.0',
      keyedBy: 'listing_id',
      description: "An order's held proceeds were released to the seller, with the payout entry.",
    },
  },
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * The direction that is easiest to miss, because nothing breaks and nothing logs: consumers
 * classify the topic, the code path renders it, and nothing ever arrives.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * `validateEnvelope` is the contract's own function and is the exact check that `activity` and
 * `notify` run on a delivered body. Running it here, on an envelope this service's relay actually
 * built, is the only way a producer finds out it is unreadable without waiting for two services to
 * be composed — which is how this was found the first time, months late.
 *
 * **One error is tolerated and only one:** "not in this registry", and only for a topic the
 * quarantine above explains. That is a consumer being behind its producers, which is a normal
 * consequence of deploying twenty-two services independently and which `activity` handles by
 * quarantining rather than dropping. Every other error — a version in the wrong shape, a missing
 * correlation id, an id that is not a UUID, a producer that does not own its topic — is this
 * service emitting something nobody can read, and is returned.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = validateEnvelope(envelope)
  if (verdict.ok) return []
  const topic =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>)['topic']
      : undefined
  const excused =
    typeof topic === 'string' && Object.hasOwn(AWAITING_REGISTRATION, topic)
      ? `topic: "${topic}" is not in this registry; contracts-events may be behind`
      : null
  return verdict.errors.filter((error) => error !== excused)
}
