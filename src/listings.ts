/**
 * Collections, verification, and the listing lifecycle.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A LISTING THAT CANNOT RESERVE CANNOT BE LISTED.** 04-domain-model §6.1.
 *
 * `createListing` writes a `draft`. Drafts hold nothing and are visible to nobody but their
 * seller. `activateListing` is the only path to `active`, and it does two things in one
 * transaction: it reserves the item in the ledger, and it writes the escrow id onto the listing.
 * `listings_active_is_escrowed` makes the second half unskippable — an `active` row with no
 * escrow cannot commit.
 *
 * That is the whole anti-double-sale argument, and it is why `status` starts at `draft` rather
 * than at `active`. A model where a listing is born active and is reserved "shortly afterwards"
 * has a window, however small, in which the same item backs two listings; and a window that small
 * is one that is never reproduced in testing and always reached in production.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Royalties are snapshotted, not joined
 *
 * `createListing` copies the collection's royalty split onto `listing_royalties`. It would be less
 * code to join `collection_royalties` at settlement time. It would also mean a collection owner
 * could edit the split while an auction was running and be paid under terms no bidder ever saw.
 * That is not a query bug, it is a way to take money, and the schema comment on the table says so.
 *
 * ## The platform fee and the dispute window are snapshotted for the same reason
 *
 * Both are read from the environment when the listing is created and stored on the row. Reading
 * them at settlement would mean a deploy that changes `MARKET_PLATFORM_FEE_BPS` retroactively
 * changes the terms of every listing already on the market.
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import { emitOn, type Db, type Emit, type Tx } from './outbox.ts'
import { holdEscrow, releaseEscrow, type EscrowKind, type ReleaseDeps } from './escrow.ts'
import type { RoyaltyRecipient } from './money.ts'
import { idempotencyKeys, type LedgerClient } from './ledgerclient.ts'

/**
 * Basis points as a NUMBER.
 *
 * `money.ts` exports the same constant as a `bigint`, because there it multiplies amounts and an
 * amount is never a number. Here it is only ever compared against a sum of `bps` columns, which
 * are `integer` and genuinely small. Two constants rather than a cast at every use site: mixing a
 * bigint and a number in a comparison is a TypeScript error, which is exactly the guard wanted.
 */
const BPS_TOTAL = 10_000

export const LISTED_TOPIC = 'market.listing.listed'
export const SOLD_TOPIC = 'market.listing.sold'
export const REMOVED_TOPIC = 'market.listing.removed'

export type AssetKind =
  | 'token'
  | 'game_item'
  | 'entitlement'
  | 'membership'
  | 'brand_asset'
  | 'collectible'
export type PricingMode = 'fixed' | 'auction' | 'offers_only'
export type SettlementMode = 'custodial' | 'onchain'
export type ListingStatus = 'draft' | 'active' | 'settling' | 'sold' | 'cancelled' | 'expired'
export type VerificationLevel = 'unverified' | 'claimed' | 'verified' | 'flagged'

export class ListingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListingError'
  }
}

/** The listing's state refuses this. 409, not 400: the request was well formed. */
export class ListingStateError extends ListingError {
  constructor(message: string) {
    super(message)
    this.name = 'ListingStateError'
  }
}

/** A moderation case or a dispute has frozen this listing. 409, and it says which. */
export class FrozenError extends ListingError {
  constructor(message = 'this listing is frozen by an open moderation case or dispute') {
    super(message)
    this.name = 'FrozenError'
  }
}

/* ------------------------------------------------------------------ collections */

export interface Collection {
  readonly id: string
  readonly ownerSubject: string
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly royalties: readonly RoyaltyRecipient[]
}

interface CollectionRow {
  readonly id: string
  readonly owner_subject: string
  readonly slug: string
  readonly name: string
  readonly description: string
}

export async function createCollection(
  sql: Db,
  input: {
    readonly ownerSubject: string
    readonly slug: string
    readonly name: string
    readonly description?: string
    readonly royalties?: readonly RoyaltyRecipient[]
  },
): Promise<Collection> {
  assertRoyalties(input.royalties ?? [])
  const outcome = await sql.begin(async (tx) => {
    const rows = await tx<CollectionRow[]>`
      insert into collections (owner_subject, slug, name, description)
      values (${input.ownerSubject}, ${input.slug}, ${input.name}, ${input.description ?? ''})
      returning id, owner_subject, slug, name, description
    `
    const row = rows[0]
    if (!row) throw new ListingError('the collection was not written')
    for (const recipient of input.royalties ?? []) {
      await tx`
        insert into collection_royalties (collection_id, subject, bps)
        values (${row.id}, ${recipient.subject}, ${recipient.bps})
      `
    }
    return { value: { row, royalties: input.royalties ?? [] } }
  })
  return {
    id: outcome.value.row.id,
    ownerSubject: outcome.value.row.owner_subject,
    slug: outcome.value.row.slug,
    name: outcome.value.row.name,
    description: outcome.value.row.description,
    royalties: outcome.value.royalties,
  }
}

export async function findCollection(sql: Db | Tx, id: string): Promise<Collection | null> {
  const rows = await sql<CollectionRow[]>`
    select id, owner_subject, slug, name, description from collections where id = ${id}
  `
  const row = rows[0]
  if (!row) return null
  return { ...toCollection(row), royalties: await collectionRoyalties(sql, id) }
}

export async function listCollections(sql: Db, ownerSubject?: string): Promise<readonly Collection[]> {
  const rows = ownerSubject
    ? await sql<CollectionRow[]>`
        select id, owner_subject, slug, name, description from collections
         where owner_subject = ${ownerSubject} order by created_at desc limit 200
      `
    : await sql<CollectionRow[]>`
        select id, owner_subject, slug, name, description from collections
         order by created_at desc limit 200
      `
  return Promise.all(
    rows.map(async (row) => ({ ...toCollection(row), royalties: await collectionRoyalties(sql, row.id) })),
  )
}

function toCollection(row: CollectionRow): Omit<Collection, 'royalties'> {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    slug: row.slug,
    name: row.name,
    description: row.description,
  }
}

async function collectionRoyalties(
  sql: Db | Tx,
  collectionId: string,
): Promise<readonly RoyaltyRecipient[]> {
  const rows = await sql<{ subject: string; bps: number }[]>`
    select subject, bps from collection_royalties
     where collection_id = ${collectionId} order by subject
  `
  return rows.map((row) => ({ subject: row.subject, bps: row.bps }))
}

/**
 * A royalty split's shares are basis points OF THE ROYALTY, and they must sum to exactly 10,000.
 *
 * Not "at most". A split summing to 9,000 would silently hand the missing tenth to whoever
 * `allocate`'s largest-remainder pass happened to favour — a real payment, to a real recipient,
 * that nobody agreed to. Refusing here is the difference between a configuration error and a
 * quiet transfer.
 */
function assertRoyalties(recipients: readonly RoyaltyRecipient[]): void {
  if (recipients.length === 0) return
  const total = recipients.reduce((acc, recipient) => acc + recipient.bps, 0)
  if (total !== BPS_TOTAL) {
    throw new ListingError(
      `royalty shares must sum to exactly ${BPS_TOTAL} basis points, got ${total}`,
    )
  }
  const seen = new Set<string>()
  for (const recipient of recipients) {
    if (seen.has(recipient.subject)) {
      throw new ListingError(`${recipient.subject} appears twice in the royalty split`)
    }
    seen.add(recipient.subject)
  }
}

/* ------------------------------------------------------------------ verification */

export interface Verification {
  readonly subjectUrn: string
  readonly level: VerificationLevel
  readonly evidence: Record<string, unknown>
  readonly reviewedBy: string | null
  readonly reviewedAt: Date | null
}

interface VerificationRow {
  readonly subject_urn: string
  readonly level: VerificationLevel
  readonly evidence: Record<string, unknown>
  readonly reviewed_by: string | null
  readonly reviewed_at: Date | null
}

export async function setVerification(
  sql: Db,
  input: {
    readonly subjectUrn: string
    readonly level: VerificationLevel
    readonly evidence?: Record<string, unknown>
    readonly reviewedBy: string
  },
): Promise<Verification> {
  const rows = await sql<VerificationRow[]>`
    insert into verifications (subject_urn, level, evidence, reviewed_by, reviewed_at)
    values (${input.subjectUrn}, ${input.level},
            ${sql.json((input.evidence ?? {}) as Record<string, never>)},
            ${input.reviewedBy}, now())
    on conflict (subject_urn) do update
       set level = excluded.level, evidence = excluded.evidence,
           reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
           updated_at = now()
    returning subject_urn, level, evidence, reviewed_by, reviewed_at
  `
  const row = rows[0]
  if (!row) throw new ListingError('the verification was not written')
  return {
    subjectUrn: row.subject_urn,
    level: row.level,
    evidence: row.evidence,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  }
}

export async function findVerification(sql: Db, subjectUrn: string): Promise<Verification> {
  const rows = await sql<VerificationRow[]>`
    select subject_urn, level, evidence, reviewed_by, reviewed_at
      from verifications where subject_urn = ${subjectUrn}
  `
  const row = rows[0]
  // Absence is `unverified`, not 404. "We have never looked at this" is a real answer and the one
  // a buyer needs; a 404 would make a client show nothing at all, which reads as "verified".
  if (!row) {
    return { subjectUrn, level: 'unverified', evidence: {}, reviewedBy: null, reviewedAt: null }
  }
  return {
    subjectUrn: row.subject_urn,
    level: row.level,
    evidence: row.evidence,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  }
}

/* ------------------------------------------------------------------ listings */

export interface Listing {
  readonly id: string
  readonly sellerSubject: string
  readonly sellerWalletId: string | null
  readonly collectionId: string | null
  readonly assetKind: AssetKind
  readonly itemUrn: string
  readonly quantity: bigint
  readonly itemAssetCode: LedgerAssetCode
  readonly pricingMode: PricingMode
  readonly price: bigint | null
  readonly reservePrice: bigint | null
  readonly assetCode: LedgerAssetCode
  readonly settlementMode: SettlementMode
  readonly royaltyBps: number
  readonly platformFeeBps: number
  /** 21 §5: the window that waived this listing's fee, and the rate it waived. */
  readonly engagementWindowId: string | null
  readonly engagementWaivedFeeBps: number | null
  readonly auctionEndsAt: Date | null
  readonly expiresAt: Date | null
  readonly status: ListingStatus
  readonly frozen: boolean
  readonly escrowId: string | null
  readonly onchainEscrowTx: string | null
  readonly disputeWindowMs: number
  readonly createdAt: Date
  readonly activatedAt: Date | null
  readonly endedAt: Date | null
}

interface ListingRow {
  readonly id: string
  readonly seller_subject: string
  readonly seller_wallet_id: string | null
  readonly collection_id: string | null
  readonly asset_kind: AssetKind
  readonly item_urn: string
  readonly quantity: string
  readonly item_asset_code: string
  readonly pricing_mode: PricingMode
  readonly price: string | null
  readonly reserve_price: string | null
  readonly asset_code: string
  readonly settlement_mode: SettlementMode
  readonly royalty_bps: number
  readonly platform_fee_bps: number
  readonly engagement_window_id: string | null
  readonly engagement_waived_fee_bps: number | null
  readonly auction_ends_at: Date | null
  readonly expires_at: Date | null
  readonly status: ListingStatus
  readonly frozen: boolean
  readonly escrow_id: string | null
  readonly onchain_escrow_tx: string | null
  readonly dispute_window_ms: string
  readonly created_at: Date
  readonly activated_at: Date | null
  readonly ended_at: Date | null
}

const LISTING_COLUMNS = `id, seller_subject, seller_wallet_id, collection_id, asset_kind, item_urn,
  quantity::text as quantity, item_asset_code, pricing_mode, price::text as price,
  reserve_price::text as reserve_price, asset_code, settlement_mode, royalty_bps, platform_fee_bps,
  engagement_window_id, engagement_waived_fee_bps,
  auction_ends_at, expires_at, status, frozen, escrow_id, onchain_escrow_tx,
  dispute_window_ms::text as dispute_window_ms, created_at, activated_at, ended_at`

export function toListing(row: ListingRow): Listing {
  return {
    id: row.id,
    sellerSubject: row.seller_subject,
    sellerWalletId: row.seller_wallet_id,
    collectionId: row.collection_id,
    assetKind: row.asset_kind,
    itemUrn: row.item_urn,
    quantity: BigInt(row.quantity),
    itemAssetCode: row.item_asset_code as LedgerAssetCode,
    pricingMode: row.pricing_mode,
    price: row.price === null ? null : BigInt(row.price),
    reservePrice: row.reserve_price === null ? null : BigInt(row.reserve_price),
    assetCode: row.asset_code as LedgerAssetCode,
    settlementMode: row.settlement_mode,
    royaltyBps: row.royalty_bps,
    platformFeeBps: row.platform_fee_bps,
    engagementWindowId: row.engagement_window_id,
    engagementWaivedFeeBps: row.engagement_waived_fee_bps,
    auctionEndsAt: row.auction_ends_at,
    expiresAt: row.expires_at,
    status: row.status,
    frozen: row.frozen,
    escrowId: row.escrow_id,
    onchainEscrowTx: row.onchain_escrow_tx,
    // A duration in milliseconds, so `Number` is exact up to 285,000 years. Unlike an amount,
    // this is genuinely not money and does not need to be a bigint.
    disputeWindowMs: Number(row.dispute_window_ms),
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    endedAt: row.ended_at,
  }
}

export interface CreateListingInput {
  readonly sellerSubject: string
  readonly sellerWalletId?: string | null
  readonly collectionId?: string | null
  readonly assetKind: AssetKind
  readonly itemUrn: string
  readonly quantity: bigint
  readonly itemAssetCode: LedgerAssetCode
  readonly pricingMode: PricingMode
  readonly price?: bigint | null
  readonly reservePrice?: bigint | null
  readonly assetCode: LedgerAssetCode
  readonly settlementMode: SettlementMode
  readonly royaltyBps: number
  /** From the environment, snapshotted. See the file header. */
  readonly platformFeeBps: number
  /**
   * The zero-fee window this listing was created inside, and the rate it waived — docs/ecosystem
   * 21 §5. Both or neither (`listings_waiver_is_complete`); when present `platformFeeBps` is 0
   * (`listings_waived_charges_nothing`). The waived RATE is kept because the subsidy is sized
   * from it at settlement, by which time `platform_fee_bps` is 0 and the original is gone.
   */
  readonly engagementWindowId?: string | null
  readonly engagementWaivedFeeBps?: number | null
  readonly disputeWindowMs: number
  readonly auctionEndsAt?: Date | null
  readonly expiresAt?: Date | null
  /** Overrides the collection's split. Must still sum to exactly 10,000 bps. */
  readonly royaltyRecipients?: readonly RoyaltyRecipient[]
  readonly maxRoyaltyBps: number
  readonly actor: string
  readonly correlationId: string
  /**
   * The namespaced key `withIdempotentRoute` claimed for this request, stored ON the listing.
   *
   * Optional because the domain does not require it: a caller with no key gets a plain insert and
   * a NULL, which `listings_idempotency_uniq` is partial to allow. It is supplied by the route so
   * that a retry the HTTP client made on its own collides in the SCHEMA rather than relying on the
   * claim row — which, because the claim and the work commit in separate transactions, may not
   * exist even though the listing does.
   */
  readonly idempotencyKey?: string | null
}

/** The unique index that makes one key mean one listing. Any other 23505 is somebody else's bug. */
const LISTING_IDEMPOTENCY_CONSTRAINT = 'listings_idempotency_uniq'

/**
 * The listing a previous attempt under this key already created, if there is one.
 *
 * An OPTIMISATION, and nothing more. It saves the loser of a race a wasted INSERT and lets a
 * retry that arrives after the winner committed take the cheap path. It is emphatically NOT the
 * thing that prevents the duplicate: two attempts can both read `null` here before either writes,
 * and a check-then-act built on this alone would admit exactly the second listing this exists to
 * stop. `listings_idempotency_uniq` is what cannot be raced.
 */
export async function findListingByIdempotencyKey(
  sql: Db | Tx,
  idempotencyKey: string,
): Promise<Listing | null> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings where idempotency_key = ${idempotencyKey}
  `
  const row = rows[0]
  return row ? toListing(row) : null
}

/**
 * Write a `draft` listing. It holds nothing and sells nothing until `activateListing`.
 *
 * Idempotent on `input.idempotencyKey` when one is given: presenting the same key twice returns
 * the FIRST listing rather than creating a second. See migration 12 for why that belongs here
 * rather than in the route's claim row.
 */
export async function createListing(
  sql: Db,
  producer: string,
  input: CreateListingInput,
): Promise<Listing> {
  if (input.royaltyBps > input.maxRoyaltyBps) {
    throw new ListingError(
      `a royalty of ${input.royaltyBps} bps exceeds the platform maximum of ${input.maxRoyaltyBps}`,
    )
  }
  if (input.royaltyBps + input.platformFeeBps >= BPS_TOTAL) {
    throw new ListingError('the fee and the royalty would leave the seller nothing')
  }
  if (input.pricingMode === 'auction' && !input.auctionEndsAt) {
    throw new ListingError('an auction must say when it ends')
  }
  if (input.pricingMode !== 'offers_only' && (input.price ?? 0n) <= 0n) {
    throw new ListingError('a fixed-price listing and an auction both need a positive price')
  }
  if (input.settlementMode === 'onchain' && !input.sellerWalletId) {
    throw new ListingError('an on-chain listing must name the wallet that owns the item')
  }

  const key = input.idempotencyKey ?? null

  // The cheap path, and only that. A retry that arrives after the winner committed is answered
  // without touching the table. A retry that arrives BEFORE it committed reads null here and falls
  // through to the INSERT, where the index stops it — which is the case that matters and the case
  // a lookup can never handle on its own.
  if (key !== null) {
    const prior = await findListingByIdempotencyKey(sql, key)
    if (prior) return prior
  }

  let outcome: { value: Listing }
  try {
    outcome = await sql.begin(async (tx) => {
      const recipients =
        input.royaltyRecipients ??
        (input.collectionId ? await collectionRoyalties(tx, input.collectionId) : [])
      if (input.royaltyBps > 0 && recipients.length === 0) {
        throw new ListingError('a listing with a royalty must say who receives it')
      }
      assertRoyalties(recipients)

      const rows = await tx<ListingRow[]>`
        insert into listings (
          seller_subject, seller_wallet_id, collection_id, asset_kind, item_urn, quantity,
          item_asset_code, pricing_mode, price, reserve_price, asset_code, settlement_mode,
          royalty_bps, platform_fee_bps, engagement_window_id, engagement_waived_fee_bps,
          auction_ends_at, expires_at, dispute_window_ms, idempotency_key
        ) values (
          ${input.sellerSubject}, ${input.sellerWalletId ?? null}, ${input.collectionId ?? null},
          ${input.assetKind}, ${input.itemUrn}, ${input.quantity.toString()},
          ${input.itemAssetCode}, ${input.pricingMode},
          ${input.price === null || input.price === undefined ? null : input.price.toString()},
          ${input.reservePrice === null || input.reservePrice === undefined ? null : input.reservePrice.toString()},
          ${input.assetCode}, ${input.settlementMode}, ${input.royaltyBps}, ${input.platformFeeBps},
          ${input.engagementWindowId ?? null}, ${input.engagementWaivedFeeBps ?? null},
          ${input.auctionEndsAt ?? null}, ${input.expiresAt ?? null}, ${String(input.disputeWindowMs)},
          ${key}
        )
        returning ${tx.unsafe(LISTING_COLUMNS)}
      `
      const row = rows[0]
      if (!row) throw new ListingError('the listing was not written')
      for (const recipient of recipients) {
        await tx`
          insert into listing_royalties (listing_id, subject, bps)
          values (${row.id}, ${recipient.subject}, ${recipient.bps})
        `
      }
      return { value: toListing(row) }
    })
  } catch (err) {
    // OUTSIDE the transaction, deliberately. A 23505 aborts the transaction it was raised in, so
    // the re-read cannot happen on `tx` — every statement there would fail with 25P02. Catching
    // out here means the read runs on a healthy connection, and it means the read happens only
    // after the winner's transaction has ended, so what it finds is committed rather than in
    // flight. The same structure as `custody/src/keys.ts`.
    const replayed = await afterLosingTheRace(sql, key, err)
    if (replayed) return replayed
    throw err
  }
  // No outbox event for a draft. Nothing outside this service can act on a listing that is not
  // open for business, and an event for a state nobody may buy from is noise that a consumer has
  // to learn to ignore — which is how a consumer learns to ignore the one that matters.
  void producer
  return outcome.value
}

/**
 * What to do when the database refused the insert because somebody else got there first.
 *
 * ONLY `listings_idempotency_uniq` is treated this way, BY NAME. Any other 23505 on this table is
 * a different invariant being violated and is re-thrown, because swallowing it would return a
 * listing that has nothing to do with the request — the caller would believe its item is for sale
 * when what is for sale is somebody else's.
 *
 * A violation proves the winner committed, so failing to read it back afterwards is impossible. It
 * is reported loudly rather than absorbed, because the only alternative to knowing which listing
 * won is writing a second one.
 */
async function afterLosingTheRace(
  sql: Db,
  key: string | null,
  err: unknown,
): Promise<Listing | null> {
  if (key === null) return null
  const violation = err as { code?: unknown; constraint_name?: unknown }
  if (violation.code !== '23505') return null
  if (violation.constraint_name !== LISTING_IDEMPOTENCY_CONSTRAINT) return null

  const winner = await findListingByIdempotencyKey(sql, key)
  if (!winner) {
    throw new ListingError(
      `a listing lost a race to ${LISTING_IDEMPOTENCY_CONSTRAINT} but the winning row could not be read back`,
    )
  }
  return winner
}

export async function listingRoyalties(
  sql: Db | Tx,
  listingId: string,
): Promise<readonly RoyaltyRecipient[]> {
  const rows = await sql<{ subject: string; bps: number }[]>`
    select subject, bps from listing_royalties where listing_id = ${listingId} order by subject
  `
  return rows.map((row) => ({ subject: row.subject, bps: row.bps }))
}

export interface ActivateInput {
  readonly listingId: string
  readonly sellerSubject: string
  /** Required for `onchain`, refused for `custodial`. The indexer confirms it; market never signs. */
  readonly onchainEscrowTx?: string | null
  readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
  readonly correlationId: string
}

export interface ActivateDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
}

/**
 * Reserve the item and open the listing for business, in one transaction.
 *
 * The two halves cannot be separated. `listings_active_is_escrowed` refuses the second without the
 * first, and the transaction refuses the first without the second.
 */
export async function activateListing(deps: ActivateDeps, input: ActivateInput): Promise<Listing> {
  const outcome = await deps.sql.begin(async (tx) => {
    const pending: Array<Parameters<Emit>[0]> = []
    const claimed = await tx<ListingRow[]>`
      select ${tx.unsafe(LISTING_COLUMNS)} from listings where id = ${input.listingId} for update
    `
    const row = claimed[0]
    if (!row) throw new ListingStateError('no such listing')
    const listing = toListing(row)
    if (listing.sellerSubject !== input.sellerSubject) throw new ListingStateError('no such listing')
    if (listing.frozen) throw new FrozenError()
    if (listing.status !== 'draft') {
      throw new ListingStateError(`a ${listing.status} listing cannot be activated`)
    }

    let escrowId: string | null = null
    if (listing.settlementMode === 'custodial') {
      const escrow = await holdEscrow(tx, deps.ledger, {
        listingId: listing.id,
        kind: 'listing_item',
        subject: listing.sellerSubject,
        // The ITEM's asset code, not the price's. Reserving the wrong one produces an entry that
        // balances perfectly and reserves something the seller is not selling.
        assetCode: listing.itemAssetCode,
        amount: listing.quantity,
        idempotencyKey: idempotencyKeys.reserveListing(listing.id),
        actor: input.actor,
        correlationId: input.correlationId,
        description: `reserve ${listing.quantity} × ${listing.itemUrn} for listing ${listing.id}`,
      })
      escrowId = escrow.id
    } else if (!input.onchainEscrowTx) {
      throw new ListingStateError('an on-chain listing needs a confirmed escrow transaction')
    }

    const updated = await tx<ListingRow[]>`
      update listings
         set status = 'active', escrow_id = ${escrowId},
             onchain_escrow_tx = ${input.onchainEscrowTx ?? null},
             activated_at = now(), updated_at = now()
       where id = ${listing.id} and status = 'draft'
      returning ${tx.unsafe(LISTING_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new ListingStateError('the listing changed state under its own row lock')
    const active = toListing(after)

    pending.push({
      topic: LISTED_TOPIC,
      key: active.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: listingEventPayload(active),
    })
    for (const event of pending) await emitOn(tx, deps.producer, event)
    return { value: active }
  })
  return outcome.value
}

export interface EndListingDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
}

/**
 * Cancel a listing and release everything it holds — the item, and every open bid and offer.
 *
 * The releases run through `releaseEscrow`, so cancelling twice refunds once. A cancellation that
 * released the item and forgot the bids would leave every bidder's funds reserved for ever
 * against a listing that no longer exists, and nothing would ever notice: the money is still
 * theirs, it is simply unspendable.
 */
export async function cancelListing(
  deps: EndListingDeps,
  input: {
    readonly listingId: string
    readonly sellerSubject?: string
    readonly reason: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<Listing> {
  return endListing(deps, {
    listingId: input.listingId,
    to: 'cancelled',
    reason: input.reason,
    actor: input.actor,
    correlationId: input.correlationId,
    ...(input.sellerSubject !== undefined ? { sellerSubject: input.sellerSubject } : {}),
  })
}

export async function endListing(
  deps: EndListingDeps,
  input: {
    readonly listingId: string
    readonly to: 'cancelled' | 'expired'
    readonly sellerSubject?: string
    readonly reason: string
    readonly actor: `user:${string}` | `service:${string}` | `operator:${string}` | 'system'
    readonly correlationId: string
  },
): Promise<Listing> {
  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<ListingRow[]>`
      select ${tx.unsafe(LISTING_COLUMNS)} from listings where id = ${input.listingId} for update
    `
    const row = claimed[0]
    if (!row) throw new ListingStateError('no such listing')
    const listing = toListing(row)
    if (input.sellerSubject !== undefined && listing.sellerSubject !== input.sellerSubject) {
      // The same answer as "no such listing", deliberately: a distinct 403 here is an enumeration
      // oracle for who is selling what.
      throw new ListingStateError('no such listing')
    }
    if (listing.status === 'sold' || listing.status === 'settling') {
      throw new ListingStateError(`a ${listing.status} listing cannot be withdrawn`)
    }
    if (listing.status === 'cancelled' || listing.status === 'expired') return { value: listing }

    // Every held escrow on this listing, in one pass: the item, and every bid and offer that has
    // not already been released. `for update` on each is inside releaseEscrow.
    // `subject` and `kind` as well as `id`, so the event below can name the people this refunds.
    // Read here rather than re-queried after the releases, because `releaseEscrow` moves the rows
    // out of `state = 'held'` and the same select would then come back empty.
    const held = await tx<{ id: string; subject: string; kind: EscrowKind }[]>`
      select id, subject, kind
        from escrows where listing_id = ${listing.id} and state = 'held' order by held_at
    `
    const releaseDeps: ReleaseDeps = {
      ledger: deps.ledger,
      actor: input.actor,
      correlationId: input.correlationId,
    }
    for (const escrow of held) {
      await releaseEscrow(tx, releaseDeps, escrow.id)
    }
    await tx`
      update bids set status = 'lost' where listing_id = ${listing.id} and status = 'leading'
    `
    await tx`
      update offers set status = 'declined', resolved_at = now()
       where listing_id = ${listing.id} and status = 'open'
    `

    const updated = await tx<ListingRow[]>`
      update listings set status = ${input.to}, ended_at = now(), updated_at = now()
       where id = ${listing.id} and status in ('draft','active')
      returning ${tx.unsafe(LISTING_COLUMNS)}
    `
    const after = updated[0]
    if (!after) throw new ListingStateError('the listing changed state under its own row lock')
    const ended = toListing(after)

    await emitOn(tx, deps.producer, {
      topic: REMOVED_TOPIC,
      key: ended.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        ...listingEventPayload(ended),
        reason: input.reason,
        // THE PEOPLE THIS EVENT REFUNDS, none of whom is the actor.
        //
        // The fourth topic found by asking "does the envelope name only the person who acted?".
        // `listingEventPayload` carries `sellerSubject` and nothing else, and the actor is the
        // seller — or an OPERATOR, because `resolveCase` calls this to delist an upheld moderation
        // case, in which case the envelope named nobody with money in it at all.
        //
        // Every bidder and offerer on this listing has just had funds released and their
        // bid marked `lost` or their offer `declined` (the two updates above). That is exactly the
        // sentence `outbidSubject` was added to `market.bid.placed` for — "their money moved back
        // without anybody being able to say so" — and it is worse here, because being outbid is at
        // least a thing that happens inside an auction the bidder is watching, whereas a seller
        // cancelling underneath them is not.
        //
        // A LIST, and it has to be: one cancellation refunds every open bid and offer at once.
        // The estate already expects producers to carry the affected set rather than have a
        // consumer reconstruct it — `notify` holds no membership table and says so on its
        // community rules — so this is the established shape and not a new one.
        //
        // `listing_item` is excluded: that escrow's subject is the seller, who is already named as
        // `sellerSubject` and who did not have money returned so much as an item unlocked. Listing
        // them here would make the field mean two different things. Deduplicated because one
        // person may hold both a bid and an offer, and an empty array is the honest answer for a
        // draft listing or one nobody bid on — never omitted, because a consumer cannot tell an
        // absent field from an empty one and would have to guess which producer version it has.
        refundedSubjects: [
          ...new Set(
            held.filter((each) => each.kind !== 'listing_item').map((each) => each.subject),
          ),
        ],
      },
    })
    return { value: ended }
  })
  return outcome.value
}

/** The wire shape of a listing on an event. Amounts as strings; a JSON number is a double. */
export function listingEventPayload(listing: Listing): Record<string, unknown> {
  return {
    listingId: listing.id,
    sellerSubject: listing.sellerSubject,
    assetKind: listing.assetKind,
    itemUrn: listing.itemUrn,
    quantity: listing.quantity.toString(),
    pricingMode: listing.pricingMode,
    price: listing.price?.toString() ?? null,
    assetCode: listing.assetCode,
    settlementMode: listing.settlementMode,
    status: listing.status,
    collectionId: listing.collectionId,
  }
}

export async function findListing(sql: Db | Tx, id: string): Promise<Listing | null> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings where id = ${id}
  `
  const row = rows[0]
  return row ? toListing(row) : null
}

export interface ListingQuery {
  readonly status?: ListingStatus
  readonly sellerSubject?: string
  readonly collectionId?: string
  readonly assetKind?: AssetKind
  readonly limit?: number
}

export async function listListings(sql: Db, query: ListingQuery = {}): Promise<readonly Listing[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings
     where (${query.status ?? null}::text is null or status = ${query.status ?? null})
       and (${query.sellerSubject ?? null}::text is null
            or seller_subject = ${query.sellerSubject ?? null})
       and (${query.collectionId ?? null}::uuid is null
            or collection_id = ${query.collectionId ?? null})
       and (${query.assetKind ?? null}::text is null or asset_kind = ${query.assetKind ?? null})
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toListing)
}

/**
 * Active listings whose `expires_at` has passed. The expiry sweep's read.
 *
 * `now()` is the DATABASE's clock and the comparison happens in the database, so there is one
 * clock domain rather than two — the lesson from `billing/src/entitlements.ts`, where a row
 * stamped by Postgres and compared against the application's clock made a just-granted
 * entitlement read as inactive on a host with 60ms of skew. Here the same skew would expire a
 * listing early, releasing an item mid-auction.
 */
export async function expiredListings(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from listings
     where status = 'active' and expires_at is not null and expires_at <= now()
     order by expires_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}
