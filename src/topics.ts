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
 *      `classifyEnvelope`. A test that compared this list with the registry would agree with
 *      itself forever while the emit sites drifted underneath it — which is exactly what happened.
 */

import {
  classifyEnvelope,
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { BID_PLACED_TOPIC, OFFER_MADE_TOPIC } from './bids.ts'
import { IMAGES_CHANGED_TOPIC } from './listingimages.ts'
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
  IMAGES_CHANGED_TOPIC,
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
      'An auction leader was displaced and refunded. Their notification is the only thing that tells them, and today nothing can subscribe. Until `outbidSubject` was added the payload could not have produced that notification even with a subscriber: it named the displaced bid by ROW ID, which no consumer can turn into a person.',
    spec: {
      producer: 'market',
      payloadType: 'BidPlaced',
      version: '1.0',
      keyedBy: 'listing_id',
      description:
        'A bid was placed on an auction, displacing and refunding the previous leader. Names the displaced bidder and the seller as well as the bidder.',
    },
  },
  /* ────────────────────────────────────────────────────────────────────────────────────────────
   * ADOPTED: `market.offer.made`, registered by `micro-contracts` 5e0d11a and therefore deleted
   * from here — `adoptedProposals()` failed this suite until it was, which is the entire point of
   * the table. The full round trip took about three hours and is the best evidence the quarantine
   * is a queue rather than an allow-list:
   *
   *   1. `micro-notify` refused the rule, because the envelope named only the offerer. Recorded as
   *      `blockedBy: 'no-subject'` with an owner, not as an omission.
   *   2. This service added `sellerSubject` (`bids.ts`), read off the `for update` listing row.
   *   3. `micro-notify` wrote the rule (`catalogue.ts`) and quarantined it, copying this
   *      entry's spec verbatim so the two repositories could not propose two contracts for one
   *      topic.
   *   4. `micro-contracts` pasted that spec, re-reading `keyedBy` off rather than trusting
   *      it, and both quarantines emptied.
   *
   * The registered spec is now the one `topics.test.ts` reconciles against, so nothing here needs
   * to remember it. Do not re-add an entry for it: `adoptedProposals()` will refuse.
   * ──────────────────────────────────────────────────────────────────────────────────────────── */
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
      'A cancellation releases escrow. Without the event, a consumer that saw `listed` believes the listing is still live for ever. It releases EVERY open bid and offer as well as the item, so `refundedSubjects` names the people whose money came back — they are not the actor, and the actor may be an operator delisting an upheld moderation case rather than the seller at all.',
    spec: {
      producer: 'market',
      payloadType: 'ListingRemoved',
      version: '1.0',
      keyedBy: 'listing_id',
      description:
        'An active listing ended without a sale. Its item escrow was released, and so was every open bid and offer — each of whose subjects is named.',
    },
  },
  'market.listing_image.changed': {
    reason:
      "A listing's photographs changed. Two consumers already need it and neither can hear it today: a search or browse projection caches the gallery and would serve a detached image for ever, and any CDN in front of micro-studio needs to know a listing stopped pointing at an asset. The payload carries the gallery AS IT NOW STANDS rather than a diff, so a consumer that missed an earlier delivery is corrected by the next one instead of drifting. It names studio asset ids and content addresses and NO URL — where a browser reaches studio is a deployment fact this service reads from its environment, and an event that carried one would freeze today's hostname into a row that outlives it.",
    spec: {
      producer: 'market',
      payloadType: 'ListingImagesChanged',
      version: '1.0',
      // `listingimages.ts` emits it keyed by the listing, like every other topic here: ordering is
      // per (topic, key), and an attach followed by a reorder must arrive in that order.
      keyedBy: 'listing_id',
      description:
        "A listing's image gallery was changed by its seller — an image attached, detached, or the order set. Carries the resulting gallery in position order as studio asset ids with their content addresses. The addresses are RECORDED, not verified and not anchored: no consumer may render them as proof of anything.",
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
      // "A buyer raised" was wrong and had been since the topic was written: `openDispute` admits
      // either party and refuses everyone else, which is the reason `counterpartySubject` has to
      // be computed rather than assumed to be the seller.
      description:
        'A buyer or a seller raised a dispute against a settled order, freezing its proceeds. Names the counterparty, whose payout this holds.',
    },
  },
  'market.dispute.resolved': {
    reason:
      'THIS is where a refund lives. `resolution` is "refunded" or "upheld" and `reversalEntryId` names the ledger reversal, so a consumer can reconcile the money rather than infer it. It is also the event that ENDS the freeze `market.dispute.opened` starts, and it named neither party until `raiserSubject` and `counterpartySubject` were added: the repair to `opened` had made "your payout is frozen" deliverable while leaving the estate unable to ever send the sentence that lifts it.',
    spec: {
      producer: 'market',
      payloadType: 'DisputeResolved',
      version: '1.0',
      keyedBy: 'listing_id',
      description:
        'A dispute was resolved, unfreezing the order. Carries the resolution, both parties by their role in the dispute, and for a refund the reversal entry id.',
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
 * The check itself is `classifyEnvelope`, and it is the contract's — the exact check `activity` and
 * `notify` run on a delivered body. Running it here, on an envelope this service's relay actually
 * built, is the only way a producer finds out it is unreadable without waiting for two services to
 * be composed, which is how this was found the first time, months late.
 *
 * ## Why this is now four lines and not sixteen
 *
 * It used to make the "malformed" / "not in this registry" distinction itself, by comparing against
 * the contract's exact error SENTENCE:
 *
 *     const excused = `topic: "${topic}" is not in this registry; contracts-events may be behind`
 *     return verdict.errors.filter((error) => error !== excused)
 *
 * `trade`, `community` and `devplatform` each carried that byte for byte. **A prose message is not
 * an interface.** Reword it in `contracts-events` by one character and all four copies silently
 * stop excusing anything: every quarantined topic starts reading as a producer bug and four suites
 * go red for a reason unrelated to what they test. Nothing here tied the literal to its source.
 * `classifyEnvelope` carries the distinction as STRUCTURE — `unregisteredTopic` is a field, not a
 * sentence — so there is no longer a string that can drift.
 *
 * ## What this file still decides, and the contract cannot
 *
 * **Which** unregistered topics are excused: the ones `AWAITING_REGISTRATION` above proposes. A
 * consumer lagging its producers is normal when twenty-two services deploy independently, and
 * `activity` quarantines rather than drops. Everything else the contract found is returned — a
 * version in the wrong shape, a missing correlation id, an id that is not a UUID, a producer that
 * does not own its topic — because each of those is this service emitting the unreadable.
 *
 * ## Why not the contract's own `envelopeDefects(value, awaitingRegistration)`
 *
 * It ships beside `classifyEnvelope` and looks like a drop-in for this function. It is not, and the
 * difference is the one this whole exercise is about. It flattens the verdict back to `string[]`,
 * and in flattening it **drops `unregisteredTopic` whenever any other defect is present** — so an
 * envelope on a topic nobody proposed that is ALSO malformed reports only the malformation, the
 * author fixes it, re-runs, and only then learns about the topic. That contradicts the wrapper's
 * own package documentation ("an envelope can be both, and `malformed` still reports
 * `unregisteredTopic`, so a producer fixing it needs one round rather than two") and it is exactly
 * the collapse of two facts into one that let eleven `notify` rules name topics no producer emits.
 * `classifyEnvelope` itself is right; only the convenience wrapper loses the fact. So this reads the
 * structured verdict and keeps both. Reported to `micro-contracts`; the test named "an unproposed
 * topic AND a broken version are reported together" is what stops a future tidy-up from adopting
 * the wrapper and losing a fact while every other assertion here stays green.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = classifyEnvelope(envelope)
  // Reported FIRST, where `validateEnvelope` has always put it, so a reader of a failure sees the
  // registry question before the envelope's own faults.
  const unexplained =
    verdict.unregisteredTopic !== null &&
    !Object.hasOwn(AWAITING_REGISTRATION, verdict.unregisteredTopic)
      ? [`topic: "${verdict.unregisteredTopic}" is not in the registry, and AWAITING_REGISTRATION does not propose it`]
      : []
  return [...unexplained, ...verdict.defects]
}
