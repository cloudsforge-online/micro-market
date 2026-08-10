/**
 * Subsidies and bounties — docs/ecosystem/21 §5, phase 2.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PLATFORM FUNDS SUPPLY. IT IS FORBIDDEN FROM FUNDING DEMAND, AND THAT IS A SCHEMA FACT.**
 *
 * Zero listings begets zero buyers begets zero listings. The platform breaks the circle from the
 * SUPPLY side only — it waives the listing fee for a window and pays a bounty for the first
 * listings — because the demand side of that same idea is `21 §2`'s "fake it": synthetic bids and
 * ghost demand, the one form of this that costs nothing and is fraud.
 *
 * A comment is not what stops that. `escrows_never_platform_funded`,
 * `bids_never_platform_funded` and `offers_never_platform_funded` (migration 11) make a
 * platform-funded bid, offer or escrow unrepresentable, so the refusal survives whoever writes
 * the next route.
 *
 * **EVERY GRANT NAMES ITS LEDGER ENTRY, AND CANNOT BE WRITTEN BEFORE IT** —
 * `engagement_grants.ledger_entry_id` is NOT NULL (21 §7.4). So the order is always: post to the
 * ledger on a key derived from the LISTING, then record. A crash between them leaves an entry
 * with no row — the safe direction, visible in the ledger, and adopted by the retry — never a
 * recorded payment that never happened.
 *
 * **THE DEBIT SIDE IS ALWAYS `engagement:market`**, spelled by `engagementAccount` in
 * `@cloudsforge/contracts-money` rather than here, because the ledger's account key is
 * `(subject, asset_code, purpose)` and a second spelling would silently split the programme's
 * ledger in half. Its `equity` type is what makes the ledger refuse a grant the account cannot
 * afford: `ledger_assert_no_overdraft` exempts `clearing` and `suspense`, not `equity`. **A
 * market that has not been funded cannot subsidise anything**, and it finds that out from the
 * ledger rather than from a handler that forgot to look.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { IssuableAssetCode } from '@cloudsforge/contracts-chain'
import { ENGAGEMENT_GRANT_KIND, engagementAccount } from '@cloudsforge/contracts-money'
import type { LedgerClient, PostingRequest } from './ledgerclient.ts'
import type { Db, Tx } from './outbox.ts'

/**
 * EMBER wei is the engagement programme's unit — 21 §2, "bounded, disclosed, and denominated in
 * EMBER".
 *
 * This said `const SHARD = 'SHARD'` until 2026-08-10 (micro-org#226), under a citation of the
 * same paragraph, which read "denominated in Shards" until 2026-08-07. SHARD was retired on
 * 2026-08-04: `RETIRED_ASSETS` in `@cloudsforge/contracts-chain`, where `assertIssuable` refuses
 * it by name. Migration 14 converted the columns beside this at the rate frozen there.
 *
 * **The type is what keeps it EMBER.** `IssuableAssetCode` is `Exclude<AssetCode, 'SHARD'>`, so
 * a change that pointed this back at a retired asset does not compile. A bare string literal
 * compiled either way, which is precisely how the old spelling survived three months of review.
 */
export const ENGAGEMENT_ASSET: IssuableAssetCode = 'EMBER'

export type GrantKind = 'listing_fee_subsidy' | 'first_listing_bounty'

export class EngagementError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'EngagementError'
    this.code = code
    this.status = status
  }
}

export interface EngagementWindow {
  readonly id: string
  readonly name: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly budgetWei: bigint
  readonly spentWei: bigint
  readonly bountyWei: bigint
  readonly bountyMaxListings: number
  readonly createdBy: string
  readonly createdAt: Date
}

interface WindowRow {
  readonly id: string
  readonly name: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly budget_wei: string
  readonly spent_wei: string
  readonly bounty_wei: string
  readonly bounty_max_listings: number
  readonly created_by: string
  readonly created_at: Date
}

const WINDOW_COLUMNS = `id, name, starts_at, ends_at, budget_wei::text, spent_wei::text,
                        bounty_wei::text, bounty_max_listings, created_by, created_at`

function toWindow(row: WindowRow): EngagementWindow {
  return {
    id: row.id,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    budgetWei: BigInt(row.budget_wei),
    spentWei: BigInt(row.spent_wei),
    bountyWei: BigInt(row.bounty_wei),
    bountyMaxListings: row.bounty_max_listings,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/**
 * The window covering an instant, if any.
 *
 * At most one can exist — `engagement_windows_no_overlap`, a GiST exclusion constraint — so this
 * returns one row rather than a list, and that is a schema guarantee rather than a `limit 1`.
 */
export async function activeWindow(sql: Db | Tx, at: Date): Promise<EngagementWindow | null> {
  const rows = await sql<WindowRow[]>`
    select ${sql.unsafe(WINDOW_COLUMNS)} from engagement_windows
     where starts_at <= ${at} and ends_at > ${at}
  `
  const row = rows[0]
  return row ? toWindow(row) : null
}

export async function listWindows(sql: Db | Tx, limit = 50): Promise<readonly EngagementWindow[]> {
  const rows = await sql<WindowRow[]>`
    select ${sql.unsafe(WINDOW_COLUMNS)} from engagement_windows
     order by starts_at desc limit ${limit}
  `
  return rows.map(toWindow)
}

export interface OpenWindowInput {
  readonly name: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly budgetWei: bigint
  readonly bountyWei: bigint
  readonly bountyMaxListings: number
  readonly operator: string
}

/**
 * Open a window. Operator-only at the route.
 *
 * Overlap, ordering, budget positivity and the bounty pair are all schema constraints, so this
 * function does not re-check them — it translates their failures into sentences an operator can
 * act on. Re-checking in the handler would be a second rule to keep in step with the first.
 */
export async function openWindow(tx: Tx, input: OpenWindowInput): Promise<EngagementWindow> {
  const rows = await tx<WindowRow[]>`
    insert into engagement_windows (
      name, starts_at, ends_at, budget_wei, bounty_wei, bounty_max_listings, created_by
    ) values (
      ${input.name}, ${input.startsAt}, ${input.endsAt}, ${input.budgetWei.toString()},
      ${input.bountyWei.toString()}, ${input.bountyMaxListings}, ${input.operator}
    )
    returning ${tx.unsafe(WINDOW_COLUMNS)}
  `
  return toWindow(rows[0]!)
}

/* ------------------------------------------------------------------ grants */

export interface EngagementGrant {
  readonly id: string
  readonly windowId: string | null
  readonly grantKind: GrantKind
  readonly beneficiary: string
  readonly listingId: string | null
  readonly amountWei: bigint
  readonly ledgerEntryId: string
  readonly grantedAt: Date
}

interface GrantRow {
  readonly id: string
  readonly window_id: string | null
  readonly grant_kind: GrantKind
  readonly beneficiary: string
  readonly listing_id: string | null
  readonly amount_wei: string
  readonly ledger_entry_id: string
  readonly granted_at: Date
}

const GRANT_COLUMNS = `id, window_id, grant_kind, beneficiary, listing_id, amount_wei::text,
                       ledger_entry_id, granted_at`

function toGrant(row: GrantRow): EngagementGrant {
  return {
    id: row.id,
    windowId: row.window_id,
    grantKind: row.grant_kind,
    beneficiary: row.beneficiary,
    listingId: row.listing_id,
    amountWei: BigInt(row.amount_wei),
    ledgerEntryId: row.ledger_entry_id,
    grantedAt: row.granted_at,
  }
}

/**
 * The key one grant is posted under, for ever.
 *
 * Derived from the LISTING and the kind — both of which exist before the money moves — and NEVER
 * from the `engagement_grants` row, which does not exist yet. `idempotencyKeys` in
 * `ledgerclient.ts` states the rule and the reason: a key derived from the row a transaction is
 * about to create does not survive a retry, because the retry generates a different id and
 * therefore pays a second time. It is the same tuple as `engagement_grants_natural_uniq`, so a
 * replayed post and a refused insert describe one fact rather than disagreeing about it.
 */
export function grantIdempotencyKey(kind: GrantKind, listingId: string): string {
  return `market:engagement:${kind}:${listingId}`
}

/** The two postings every grant is: out of `engagement:market`, into the beneficiary. */
export function grantPostings(input: {
  readonly amountWei: bigint
  readonly beneficiary: { readonly subject: string; readonly purpose: 'available' | 'fees'; readonly type: 'liability' | 'revenue' }
}): readonly PostingRequest[] {
  const from = engagementAccount('market', ENGAGEMENT_ASSET)
  return [
    {
      direction: 'debit',
      amount: input.amountWei,
      assetCode: ENGAGEMENT_ASSET,
      sequence: 0,
      account: { subject: from.subject, assetCode: ENGAGEMENT_ASSET, purpose: from.purpose, type: from.type },
    },
    {
      direction: 'credit',
      amount: input.amountWei,
      assetCode: ENGAGEMENT_ASSET,
      sequence: 1,
      account: {
        subject: input.beneficiary.subject,
        assetCode: ENGAGEMENT_ASSET,
        purpose: input.beneficiary.purpose,
        type: input.beneficiary.type,
      },
    },
  ]
}

export interface PayGrantInput {
  readonly windowId: string
  readonly grantKind: GrantKind
  readonly listingId: string
  readonly amountWei: bigint
  readonly beneficiary: { readonly subject: string; readonly purpose: 'available' | 'fees'; readonly type: 'liability' | 'revenue' }
  readonly actor: string
  readonly correlationId: string
  readonly description: string
}

export interface PayGrantDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
}

/**
 * Pay a grant: consume the window's budget, post the entry, record the row.
 *
 * **The budget is consumed FIRST, in its own committed transaction**, and that ordering is the
 * whole safety argument. `engagement_windows_within_budget` refuses the UPDATE that would take
 * `spent_wei` past `budget_wei`, so two concurrent grants racing the last of a budget
 * serialise on the row and the loser is refused by the database — not by a handler that read the
 * balance a moment ago. Only then does any money move.
 *
 * If the ledger then refuses (an unfunded `engagement:market` is the ordinary case —
 * `ledger_assert_no_overdraft` does not exempt `equity`), the consumed budget is returned in a
 * compensating update and the caller is told. The alternative — post first, consume after — can
 * overspend the budget, and a budget that can be overspent is not one.
 *
 * Returns `null` when the grant already exists, which is the retry path: the natural-key unique
 * index and the ledger's idempotency key agree that this listing has already been granted.
 */
export async function payGrant(
  deps: PayGrantDeps,
  input: PayGrantInput,
): Promise<EngagementGrant | null> {
  const existing = await findGrant(deps.sql, input.grantKind, input.listingId)
  if (existing) return null

  // 1. Consume the budget, bounded by the CHECK. Committed before anything moves.
  const claimed = await deps.sql<{ id: string }[]>`
    update engagement_windows
       set spent_wei = spent_wei + ${input.amountWei.toString()}
     where id = ${input.windowId}
    returning id
  `
  if (claimed.length === 0) {
    throw new EngagementError('no_window', 'the engagement window vanished while granting')
  }

  let entryId: string
  try {
    // 2. The money. Idempotent on the listing, so a retry replays rather than paying twice.
    const entry = await deps.ledger.postEntry({
      kind: ENGAGEMENT_GRANT_KIND,
      actor: input.actor as never,
      correlationId: input.correlationId,
      idempotencyKey: grantIdempotencyKey(input.grantKind, input.listingId),
      description: input.description,
      postings: grantPostings({ amountWei: input.amountWei, beneficiary: input.beneficiary }),
    })
    entryId = entry.id
  } catch (err) {
    // The budget was consumed for a grant that did not happen. Give it back, then report — a
    // window that silently loses budget to a ledger outage stops subsidising and nobody knows why.
    await deps.sql`
      update engagement_windows
         set spent_wei = spent_wei - ${input.amountWei.toString()}
       where id = ${input.windowId}
    `
    throw err
  }

  // 3. The row, which cannot be written without the entry id — 21 §7.4.
  const rows = await deps.sql<GrantRow[]>`
    insert into engagement_grants (
      window_id, grant_kind, beneficiary, listing_id, amount_wei, ledger_entry_id, correlation_id
    ) values (
      ${input.windowId}, ${input.grantKind}, ${input.beneficiary.subject}, ${input.listingId},
      ${input.amountWei.toString()}, ${entryId}, ${input.correlationId}
    )
    on conflict do nothing
    returning ${deps.sql.unsafe(GRANT_COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    // A concurrent attempt won the natural key. The ledger replayed rather than paying twice, so
    // the money is right; this attempt's budget consumption is the surplus and is returned.
    await deps.sql`
      update engagement_windows
         set spent_wei = spent_wei - ${input.amountWei.toString()}
       where id = ${input.windowId}
    `
    return null
  }
  return toGrant(row)
}

export async function findGrant(
  sql: Db | Tx,
  kind: GrantKind,
  listingId: string,
): Promise<EngagementGrant | null> {
  const rows = await sql<GrantRow[]>`
    select ${sql.unsafe(GRANT_COLUMNS)} from engagement_grants
     where grant_kind = ${kind} and listing_id = ${listingId}
  `
  const row = rows[0]
  return row ? toGrant(row) : null
}

export async function listGrants(sql: Db | Tx, limit = 100): Promise<readonly EngagementGrant[]> {
  const rows = await sql<GrantRow[]>`
    select ${sql.unsafe(GRANT_COLUMNS)} from engagement_grants
     order by granted_at desc limit ${limit}
  `
  return rows.map(toGrant)
}

/**
 * How many bounties this window has already paid. The bounty is "first-N-listing", so the count
 * is what N bounds.
 */
export async function bountiesPaid(sql: Db | Tx, windowId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from engagement_grants
     where window_id = ${windowId} and grant_kind = 'first_listing_bounty'
  `
  return Number(rows[0]?.n ?? '0')
}

/* ------------------------------------------------------------------ the settlement subsidy */

/**
 * Fund a waived listing fee out of `engagement:market` — the leg that makes a zero-fee window a
 * SUBSIDY rather than a discount.
 *
 * Without this the platform simply earns less, the window's budget is fictional, and 21 §4's
 * promise that an auditor reconstructs the programme from the ledger is false for every waiver.
 * With it, the seller pays nothing, the platform's fee line is made whole from the engagement
 * account, and the cost is a countable `treasury_spend`.
 *
 * **Called AFTER settlement has committed, never inside it.** Settlement is one balanced entry
 * in one transaction, and an HTTP call inside that transaction would hold it open across a peer.
 * More importantly, a subsidy that could fail a sale would mean a buyer's purchase breaking
 * because a marketing budget ran out — so every failure here is reported and swallowed by the
 * caller, and the sale stands either way. The seller has already paid no fee; what a failure
 * costs is that the platform, not the programme, bore it — which the missing grant row records.
 *
 * The forgone amount is floor(price × waivedBps / 10 000) — `money.ts`'s rounding, in the same
 * direction, so the subsidy can never exceed the fee that would have been charged.
 *
 * ── THE LISTING'S ASSET MUST BE THE PROGRAMME'S ASSET, AND IT IS CHECKED HERE ────────────────
 *
 * `forgone` is a fraction of the LISTING's price, so it is denominated in whatever that listing
 * is priced in — `listings.asset_code`, which is any `LedgerAssetCode`. Until 2026-08-10 this
 * function posted that figure as SHARD whatever the listing was priced in, which was wrong twice
 * over: the amount was a number of one asset's units labelled as another's, and the credit landed
 * in `(platform, SHARD, fees)` rather than in the fee line the waived fee would have reached,
 * which is keyed by the listing's own asset. Live listings on mainnet 2026-08-10: eight, three
 * priced in EMBER and five in SHARD, all `draft`; zero windows and zero grants, so nothing has
 * ever taken this path.
 *
 * Refused rather than converted. A budget denominated in EMBER wei cannot fund a fee forgone in
 * litoshi without a rate, and the estate's one administered rate is an operator-editable row —
 * so a silent conversion here would make the programme's spend figure depend on when it was
 * read. The failure is the caller's ordinary swallowed one: the sale stands, the seller still
 * pays nothing, and the absent grant row records that the platform rather than the programme
 * bore that fee. That is the same trade this function's header already makes for a ledger
 * outage, and it is visible in the warning the caller logs.
 */
export async function paySettlementSubsidy(
  deps: PayGrantDeps,
  input: {
    readonly listingId: string
    readonly windowId: string | null
    readonly waivedFeeBps: number | null
    readonly price: bigint
    readonly assetCode: string
    readonly correlationId: string
  },
): Promise<EngagementGrant | null> {
  if (!input.windowId || !input.waivedFeeBps) return null
  if (input.assetCode !== ENGAGEMENT_ASSET) {
    throw new EngagementError(
      'subsidy_asset_mismatch',
      `listing ${input.listingId} is priced in ${input.assetCode}, and the engagement programme ` +
        `is denominated in ${ENGAGEMENT_ASSET} — the waived fee cannot be funded from it`,
    )
  }
  const forgone = (input.price * BigInt(input.waivedFeeBps)) / 10_000n
  if (forgone <= 0n) return null

  return payGrant(deps, {
    windowId: input.windowId,
    grantKind: 'listing_fee_subsidy',
    listingId: input.listingId,
    amountWei: forgone,
    // The platform's OWN fee line: the seller's benefit is the fee they did not pay, so the
    // money moves from the programme to the revenue line the fee would have reached.
    beneficiary: { subject: 'platform', purpose: 'fees', type: 'revenue' },
    actor: 'service:market',
    correlationId: input.correlationId,
    description: `listing-fee subsidy for listing ${input.listingId} (${input.waivedFeeBps} bps waived)`,
  })
}
