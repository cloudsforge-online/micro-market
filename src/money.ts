/**
 * The arithmetic of a sale. All of it in `bigint`, none of it anywhere near a float.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A SALE IS A PARTITION OF THE PRICE, NOT THREE INDEPENDENT PERCENTAGES.**
 *
 * The obvious implementation computes the platform fee, computes the royalty, computes the
 * seller's proceeds, and posts all three. Each of those is a `floor` — and three independent
 * floors do not add up. On a 1,000-Shard sale at 250 bps fee and 750 bps royalty you get 25 + 75
 * + 900 = 1,000 by luck; on a 1,001-Shard sale you get 25 + 75 + 900 = 1,000 and one Shard is
 * simply gone. The ledger refuses that entry — Σ debits ≠ Σ credits — and the sale fails at the
 * last possible moment, after the buyer's funds have been claimed.
 *
 * So the seller's proceeds are **defined as the remainder**: `price − fee − royalty`. The fee and
 * the royalty round down, the seller absorbs the dust, and `fee + royalty + proceeds === price`
 * is true by construction for every price and every pair of rates. `assertPartition` states it as
 * an assertion rather than as a comment, and `money.test.ts` proves it over the whole range.
 *
 * The same problem appears one level down, splitting the royalty between N recipients. Flooring
 * each recipient's share loses up to N−1 units. `allocate` uses largest-remainder so the shares
 * sum to the royalty EXACTLY, with a deterministic tie-break so two replicas computing the same
 * split produce byte-identical postings — a non-deterministic tie-break would make an honest
 * retry look like a different request to the ledger's idempotency fingerprint.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nothing here reads the database or the clock. It is pure, which is why the property tests in
 * `money.test.ts` can run thousands of cases in milliseconds without a Postgres.
 */

/** Basis points. 10,000 = 100%. */
export const BPS_SCALE = 10_000n

export class MoneyError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * `amount × bps / 10000`, rounded **down**.
 *
 * Down, always, and in the platform's disfavour on purpose: rounding a fee up takes a unit from a
 * customer that no rate entitles the platform to, and doing that on every sale is a systematic
 * overcharge that reconciliation cannot distinguish from a pricing decision.
 */
export function bpsOf(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new MoneyError(`an amount may not be negative, got ${amount}`)
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_SCALE)) {
    throw new MoneyError(`basis points must be a whole number in 0..10000, got ${bps}`)
  }
  return (amount * BigInt(bps)) / BPS_SCALE
}

/**
 * Split `total` between weighted recipients so the shares sum to `total` **exactly**.
 *
 * Largest remainder (Hamilton): floor each share, then hand the leftover units one at a time to
 * whoever was cut by the most. The tie-break is the recipient's index — deterministic, because a
 * split that depends on `Math.random` or on map iteration order produces different postings on a
 * retry, and the ledger would then see a legitimate retry as a new request under a used key.
 *
 * Returns an empty array for a zero total or no recipients; the caller decides whether that is a
 * business error. Zero-weight recipients get zero and are never handed a remainder unit — a
 * recipient entitled to nothing must not be paid a dust unit because the arithmetic needed
 * somewhere to put it.
 */
export function allocate(total: bigint, weights: readonly number[]): bigint[] {
  if (total < 0n) throw new MoneyError(`a total may not be negative, got ${total}`)
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new MoneyError(`a weight must be a non-negative whole number, got ${weight}`)
    }
  }
  const shares = weights.map(() => 0n)
  const sum = weights.reduce((acc, weight) => acc + BigInt(weight), 0n)
  if (sum === 0n || total === 0n) return shares

  // `remainder_i = total × w_i mod sum`. Kept as an integer rather than a fraction so the
  // comparison below is exact — comparing floating remainders is how a split becomes unstable
  // between two hosts with different rounding on the same inputs.
  const remainders: Array<{ index: number; remainder: bigint }> = []
  let distributed = 0n
  for (const [index, weight] of weights.entries()) {
    const numerator = total * BigInt(weight)
    const share = numerator / sum
    shares[index] = share
    distributed += share
    remainders.push({ index, remainder: numerator % sum })
  }

  let leftover = total - distributed
  // Descending by remainder, ascending by index on a tie. `Array.prototype.sort` is stable in
  // every Node ≥11, but the index comparison is written out rather than relied upon: a sort whose
  // correctness depends on an engine's stability guarantee is a sort somebody will replace.
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )
  for (const entry of remainders) {
    if (leftover <= 0n) break
    // A recipient with a zero weight has a zero remainder and is entitled to nothing.
    if (weights[entry.index] === 0) continue
    shares[entry.index] = (shares[entry.index] ?? 0n) + 1n
    leftover -= 1n
  }
  // Only reachable if every non-zero-weight recipient has already been topped up and units are
  // still outstanding, which the arithmetic above makes impossible. Asserted anyway: a silent
  // shortfall here is a ledger entry that does not balance.
  if (leftover !== 0n) {
    throw new MoneyError(`allocation left ${leftover} unassigned; this is a bug in allocate()`)
  }
  return shares
}

export interface RoyaltyRecipient {
  /** A ledger account subject — `user:<id>`, `community:<id>`, `organisation:<id>`. */
  readonly subject: string
  /** This recipient's share OF THE ROYALTY, in basis points of the royalty, not of the price. */
  readonly bps: number
}

export interface RoyaltyShare {
  readonly subject: string
  readonly amount: bigint
}

export interface SaleTerms {
  readonly price: bigint
  readonly platformFeeBps: number
  readonly royaltyBps: number
  readonly royaltyRecipients: readonly RoyaltyRecipient[]
}

export interface SaleSplit {
  readonly price: bigint
  readonly platformFee: bigint
  readonly royaltyTotal: bigint
  /** The remainder. Never negative, and the reason the three always sum to the price. */
  readonly sellerProceeds: bigint
  readonly royaltyShares: readonly RoyaltyShare[]
}

/**
 * Divide a sale price into the platform's fee, the royalty, and what the seller is left with.
 *
 * The one place in this service where a price becomes several amounts. Every posting builder in
 * `ledgerclient.ts` takes this object rather than the rates, so there is exactly one implementation
 * of the arithmetic and exactly one thing to test.
 */
export function splitSale(terms: SaleTerms): SaleSplit {
  if (terms.price <= 0n) throw new MoneyError(`a sale price must be positive, got ${terms.price}`)
  if (terms.platformFeeBps + terms.royaltyBps >= Number(BPS_SCALE)) {
    throw new MoneyError(
      `a platform fee of ${terms.platformFeeBps} bps and a royalty of ${terms.royaltyBps} bps ` +
        `would leave the seller nothing`,
    )
  }
  const platformFee = bpsOf(terms.price, terms.platformFeeBps)
  const royaltyTotal = bpsOf(terms.price, terms.royaltyBps)
  const sellerProceeds = terms.price - platformFee - royaltyTotal

  const recipients = terms.royaltyRecipients
  if (royaltyTotal > 0n && recipients.length === 0) {
    // A royalty with nobody to pay is not a rounding question, it is a listing that would take
    // money out of a sale and have nowhere to put it. The entry would not balance.
    throw new MoneyError('a non-zero royalty needs at least one recipient')
  }
  const shares = allocate(
    royaltyTotal,
    recipients.map((recipient) => recipient.bps),
  )
  const royaltyShares: RoyaltyShare[] = recipients.map((recipient, index) => ({
    subject: recipient.subject,
    amount: shares[index] ?? 0n,
  }))

  const split: SaleSplit = {
    price: terms.price,
    platformFee,
    royaltyTotal,
    sellerProceeds,
    royaltyShares,
  }
  assertPartition(split)
  return split
}

/**
 * The invariant, stated as an assertion.
 *
 * Called on every split rather than only in the tests, because the cost of checking is three
 * additions and the cost of not checking is an unbalanced journal entry discovered by the trial
 * balance — which is a P0 alert in 17 §8 and freezes everything downstream of the ledger.
 */
export function assertPartition(split: SaleSplit): void {
  const total = split.platformFee + split.royaltyTotal + split.sellerProceeds
  if (total !== split.price) {
    throw new MoneyError(
      `the split does not sum to the price: ${split.platformFee} + ${split.royaltyTotal} + ` +
        `${split.sellerProceeds} = ${total}, expected ${split.price}`,
    )
  }
  if (split.sellerProceeds < 0n) {
    throw new MoneyError(`the seller's proceeds are negative: ${split.sellerProceeds}`)
  }
  const paid = split.royaltyShares.reduce((acc, share) => acc + share.amount, 0n)
  if (paid !== split.royaltyTotal) {
    throw new MoneyError(
      `the royalty shares sum to ${paid} but the royalty is ${split.royaltyTotal}`,
    )
  }
}

/**
 * A decimal string of smallest units, parsed strictly.
 *
 * Strings on the wire and in the database, `bigint` in memory, never a `number` in between. A JSON
 * number is an IEEE 754 double: 2^53 is the point at which an amount stops being exact, and a
 * Shard is one US cent, so that ceiling is ninety trillion dollars — far away, but the failure
 * when it arrives is silent and the value comes back subtly wrong rather than failing.
 */
export function parseAmount(value: unknown, field = 'amount'): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) {
    throw new MoneyError(`${field} must be a decimal string of up to 78 digits`)
  }
  return BigInt(value)
}

/** The minimum a bid must reach to displace `current`. Strictly greater; ties never displace. */
export function minimumBid(current: bigint | null, startingPrice: bigint): bigint {
  return current === null ? startingPrice : current + 1n
}
