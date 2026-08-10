/**
 * Subsidies and bounties — docs/ecosystem/21 §5 and §7.4 — proven against the SCHEMA first.
 *
 * The two properties this file exists to pin:
 *
 *   §7.4  Every engagement grant resolves to a ledger entry; a grant with no posting cannot
 *         exist. Here that is `ledger_entry_id NOT NULL`, so the row is unwritable rather than
 *         merely discouraged — fire-tested with raw SQL below.
 *   §5    "Never ghost demand." The platform funds SUPPLY and is structurally forbidden from
 *         funding demand: no escrow, bid or offer may name an engagement account, whoever holds
 *         the connection.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  BUYER,
  SELLER,
  harness,
  migrateTestDb,
  openDb,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'
import {
  activeWindow,
  bountiesPaid,
  findGrant,
  grantIdempotencyKey,
  listGrants,
  openWindow,
  payGrant,
  paySettlementSubsidy,
} from './engagement.ts'

describe('the engagement programme', { skip }, () => {
  let sql: postgres.Sql
  let h: Harness

  before(async () => {
    sql = openDb(8)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
    h = harness(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  const HOUR = 3_600_000

  async function window(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const outcome = await sql.begin(async (tx) => ({
      value: await openWindow(tx as never, {
        name: 'launch week',
        startsAt: new Date(Date.now() - HOUR),
        endsAt: new Date(Date.now() + HOUR),
        budgetWei: 10_000n,
        bountyWei: 100n,
        bountyMaxListings: 3,
        operator: 'user:op',
        ...overrides,
      }),
    }))
    return outcome.value
  }

  /* ══════════════════════════════════════════════ §7.4 — a grant cannot exist without a posting */

  test('FIRE TEST: a grant with no ledger entry cannot be written', async () => {
    const w = await window()
    const listing = await seedListing(h)
    await assert.rejects(
      sql`
        insert into engagement_grants (window_id, grant_kind, beneficiary, listing_id, amount_wei)
        values (${w.id}, 'first_listing_bounty', ${SELLER}, ${listing.id}, 100)
      `,
      /ledger_entry_id/,
      'a grant row without its posting must be unwritable — 21 §7.4',
    )
  })

  test('FIRE TEST: a grant may not pay the programme itself', async () => {
    const w = await window()
    const listing = await seedListing(h)
    for (const beneficiary of ['engagement:market', 'platform:engagement-treasury']) {
      await assert.rejects(
        sql`
          insert into engagement_grants (
            window_id, grant_kind, beneficiary, listing_id, amount_wei, ledger_entry_id
          ) values (${w.id}, 'first_listing_bounty', ${beneficiary}, ${listing.id}, 100, 'e1')
        `,
        /beneficiary_is_not_the_programme/,
      )
    }
  })

  test('FIRE TEST: one listing yields at most one grant of a kind', async () => {
    const w = await window()
    const listing = await seedListing(h)
    const insert = () => sql`
      insert into engagement_grants (
        window_id, grant_kind, beneficiary, listing_id, amount_wei, ledger_entry_id
      ) values (${w.id}, 'first_listing_bounty', ${SELLER}, ${listing.id}, 100, 'e1')
    `
    await insert()
    await assert.rejects(insert(), /engagement_grants_natural_uniq/)
  })

  /* ══════════════════════════════════════════════ §5 — never ghost demand */

  test('FIRE TEST: the platform cannot fund an escrow, a bid or an offer', async () => {
    const listing = await seedListing(h)
    await assert.rejects(
      sql`
        insert into escrows (listing_id, kind, subject, asset_code, amount, hold_entry_id)
        values (${listing.id}, 'bid_funds', 'engagement:market', 'SHARD', 100, 'e1')
      `,
      /escrows_never_platform_funded/,
      'a platform-funded escrow is ghost demand, and 21 §2 refuses it outright',
    )
    await assert.rejects(
      sql`
        insert into bids (listing_id, bidder_subject, amount, asset_code)
        values (${listing.id}, 'engagement:market', 100, 'SHARD')
      `,
      /bids_never_platform_funded/,
    )
    await assert.rejects(
      sql`
        insert into offers (listing_id, offerer_subject, amount, asset_code)
        values (${listing.id}, 'engagement:market', 100, 'SHARD')
      `,
      /offers_never_platform_funded/,
    )
    // And the treasury itself, by its own spelling, is refused the same way.
    await assert.rejects(
      sql`
        insert into bids (listing_id, bidder_subject, amount, asset_code)
        values (${listing.id}, 'platform:engagement-treasury', 100, 'SHARD')
      `,
      /bids_never_platform_funded/,
    )
  })

  /* ══════════════════════════════════════════════ windows are bounded */

  test('FIRE TEST: a window cannot overspend its budget, and two windows cannot overlap', async () => {
    const w = await window({ budgetWei: 150n })
    await sql`update engagement_windows set spent_wei = 150 where id = ${w.id}`
    await assert.rejects(
      sql`update engagement_windows set spent_wei = 151 where id = ${w.id}`,
      /engagement_windows_within_budget/,
      'a budget that can be overspent is not a budget',
    )
    await assert.rejects(
      window({ name: 'second' }),
      /engagement_windows_no_overlap/,
      'two live windows would make "which budget paid for this" a question with two answers',
    )
  })

  test('a bounty with no listing cap, or a cap with no bounty, is not a policy', async () => {
    await assert.rejects(
      window({ bountyWei: 100n, bountyMaxListings: 0 }),
      /engagement_windows_bounty_pair/,
    )
  })

  /* ══════════════════════════════════════════════ paying a grant */

  test('a bounty posts one entry out of engagement:market and records the pairing', async () => {
    const w = await window()
    const listing = await seedListing(h)
    const grant = await payGrant(
      { sql: h.sql, ledger: h.ledger },
      {
        windowId: w.id,
        grantKind: 'first_listing_bounty',
        listingId: listing.id,
        amountWei: 100n,
        beneficiary: { subject: SELLER, purpose: 'available', type: 'liability' },
        actor: 'service:market',
        correlationId: 'r1',
        description: 'bounty',
      },
    )
    assert.ok(grant)
    assert.equal(grant.amountWei, 100n)
    assert.ok(grant.ledgerEntryId, 'the grant names the entry that paid it')

    // treasury_spend, debit engagement:market → credit the seller. The kind matters: the ledger's
    // vocabulary is a CHECK, so a kind outside it would be refused for every grant ever posted.
    const posted = h.ledger.entries.at(-1)!
    assert.equal(posted.kind, 'treasury_spend')
    assert.equal(posted.idempotencyKey, grantIdempotencyKey('first_listing_bounty', listing.id))
    assert.deepEqual(
      posted.postings.map((p) => [p.direction, p.account.subject, p.account.purpose, p.account.type]),
      [
        ['debit', 'engagement:market', 'treasury', 'equity'],
        ['credit', SELLER, 'available', 'liability'],
      ],
    )

    // The budget was consumed by exactly the amount granted.
    const after = await activeWindow(h.sql, new Date())
    assert.equal(after?.spentWei, 100n)
    assert.equal(await bountiesPaid(h.sql, w.id), 1)
  })

  test('a repeated grant pays once — the natural key and the ledger key agree', async () => {
    const w = await window()
    const listing = await seedListing(h)
    const input = {
      windowId: w.id,
      grantKind: 'first_listing_bounty' as const,
      listingId: listing.id,
      amountWei: 100n,
      beneficiary: { subject: SELLER, purpose: 'available' as const, type: 'liability' as const },
      actor: 'service:market',
      correlationId: 'r1',
      description: 'bounty',
    }
    assert.ok(await payGrant({ sql: h.sql, ledger: h.ledger }, input))
    const second = await payGrant({ sql: h.sql, ledger: h.ledger }, input)
    assert.equal(second, null, 'the second attempt pays nothing')

    const grants = await listGrants(h.sql)
    assert.equal(grants.length, 1)
    // And the budget was consumed once, not twice.
    assert.equal((await activeWindow(h.sql, new Date()))?.spentWei, 100n)
  })

  test('a ledger refusal returns the budget rather than silently consuming it', async () => {
    const w = await window()
    const listing = await seedListing(h)
    h.ledger.failNext(new Error('ledger is down'))
    await assert.rejects(
      payGrant(
        { sql: h.sql, ledger: h.ledger },
        {
          windowId: w.id,
          grantKind: 'first_listing_bounty',
          listingId: listing.id,
          amountWei: 100n,
          beneficiary: { subject: SELLER, purpose: 'available', type: 'liability' },
          actor: 'service:market',
          correlationId: 'r1',
          description: 'bounty',
        },
      ),
    )
    // A window that silently loses budget to an outage stops subsidising and nobody knows why.
    assert.equal((await activeWindow(h.sql, new Date()))?.spentWei, 0n)
    assert.equal(await findGrant(h.sql, 'first_listing_bounty', listing.id), null)
  })

  /* ══════════════════════════════════════════════ the subsidy makes a waiver funded */

  test('a waived fee is FUNDED out of engagement:market, not merely forgone', async () => {
    const w = await window()
    const listing = await seedListing(h, { assetCode: 'EMBER' })
    // 250 bps of 1,000 = 25, floor — money.ts's rounding, in the same direction, so the subsidy
    // can never exceed the fee that would have been charged.
    const grant = await paySettlementSubsidy(
      { sql: h.sql, ledger: h.ledger },
      {
        listingId: listing.id,
        windowId: w.id,
        waivedFeeBps: 250,
        price: 1_000n,
        assetCode: listing.assetCode,
        correlationId: 'r1',
      },
    )
    assert.ok(grant)
    assert.equal(grant.amountWei, 25n)
    const posted = h.ledger.entries.at(-1)!
    assert.deepEqual(
      posted.postings.map((p) => [p.direction, p.account.subject, p.account.purpose]),
      [
        ['debit', 'engagement:market', 'treasury'],
        // The platform's own fee line: the seller's benefit is the fee they did not pay, so the
        // revenue line is made whole from the programme rather than simply going short.
        ['credit', 'platform', 'fees'],
      ],
    )
    // micro-org#226. Both legs, and both ACCOUNTS: the ledger keys an account on
    // (subject, asset_code, purpose), so a posting in EMBER against an account spelled SHARD
    // would be a second treasury rather than a mislabelled one. SHARD appears nowhere.
    assert.deepEqual(
      posted.postings.map((p) => [p.assetCode, p.account.assetCode]),
      [
        ['EMBER', 'EMBER'],
        ['EMBER', 'EMBER'],
      ],
    )
  })

  test('a subsidy is REFUSED when the listing is priced in another asset', async () => {
    const w = await window()
    // The default seed is a SHARD-priced listing, which is still a legal listing.
    const listing = await seedListing(h)
    // Not zero: seeding a listing reserves its escrow, which is itself a ledger entry. What must
    // not move is anything AFTER that.
    const before = h.ledger.entries.length
    await assert.rejects(
      paySettlementSubsidy(
        { sql: h.sql, ledger: h.ledger },
        {
          listingId: listing.id,
          windowId: w.id,
          waivedFeeBps: 250,
          price: 1_000n,
          assetCode: listing.assetCode,
          correlationId: 'r1',
        },
      ),
      /subsidy_asset_mismatch|denominated in EMBER/,
      'a fee forgone in one asset cannot be funded from a budget in another without a rate',
    )
    // Nothing moved and no budget was consumed: the sale stands, and the absent grant row is
    // what records that the platform rather than the programme bore that fee.
    assert.equal(h.ledger.entries.length, before)
    assert.equal((await listGrants(h.sql)).length, 0)
    assert.equal((await activeWindow(h.sql, new Date()))?.spentWei, 0n)
    assert.ok(w.id)
  })

  test('an unwaived listing subsidises nothing', async () => {
    const listing = await seedListing(h)
    const grant = await paySettlementSubsidy(
      { sql: h.sql, ledger: h.ledger },
      {
        listingId: listing.id,
        windowId: null,
        waivedFeeBps: null,
        price: 1_000n,
        assetCode: listing.assetCode,
        correlationId: 'r',
      },
    )
    assert.equal(grant, null)
    assert.equal((await listGrants(h.sql)).length, 0)
  })

  /* ══════════════════════════════════════════════ the waiver's own schema rules */

  test('FIRE TEST: a waived listing cannot also charge a fee, and a half-waiver cannot exist', async () => {
    const w = await window()
    const listing = await seedListing(h, { platformFeeBps: 250 })
    // A "subsidised" listing still charging full freight is the drift these constraints exist
    // to refuse.
    await assert.rejects(
      sql`
        update listings set engagement_window_id = ${w.id}, engagement_waived_fee_bps = 250
         where id = ${listing.id}
      `,
      /listings_waived_charges_nothing/,
    )
    // And a window with no rate — or a rate with no window — cannot be recorded either. Checked
    // on a ZERO-fee listing so that `listings_waived_charges_nothing` is already satisfied and
    // the pairing constraint is the only one that can fire; otherwise the assertion would pass
    // for the wrong reason and stop testing the thing it names.
    const free = await seedListing(h, { platformFeeBps: 0, itemUrn: 'cf:mint:token:0193' })
    await assert.rejects(
      sql`update listings set engagement_window_id = ${w.id} where id = ${free.id}`,
      /listings_waiver_is_complete/,
    )
    await assert.rejects(
      sql`update listings set engagement_waived_fee_bps = 250 where id = ${free.id}`,
      /listings_waiver_is_complete/,
    )
    // A waived rate of zero waived nothing, and is refused as a description of a subsidy.
    await assert.rejects(
      sql`
        update listings set engagement_window_id = ${w.id}, engagement_waived_fee_bps = 0
         where id = ${free.id}
      `,
      /listings_waived_rate_in_range/,
    )
  })

  test('a listing created inside a window is waived, and remembers what was waived', async () => {
    const w = await window()
    // The route does this; here the fixture stands in for it, and the constraint pair is what
    // proves the two columns cannot describe a listing that was never actually waived.
    const listing = await seedListing(h, { platformFeeBps: 0 })
    await sql`
      update listings
         set engagement_window_id = ${w.id}, engagement_waived_fee_bps = 250
       where id = ${listing.id}
    `
    const rows = await sql<{ engagement_waived_fee_bps: number }[]>`
      select engagement_waived_fee_bps from listings where id = ${listing.id}
    `
    assert.equal(rows[0]?.engagement_waived_fee_bps, 250)
    void BUYER
  })
})
