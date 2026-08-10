/**
 * The schema, and the constraints that are the point of it.
 *
 * These tests write SQL directly rather than going through the domain modules, deliberately. The
 * domain modules are supposed to make these states unreachable; this file proves that the
 * DATABASE would refuse them even if the domain modules were wrong — which is the only version of
 * the claim that survives a refactor.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { migrateTestDb, openDb, resetMarket, skip } from './testsupport.ts'

test('every migration version is unique and monotonic', () => {
  const versions = MIGRATIONS.map((migration) => migration.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
})

test('SCHEMA_VERSION is the highest migration', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines at zero — there is nothing to adopt', () => {
  // 03-repository-responsibilities lists cloudsforge-market as `new`. No marketplace exists in
  // the frozen estate: no listings, no orders, no escrow, no reservation concept anywhere.
  assert.equal(BASELINE_VERSION, 0)
})

test('the truncate list names every table the migrations create', () => {
  // A table missing from TABLES survives a reset and leaks state into the next test file, which
  // presents as an unrelated test failing intermittently.
  const created = new Set<string>()
  for (const migration of MIGRATIONS) {
    for (const match of migration.up.matchAll(/create table if not exists (\w+)/g)) {
      created.add(match[1] as string)
    }
  }
  created.delete('jobs')
  assert.deepEqual([...created].sort(), [...TABLES].sort())
})

describe('the schema, against a real Postgres', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb(4)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /**
   * The id an `insert ... returning id` must have produced.
   *
   * `noUncheckedIndexedAccess` types `rows[0]` as possibly absent, and it is right to: a query
   * parameter of `undefined` is not a null, it is a postgres.js type error at the call site three
   * frames away from the insert that actually went wrong. Narrowing here fails at the insert, with
   * the reason, instead of casting the doubt away.
   */
  const insertedId = (rows: readonly { id: string }[]): string => {
    const row = rows[0]
    if (!row) throw new Error('the insert returned no row')
    return row.id
  }

  const seedListing = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      insert into listings ${sql({
        seller_subject: 'user:alice',
        asset_kind: 'collectible',
        item_urn: 'cf:mint:token:1',
        quantity: '1',
        item_asset_code: 'TOKEN:cf:mint:token:1',
        pricing_mode: 'fixed',
        price: '1000',
        asset_code: 'SHARD',
        settlement_mode: 'custodial',
        platform_fee_bps: 250,
        ...overrides,
      })}
      returning id
    `
    return insertedId(rows)
  }

  test('the migrator reached the version the service asserts', async () => {
    const rows = await sql<{ version: number }[]>`
      select max(version)::int as version from schema_migrations
    `
    assert.equal(rows[0]?.version, SCHEMA_VERSION)
  })

  test('running the migrations twice is a no-op', async () => {
    // 17 §9: "a migration that ran once on an empty database" is not done. This is the weaker but
    // checkable half — idempotence — run in CI on every push.
    await migrateTestDb(sql)
    const rows = await sql<{ version: number }[]>`
      select max(version)::int as version from schema_migrations
    `
    assert.equal(rows[0]?.version, SCHEMA_VERSION)
  })

  /* ---------------------------------------------------------------- listings */

  test('AN ACTIVE CUSTODIAL LISTING CANNOT EXIST WITHOUT AN ESCROW', async () => {
    // 04-domain-model §6.1. The whole anti-double-sale argument, refused by the database.
    const id = await seedListing()
    await assert.rejects(
      sql`update listings set status = 'active' where id = ${id}`,
      /listings_active_is_escrowed/,
    )
  })

  test('an active ON-CHAIN listing cannot exist without a confirmed escrow transaction', async () => {
    const id = await seedListing({ settlement_mode: 'onchain', seller_wallet_id: 'wallet-1' })
    await assert.rejects(
      sql`update listings set status = 'active' where id = ${id}`,
      /listings_active_is_escrowed/,
    )
    await sql`update listings set status = 'active', onchain_escrow_tx = '0xdead' where id = ${id}`
    const rows = await sql<{ status: string }[]>`select status from listings where id = ${id}`
    assert.equal(rows[0]?.status, 'active')
  })

  test('an on-chain listing must name the wallet that owns the item', async () => {
    await assert.rejects(
      seedListing({ settlement_mode: 'onchain' }),
      /listings_onchain_names_a_wallet/,
    )
  })

  test('a listing whose fee and royalty leave the seller nothing cannot be written', async () => {
    await assert.rejects(
      seedListing({ platform_fee_bps: 5_000, royalty_bps: 5_000 }),
      /listings_terms_leave_the_seller_something/,
    )
  })

  test('an auction must say when it ends', async () => {
    await assert.rejects(seedListing({ pricing_mode: 'auction' }), /listings_auction_has_end/)
  })

  test('a fixed-price listing must carry a price', async () => {
    await assert.rejects(
      seedListing({ pricing_mode: 'fixed', price: null }),
      /listings_fixed_has_price/,
    )
  })

  test('an offers-only listing needs no price at all', async () => {
    const id = await seedListing({ pricing_mode: 'offers_only', price: null })
    assert.ok(id)
  })

  test('the status and mode columns are closed sets', async () => {
    await assert.rejects(seedListing({ status: 'haggling' }), /listings_status_known/)
    await assert.rejects(seedListing({ pricing_mode: 'dutch' }), /listings_pricing_mode_known/)
    await assert.rejects(seedListing({ settlement_mode: 'barter' }), /listings_settlement_mode_known/)
    await assert.rejects(seedListing({ asset_kind: 'goat' }), /listings_asset_kind_known/)
  })

  test('a listing quantity must be positive', async () => {
    await assert.rejects(seedListing({ quantity: '0' }), /listings_quantity_positive/)
  })

  /* ---------------------------------------------------------------- escrows */

  const seedEscrow = async (listingId: string, overrides: Record<string, unknown> = {}) => {
    const rows = await sql<{ id: string }[]>`
      insert into escrows ${sql({
        listing_id: listingId,
        kind: 'listing_item',
        subject: 'user:alice',
        asset_code: 'TOKEN:cf:mint:token:1',
        amount: '1',
        hold_entry_id: 'entry-1',
        ...overrides,
      })}
      returning id
    `
    return rows[0]?.id as string
  }

  test('a settled escrow must name the entry that settled it', async () => {
    const listingId = await seedListing()
    const escrowId = await seedEscrow(listingId)
    await assert.rejects(
      sql`update escrows set state = 'released' where id = ${escrowId}`,
      /escrows_settled_names_entry/,
    )
  })

  test('a held escrow may not already carry a settlement', async () => {
    const listingId = await seedListing()
    await assert.rejects(
      seedEscrow(listingId, { settle_entry_id: 'entry-2', kind: 'bid_funds' }),
      /escrows_held_has_no_settlement/,
    )
  })

  test('one listing has at most one item escrow, ever', async () => {
    // Total rather than partial on state, so a cancel-then-reactivate cycle cannot stack
    // reservations against one item.
    const listingId = await seedListing()
    await seedEscrow(listingId)
    await assert.rejects(seedEscrow(listingId), /escrows_listing_item_uniq/)
  })

  test('an escrow amount must be positive', async () => {
    const listingId = await seedListing()
    await assert.rejects(seedEscrow(listingId, { amount: '0' }), /escrows_amount_positive/)
  })

  /* ---------------------------------------------------------------- bids */

  test('AT MOST ONE LEADING BID PER LISTING', async () => {
    // The database half of the concurrent-bid defence. The row lock in bids.ts is the design;
    // this is what happens if somebody removes the design.
    const listingId = await seedListing({ pricing_mode: 'auction', auction_ends_at: new Date(Date.now() + 60_000) })
    await sql`
      insert into bids (listing_id, bidder_subject, amount, asset_code)
      values (${listingId}, 'user:bob', '100', 'SHARD')
    `
    await assert.rejects(
      sql`
        insert into bids (listing_id, bidder_subject, amount, asset_code)
        values (${listingId}, 'user:carol', '200', 'SHARD')
      `,
      /bids_leading_uniq/,
    )
  })

  test('a displaced bid frees the leading slot', async () => {
    const listingId = await seedListing({ pricing_mode: 'auction', auction_ends_at: new Date(Date.now() + 60_000) })
    await sql`
      insert into bids (listing_id, bidder_subject, amount, asset_code)
      values (${listingId}, 'user:bob', '100', 'SHARD')
    `
    await sql`update bids set status = 'outbid' where listing_id = ${listingId}`
    await sql`
      insert into bids (listing_id, bidder_subject, amount, asset_code)
      values (${listingId}, 'user:carol', '200', 'SHARD')
    `
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from bids where listing_id = ${listingId} and status = 'leading'
    `
    assert.equal(rows[0]?.n, 1)
  })

  test('one open offer per buyer per listing', async () => {
    const listingId = await seedListing()
    await sql`
      insert into offers (listing_id, offerer_subject, amount, asset_code)
      values (${listingId}, 'user:bob', '900', 'SHARD')
    `
    await assert.rejects(
      sql`
        insert into offers (listing_id, offerer_subject, amount, asset_code)
        values (${listingId}, 'user:bob', '950', 'SHARD')
      `,
      /offers_open_uniq/,
    )
  })

  /* ---------------------------------------------------------------- orders */

  const seedOrder = async (listingId: string, overrides: Record<string, unknown> = {}) => {
    const rows = await sql<{ id: string }[]>`
      insert into orders ${sql({
        listing_id: listingId,
        buyer_subject: 'user:bob',
        seller_subject: 'user:alice',
        item_urn: 'cf:mint:token:1',
        item_asset_code: 'TOKEN:cf:mint:token:1',
        quantity: '1',
        amount: '1000',
        fee_amount: '25',
        royalty_amount: '0',
        seller_proceeds: '975',
        asset_code: 'SHARD',
        settlement_mode: 'custodial',
        journal_entry_id: 'entry-9',
        source: 'purchase',
        settled_at: new Date(),
        ...overrides,
      })}
      returning id
    `
    return insertedId(rows)
  }

  test('ONE LISTING YIELDS AT MOST ONE ORDER, FOR EVER', async () => {
    // The last line under every concurrency defence in this repository.
    const listingId = await seedListing()
    await seedOrder(listingId)
    await assert.rejects(seedOrder(listingId), /orders_listing_uniq/)
  })

  test('AN ORDER MUST PARTITION ITS OWN PRICE', async () => {
    // fee + royalty + proceeds = amount, checked by Postgres. money.ts computes it; this proves
    // money.ts was the thing that computed it.
    const listingId = await seedListing()
    await assert.rejects(
      seedOrder(listingId, { fee_amount: '25', royalty_amount: '0', seller_proceeds: '974' }),
      /orders_partition/,
    )
  })

  test('an order references EXACTLY ONE settlement artefact — never neither', async () => {
    const listingId = await seedListing()
    await assert.rejects(
      seedOrder(listingId, { journal_entry_id: null }),
      /orders_one_settlement_artefact/,
    )
  })

  test('an order references EXACTLY ONE settlement artefact — never both', async () => {
    // Both means one sale settled twice, in two systems, which is worse than settling in neither.
    const listingId = await seedListing()
    await assert.rejects(
      seedOrder(listingId, { outbound_transaction_id: '0xbeef' }),
      /orders_one_settlement_artefact/,
    )
  })

  test('an on-chain order may name only its transaction', async () => {
    const listingId = await seedListing({ settlement_mode: 'onchain', seller_wallet_id: 'w' })
    const id = await seedOrder(listingId, {
      settlement_mode: 'onchain',
      journal_entry_id: null,
      outbound_transaction_id: '0xbeef',
    })
    assert.ok(id)
  })

  test('an on-chain order can never hold proceeds — the platform was never a party', async () => {
    const listingId = await seedListing({ settlement_mode: 'onchain', seller_wallet_id: 'w' })
    await assert.rejects(
      seedOrder(listingId, {
        settlement_mode: 'onchain',
        journal_entry_id: null,
        outbound_transaction_id: '0xbeef',
        proceeds_state: 'held',
        payout_due_at: new Date(),
      }),
      /orders_onchain_holds_nothing/,
    )
  })

  test('held proceeds must have a due date', async () => {
    const listingId = await seedListing()
    await assert.rejects(
      seedOrder(listingId, { proceeds_state: 'held' }),
      /orders_held_proceeds_have_a_due_date/,
    )
  })

  /* ---------------------------------------------------------------- moderation */

  test('one open freeze per listing', async () => {
    const listingId = await seedListing()
    await sql`
      insert into moderation_cases (subject_kind, subject_urn, listing_id, reason, action, opened_by)
      values ('listing', 'cf:market:listing:1', ${listingId}, 'reported', 'freeze', 'ops-1')
    `
    await assert.rejects(
      sql`
        insert into moderation_cases (subject_kind, subject_urn, listing_id, reason, action, opened_by)
        values ('listing', 'cf:market:listing:1', ${listingId}, 'reported again', 'delist', 'ops-2')
      `,
      /moderation_open_freeze_uniq/,
    )
  })

  test('a case that freezes must name the listing it acts on', async () => {
    await assert.rejects(
      sql`
        insert into moderation_cases (subject_kind, subject_urn, reason, action, opened_by)
        values ('listing', 'cf:market:listing:1', 'reported', 'freeze', 'ops-1')
      `,
      /moderation_action_has_a_target/,
    )
  })

  test('a resolved case says who resolved it', async () => {
    const listingId = await seedListing()
    const rows = await sql<{ id: string }[]>`
      insert into moderation_cases (subject_kind, subject_urn, listing_id, reason, action, opened_by)
      values ('listing', 'cf:market:listing:1', ${listingId}, 'reported', 'freeze', 'ops-1')
      returning id
    `
    const caseId = insertedId(rows)
    await assert.rejects(
      sql`update moderation_cases set state = 'upheld' where id = ${caseId}`,
      /moderation_resolved_is_attributed/,
    )
  })

  test('a dispute recorded as refunded must name the entry that refunded it', async () => {
    const listingId = await seedListing()
    const orderId = await seedOrder(listingId)
    const rows = await sql<{ id: string }[]>`
      insert into disputes (order_id, raiser_subject, reason)
      values (${orderId}, 'user:bob', 'never arrived') returning id
    `
    const disputeId = insertedId(rows)
    await assert.rejects(
      sql`
        update disputes set state = 'resolved_refunded', resolved_at = now()
         where id = ${disputeId}
      `,
      /disputes_refund_names_its_entry/,
    )
  })

  test('one open dispute per order', async () => {
    const listingId = await seedListing()
    const orderId = await seedOrder(listingId)
    await sql`
      insert into disputes (order_id, raiser_subject, reason)
      values (${orderId}, 'user:bob', 'never arrived')
    `
    await assert.rejects(
      sql`
        insert into disputes (order_id, raiser_subject, reason)
        values (${orderId}, 'user:bob', 'still not here')
      `,
      /disputes_open_uniq/,
    )
  })

  /* ---------------------------------------------------------------- verification */

  test('a verification level that somebody chose says who chose it', async () => {
    await assert.rejects(
      sql`insert into verifications (subject_urn, level) values ('cf:mint:token:1', 'verified')`,
      /verifications_reviewed_is_attributed/,
    )
    // `unverified` is the absence of a decision and needs no reviewer.
    await sql`insert into verifications (subject_urn, level) values ('cf:mint:token:1', 'unverified')`
  })

  test('a collection slug cannot be a path traversal', async () => {
    await assert.rejects(
      sql`insert into collections (owner_subject, slug, name) values ('user:a', '../etc', 'x')`,
      /collections_slug_shape/,
    )
  })

  /* ---------------------------------------------------------------- the absent column */

  test('NO TABLE IN THIS SERVICE HAS A BALANCE COLUMN', async () => {
    // 04-domain-model §11: no user balance column anywhere outside the ledger's projection. If a
    // column here ever starts being decremented, market has become a second ledger and the trial
    // balance has stopped meaning anything.
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name = any(${TABLES as string[]})
         and (column_name like '%balance%' or column_name = 'held_amount')
    `
    // `[...rows]`, not `rows`: postgres.js returns a `Result` subclass of Array, and
    // `deepEqual(Result(0), [])` fails on the prototype rather than on the contents — which reads
    // as "there IS a balance column" and would send the next person hunting for one.
    assert.deepEqual([...rows], [])
  })

  test('every money column is numeric(78,0), never a float', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string; numeric_scale: number | null }[]>`
      select table_name, column_name, data_type, numeric_scale
        from information_schema.columns
       where table_schema = 'public'
         and table_name = any(${TABLES as string[]})
         and column_name in ('amount','price','reserve_price','fee_amount','royalty_amount',
                             'seller_proceeds','quantity','bps')
    `
    assert.ok(rows.length > 0, 'the query found no money columns at all, which is itself a bug')
    for (const row of rows) {
      if (row.column_name === 'bps') {
        assert.equal(row.data_type, 'integer', `${row.table_name}.${row.column_name}`)
        continue
      }
      // A float anywhere near an amount is a defect. `numeric(78,0)` is exact and has no scale.
      assert.equal(row.data_type, 'numeric', `${row.table_name}.${row.column_name}`)
      assert.equal(row.numeric_scale, 0, `${row.table_name}.${row.column_name}`)
    }
  })
})

/**
 * Migration 14 replayed against a database that predates it — micro-org#226.
 *
 * The rest of this file proves the schema AT HEAD refuses what it should. This one proves the
 * UPGRADE: it brings a scratch schema to version 13, writes the rows a pre-#226 database would
 * hold, applies 14, and reads them back. A migration that is only ever run against an empty test
 * database is a migration whose conversion arithmetic nothing has checked.
 *
 * The scratch schema is a second connection with its own `search_path`, so this runs against the
 * same Postgres as everything else without touching the shared `public` schema — the suite's
 * other files truncate `public` between cases and would otherwise race this.
 */
test('migration 14 converts the engagement figures at 4e16, and the CHECKs follow the rename', { skip }, async () => {
  const SCHEMA = 'mig14_replay'
  const WEI_PER_SHARD = 40_000_000_000_000_000n
  const admin = openDb(2)
  let scratch: postgres.Sql | undefined
  try {
    await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`)
    await admin.unsafe(`create schema ${SCHEMA}`)
    scratch = postgres(process.env['MARKET_TEST_DATABASE_URL']!, {
      max: 2,
      onnotice: () => {},
      connection: { search_path: SCHEMA },
    })

    // ── the world before #226 ────────────────────────────────────────────────────────────────
    await migrate(
      scratch as never,
      MIGRATIONS.filter((migration) => migration.version <= 13),
      { service: 'market-mig14-replay' },
    )
    const listing = await scratch<{ id: string }[]>`
      insert into listings ${scratch({
        seller_subject: 'user:alice',
        asset_kind: 'collectible',
        item_urn: 'cf:mint:token:1',
        quantity: '1',
        item_asset_code: 'TOKEN:cf:mint:token:1',
        pricing_mode: 'fixed',
        price: '1000',
        asset_code: 'SHARD',
        settlement_mode: 'custodial',
        platform_fee_bps: 250,
      })}
      returning id
    `
    const listingId = listing[0]!.id
    const opened = await scratch<{ id: string }[]>`
      insert into engagement_windows
        (name, starts_at, ends_at, budget_shards, spent_shards, bounty_shards, bounty_max_listings, created_by)
      values ('launch week', now() - interval '1 hour', now() + interval '1 hour',
              10000, 250, 100, 3, 'user:op')
      returning id
    `
    const windowId = opened[0]!.id
    await scratch`
      insert into engagement_grants
        (window_id, grant_kind, beneficiary, listing_id, amount_shards, ledger_entry_id)
      values (${windowId}, 'first_listing_bounty', 'user:alice', ${listingId}, 25, 'entry-1')
    `

    // ── the upgrade ─────────────────────────────────────────────────────────────────────────
    await migrate(scratch as never, MIGRATIONS, { service: 'market-mig14-replay' })

    const [window] = await scratch<{ budget: string; spent: string; bounty: string }[]>`
      select budget_wei::text as budget, spent_wei::text as spent, bounty_wei::text as bounty
        from engagement_windows where id = ${windowId}
    `
    assert.equal(window!.budget, (10_000n * WEI_PER_SHARD).toString())
    assert.equal(window!.spent, (250n * WEI_PER_SHARD).toString())
    assert.equal(window!.bounty, (100n * WEI_PER_SHARD).toString())

    const [grant] = await scratch<{ amount: string }[]>`
      select amount_wei::text as amount from engagement_grants where window_id = ${windowId}
    `
    assert.equal(grant!.amount, (25n * WEI_PER_SHARD).toString())

    // The old names are gone rather than shadowed. Two spellings of one budget is the state this
    // migration exists to avoid, so it is asserted rather than assumed.
    const columns = await scratch<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = ${SCHEMA}
         and table_name in ('engagement_windows','engagement_grants')
         and column_name like '%shards%'
    `
    assert.deepEqual([...columns], [])

    // ── the CHECKs followed the rename by themselves ────────────────────────────────────────
    //
    // Postgres stores a CHECK as a parse tree over attribute numbers, so RENAME COLUMN rewrites
    // what the constraint reads. This is the assertion that makes migration 14's decision NOT to
    // drop and rebuild them safe to rely on — and the reason it differs from micro-admin-api's
    // migration 13 and micro-worlds' migration 11, both of which had to drop plpgsql triggers,
    // whose bodies are text resolved at execution time.
    await assert.rejects(
      scratch`update engagement_windows set spent_wei = budget_wei + 1 where id = ${windowId}`,
      /engagement_windows_within_budget/,
      'the budget bound must still bite on the new column names',
    )
    await assert.rejects(
      scratch`update engagement_grants set amount_wei = 0 where window_id = ${windowId}`,
      /engagement_grants_amount_positive/,
      'a grant of nothing must still be unwritable',
    )
  } finally {
    if (scratch) await scratch.end({ timeout: 5 })
    await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`)
    await admin.end({ timeout: 5 })
  }
})
