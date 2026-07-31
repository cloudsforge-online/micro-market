/**
 * The arithmetic of a sale, proved.
 *
 * No database, no clock, no network — `money.ts` is pure, which is why the property tests below
 * can run tens of thousands of cases in milliseconds. That matters: the failure this module
 * exists to prevent is a single unit of dust lost on one price out of ten thousand, and a
 * hand-picked example set would never find it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BPS_SCALE,
  MoneyError,
  allocate,
  assertPartition,
  bpsOf,
  minimumBid,
  parseAmount,
  splitSale,
} from './money.ts'

/* ------------------------------------------------------------------ bpsOf */

test('bpsOf takes the stated share', () => {
  assert.equal(bpsOf(10_000n, 250), 250n)
  assert.equal(bpsOf(1_000n, 1_000), 100n)
  assert.equal(bpsOf(1n, 10_000), 1n)
})

test('bpsOf of zero basis points is zero', () => {
  assert.equal(bpsOf(999_999n, 0), 0n)
})

test('bpsOf rounds DOWN, in the platform’s disfavour', () => {
  // 1001 × 250 / 10000 = 25.025. Rounding up would take a unit no rate entitles us to, on every
  // sale, for ever — a systematic overcharge reconciliation cannot tell from a pricing decision.
  assert.equal(bpsOf(1_001n, 250), 25n)
  assert.equal(bpsOf(9_999n, 1), 0n)
})

test('bpsOf survives an amount far past 2^53', () => {
  // A JSON number stops being exact here. The whole reason amounts are bigint.
  const huge = 10n ** 30n
  assert.equal(bpsOf(huge, 250), 25n * 10n ** 27n)
})

test('bpsOf refuses a negative amount', () => {
  assert.throws(() => bpsOf(-1n, 250), MoneyError)
})

test('bpsOf refuses basis points outside 0..10000', () => {
  assert.throws(() => bpsOf(100n, -1), MoneyError)
  assert.throws(() => bpsOf(100n, 10_001), MoneyError)
  assert.throws(() => bpsOf(100n, 12.5), MoneyError)
})

test('BPS_SCALE is a bigint, so it can never be multiplied against a number by accident', () => {
  assert.equal(typeof BPS_SCALE, 'bigint')
  assert.equal(BPS_SCALE, 10_000n)
})

/* ------------------------------------------------------------------ allocate */

test('allocate splits evenly when it divides', () => {
  assert.deepEqual(allocate(100n, [5_000, 5_000]), [50n, 50n])
  assert.deepEqual(allocate(90n, [3_000, 3_000, 4_000]), [27n, 27n, 36n])
})

test('allocate sums to the total EXACTLY when it does not divide', () => {
  // 100 / 3 is the canonical dust case. Three independent floors would give 99.
  const shares = allocate(100n, [1, 1, 1])
  assert.equal(shares.reduce((a, b) => a + b, 0n), 100n)
  assert.deepEqual(shares, [34n, 33n, 33n])
})

test('allocate gives the leftover to the largest remainder first', () => {
  // total 10, weights 1:1:8 → 1, 1, 8 exactly. Now 11: 1.1, 1.1, 8.8 → floors 1,1,8 with 1 spare,
  // and the largest remainder is the 8.8.
  assert.deepEqual(allocate(11n, [1, 1, 8]), [1n, 1n, 9n])
})

test('allocate breaks a tie by index, deterministically', () => {
  // Both remainders are 0.5. A non-deterministic tie-break would make two replicas compute
  // different postings for one sale, and the ledger would see an honest retry as a new request.
  assert.deepEqual(allocate(3n, [5_000, 5_000]), [2n, 1n])
  // Called again: identical. Not "probably identical".
  for (let i = 0; i < 50; i += 1) assert.deepEqual(allocate(3n, [5_000, 5_000]), [2n, 1n])
})

test('allocate never pays a zero-weight recipient a dust unit', () => {
  const shares = allocate(7n, [10_000, 0])
  assert.deepEqual(shares, [7n, 0n])
})

test('allocate of zero is all zeroes', () => {
  assert.deepEqual(allocate(0n, [3_000, 7_000]), [0n, 0n])
})

test('allocate with no recipients is empty', () => {
  assert.deepEqual(allocate(100n, []), [])
})

test('allocate with all-zero weights pays nobody', () => {
  assert.deepEqual(allocate(100n, [0, 0]), [0n, 0n])
})

test('allocate refuses a negative total or a fractional weight', () => {
  assert.throws(() => allocate(-1n, [1]), MoneyError)
  assert.throws(() => allocate(10n, [1.5]), MoneyError)
  assert.throws(() => allocate(10n, [-1]), MoneyError)
})

test('allocate sums to the total for ten thousand pseudo-random cases', () => {
  // A deterministic LCG rather than Math.random: a property test that cannot be replayed from a
  // failure message is a property test that finds a bug once and never again.
  let seed = 20260731
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed
  }
  for (let i = 0; i < 10_000; i += 1) {
    const total = BigInt(next() % 1_000_000)
    const count = (next() % 5) + 1
    const weights = Array.from({ length: count }, () => next() % 1_000)
    const shares = allocate(total, weights)
    const sum = shares.reduce((a, b) => a + b, 0n)
    const anyWeight = weights.some((w) => w > 0)
    assert.equal(sum, anyWeight ? total : 0n, `total=${total} weights=${weights.join(',')}`)
    for (const share of shares) assert.ok(share >= 0n)
  }
})

/* ------------------------------------------------------------------ splitSale */

test('a sale with no fee and no royalty pays the seller everything', () => {
  const split = splitSale({ price: 1_000n, platformFeeBps: 0, royaltyBps: 0, royaltyRecipients: [] })
  assert.equal(split.sellerProceeds, 1_000n)
  assert.equal(split.platformFee, 0n)
  assert.equal(split.royaltyTotal, 0n)
})

test('the platform fee comes out of the seller’s proceeds, not the buyer’s price', () => {
  const split = splitSale({
    price: 1_000n,
    platformFeeBps: 250,
    royaltyBps: 0,
    royaltyRecipients: [],
  })
  // The buyer pays 1000. Full stop.
  assert.equal(split.price, 1_000n)
  assert.equal(split.platformFee, 25n)
  assert.equal(split.sellerProceeds, 975n)
})

test('fee + royalty + proceeds = price, exactly, on a price that divides badly', () => {
  // 1001 at 250 bps fee and 750 bps royalty. Three independent floors give 25 + 75 + 900 = 1000
  // and lose a Shard. The ledger would refuse that entry after the buyer's funds were claimed.
  const split = splitSale({
    price: 1_001n,
    platformFeeBps: 250,
    royaltyBps: 750,
    royaltyRecipients: [{ subject: 'user:creator', bps: 10_000 }],
  })
  assert.equal(split.platformFee, 25n)
  assert.equal(split.royaltyTotal, 75n)
  assert.equal(split.sellerProceeds, 901n)
  assert.equal(split.platformFee + split.royaltyTotal + split.sellerProceeds, 1_001n)
})

test('the royalty shares sum to the royalty exactly, with no rounding leak', () => {
  const split = splitSale({
    price: 1_003n,
    platformFeeBps: 250,
    royaltyBps: 1_000,
    royaltyRecipients: [
      { subject: 'user:a', bps: 3_333 },
      { subject: 'user:b', bps: 3_333 },
      { subject: 'user:c', bps: 3_334 },
    ],
  })
  const paid = split.royaltyShares.reduce((acc, share) => acc + share.amount, 0n)
  assert.equal(paid, split.royaltyTotal)
  assert.equal(split.platformFee + split.royaltyTotal + split.sellerProceeds, 1_003n)
})

test('a one-unit sale still partitions', () => {
  // Every rate rounds to zero. The seller gets the unit; nothing is created and nothing is lost.
  const split = splitSale({
    price: 1n,
    platformFeeBps: 250,
    royaltyBps: 750,
    royaltyRecipients: [{ subject: 'user:creator', bps: 10_000 }],
  })
  assert.equal(split.platformFee, 0n)
  assert.equal(split.royaltyTotal, 0n)
  assert.equal(split.sellerProceeds, 1n)
  assert.equal(split.royaltyShares[0]?.amount, 0n)
})

test('a sale far past 2^53 partitions exactly', () => {
  const price = 10n ** 30n + 7n
  const split = splitSale({
    price,
    platformFeeBps: 137,
    royaltyBps: 913,
    royaltyRecipients: [
      { subject: 'user:a', bps: 6_667 },
      { subject: 'user:b', bps: 3_333 },
    ],
  })
  assert.equal(split.platformFee + split.royaltyTotal + split.sellerProceeds, price)
  assert.equal(
    split.royaltyShares.reduce((acc, share) => acc + share.amount, 0n),
    split.royaltyTotal,
  )
})

test('the partition holds for every price from 1 to 5000, at four rate pairs', () => {
  const pairs: Array<[number, number]> = [
    [250, 0],
    [250, 1_000],
    [1, 9_998],
    [0, 0],
  ]
  for (const [feeBps, royaltyBps] of pairs) {
    for (let price = 1n; price <= 5_000n; price += 1n) {
      const split = splitSale({
        price,
        platformFeeBps: feeBps,
        royaltyBps,
        royaltyRecipients:
          royaltyBps > 0
            ? [
                { subject: 'user:a', bps: 4_567 },
                { subject: 'user:b', bps: 5_433 },
              ]
            : [],
      })
      assert.equal(
        split.platformFee + split.royaltyTotal + split.sellerProceeds,
        price,
        `price=${price} fee=${feeBps} royalty=${royaltyBps}`,
      )
      assert.equal(
        split.royaltyShares.reduce((acc, share) => acc + share.amount, 0n),
        split.royaltyTotal,
      )
      assert.ok(split.sellerProceeds >= 0n)
    }
  }
})

test('splitSale refuses a zero or negative price', () => {
  assert.throws(
    () => splitSale({ price: 0n, platformFeeBps: 0, royaltyBps: 0, royaltyRecipients: [] }),
    MoneyError,
  )
  assert.throws(
    () => splitSale({ price: -5n, platformFeeBps: 0, royaltyBps: 0, royaltyRecipients: [] }),
    MoneyError,
  )
})

test('splitSale refuses terms that would leave the seller nothing', () => {
  assert.throws(
    () =>
      splitSale({
        price: 1_000n,
        platformFeeBps: 5_000,
        royaltyBps: 5_000,
        royaltyRecipients: [{ subject: 'user:a', bps: 10_000 }],
      }),
    MoneyError,
  )
})

test('splitSale refuses a royalty with nobody to pay', () => {
  // Not a rounding question: money would come out of the sale with nowhere to go, and the entry
  // would not balance.
  assert.throws(
    () => splitSale({ price: 1_000n, platformFeeBps: 0, royaltyBps: 500, royaltyRecipients: [] }),
    MoneyError,
  )
})

test('assertPartition catches a hand-built split that does not add up', () => {
  assert.throws(
    () =>
      assertPartition({
        price: 100n,
        platformFee: 10n,
        royaltyTotal: 10n,
        sellerProceeds: 79n,
        royaltyShares: [{ subject: 'user:a', amount: 10n }],
      }),
    MoneyError,
  )
})

test('assertPartition catches royalty shares that do not sum to the royalty', () => {
  assert.throws(
    () =>
      assertPartition({
        price: 100n,
        platformFee: 0n,
        royaltyTotal: 10n,
        sellerProceeds: 90n,
        royaltyShares: [{ subject: 'user:a', amount: 9n }],
      }),
    MoneyError,
  )
})

/* ------------------------------------------------------------------ parseAmount */

test('parseAmount takes a decimal string and refuses everything else', () => {
  assert.equal(parseAmount('1000'), 1_000n)
  assert.equal(parseAmount('0'), 0n)
  // A NUMBER is refused rather than coerced. The habit of sending amounts as JSON numbers is how
  // an amount loses its low bits somewhere else in the estate.
  assert.throws(() => parseAmount(1_000), MoneyError)
  assert.throws(() => parseAmount('1000.5'), MoneyError)
  assert.throws(() => parseAmount('-1'), MoneyError)
  assert.throws(() => parseAmount(''), MoneyError)
  assert.throws(() => parseAmount(null), MoneyError)
  assert.throws(() => parseAmount('1e3'), MoneyError)
})

test('parseAmount accepts 78 digits and refuses 79', () => {
  const seventyEight = '9'.repeat(78)
  assert.equal(parseAmount(seventyEight), BigInt(seventyEight))
  assert.throws(() => parseAmount('9'.repeat(79)), MoneyError)
})

test('parseAmount names the field it refused', () => {
  assert.throws(() => parseAmount('x', 'reservePrice'), /reservePrice/)
})

/* ------------------------------------------------------------------ minimumBid */

test('the first bid must reach the starting price', () => {
  assert.equal(minimumBid(null, 500n), 500n)
})

test('a later bid must strictly EXCEED the leader — a tie never displaces', () => {
  // This is half of the concurrent-bid defence: two identical simultaneous bids cannot both win,
  // because the second is not greater than the first.
  assert.equal(minimumBid(500n, 100n), 501n)
})
