import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDICATOR_CODES, basisPointsAsPercent, computeIndicators } from './risk.ts'
import { sampleFacts } from './testsupport.ts'

const NOW = new Date('2026-07-31T00:00:00.000Z')

test('every indicator is returned, present or not — absence is information', () => {
  // A frontend that only received the TRUE ones could not tell "we checked and it is fine" from
  // "we did not check", and the two must never render the same.
  const indicators = computeIndicators(sampleFacts(), NOW)
  assert.equal(indicators.length, INDICATOR_CODES.length)
  assert.deepEqual(
    indicators.map((indicator) => indicator.code).sort(),
    [...INDICATOR_CODES].sort(),
  )
})

test('the result carries no score, no grade and no colour', () => {
  // 04-domain-model §6.3: risk indicators are computed, not editorial — facts, not a score. If
  // this test starts failing because somebody added `score`, that is the change to argue about.
  const indicators = computeIndicators(sampleFacts(), NOW)
  for (const indicator of indicators) {
    assert.deepEqual(Object.keys(indicator).sort(), ['code', 'detail', 'present'])
    assert.equal(typeof indicator.present, 'boolean')
  }
})

const find = (facts: Parameters<typeof computeIndicators>[0], code: string) =>
  computeIndicators(facts, NOW).find((indicator) => indicator.code === code)

test('a live mint authority is reported', () => {
  assert.equal(find(sampleFacts({ mintAuthorityPresent: true }), 'mint_authority_present')?.present, true)
  assert.equal(find(sampleFacts({ mintAuthorityPresent: false }), 'mint_authority_present')?.present, false)
})

test('unrenounced ownership is reported, and the sense is inverted correctly', () => {
  // The fact is "ownership renounced"; the INDICATOR is "ownership NOT renounced". Getting this
  // backwards would show every safe contract as risky and every risky one as safe.
  assert.equal(find(sampleFacts({ ownershipRenounced: false }), 'ownership_not_renounced')?.present, true)
  assert.equal(find(sampleFacts({ ownershipRenounced: true }), 'ownership_not_renounced')?.present, false)
})

test('supply concentration trips at half the supply, not before', () => {
  assert.equal(find(sampleFacts({ topHolderBps: 4_999 }), 'supply_concentrated')?.present, false)
  assert.equal(find(sampleFacts({ topHolderBps: 5_000 }), 'supply_concentrated')?.present, true)
})

test('the concentration detail shows the working', () => {
  assert.match(find(sampleFacts({ topHolderBps: 6_250 }), 'supply_concentrated')?.detail ?? '', /62\.50%/)
})

test('a contract deployed six days ago is recent; eight days ago is not', () => {
  const recent = sampleFacts({ firstSeenAt: '2026-07-25T00:00:00.000Z' })
  const older = sampleFacts({ firstSeenAt: '2026-07-23T00:00:00.000Z' })
  assert.equal(find(recent, 'recently_deployed')?.present, true)
  assert.equal(find(older, 'recently_deployed')?.present, false)
})

test('an unknown deployment date is not treated as recent, and says so', () => {
  const unknown = sampleFacts({ firstSeenAt: null })
  const indicator = find(unknown, 'recently_deployed')
  assert.equal(indicator?.present, false)
  assert.match(indicator?.detail ?? '', /no deployment date/)
})

test('an unparseable deployment date does not silently become 1970', () => {
  // `Date.parse` of rubbish is NaN. Coercing that to 0 would make every such contract read as
  // fifty-six years old, which is the most reassuring possible answer to an unknown.
  const bad = sampleFacts({ firstSeenAt: 'not-a-date' })
  assert.equal(find(bad, 'recently_deployed')?.present, false)
})

test('an exported deployer key is reported', () => {
  assert.equal(
    find(sampleFacts({ deployerWalletExported: true }), 'deployer_wallet_exported')?.present,
    true,
  )
})

test('a thin holder base is reported', () => {
  assert.equal(find(sampleFacts({ holderCount: 24 }), 'few_holders')?.present, true)
  assert.equal(find(sampleFacts({ holderCount: 25 }), 'few_holders')?.present, false)
})

test('basis points render as a percentage without floating-point noise', () => {
  // 2190 / 100 in floating point is 21.900000000000002.
  assert.equal(basisPointsAsPercent(2_190), '21.90%')
  assert.equal(basisPointsAsPercent(10_000), '100%')
  assert.equal(basisPointsAsPercent(0), '0%')
  assert.equal(basisPointsAsPercent(1), '0.01%')
  assert.equal(basisPointsAsPercent(250), '2.50%')
})

test('computeIndicators takes `now` as a parameter, so it is testable and self-consistent', () => {
  const facts = sampleFacts({ firstSeenAt: '2026-07-30T00:00:00.000Z' })
  assert.equal(
    computeIndicators(facts, new Date('2026-07-31T00:00:00.000Z')).find(
      (i) => i.code === 'recently_deployed',
    )?.present,
    true,
  )
  assert.equal(
    computeIndicators(facts, new Date('2026-09-01T00:00:00.000Z')).find(
      (i) => i.code === 'recently_deployed',
    )?.present,
    false,
  )
})
