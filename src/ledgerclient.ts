/**
 * The ledger, as this service uses it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MARKET HOLDS NO MONEY. NOT ONE UNIT, NOT FOR ONE MILLISECOND.**
 *
 * Every function in this file builds POSTINGS. Nothing in this repository has a balance column,
 * an escrow balance, or a running total, and `escrows.amount` is the size of a reference to a
 * ledger reservation rather than a store of value — see the header of `migrations.ts`.
 *
 * AD-14: "escrow is a ledger account, not a smart contract, wherever custodial settlement
 * applies. A listing reserves the seller's asset, a purchase moves reserved → escrow → buyer
 * atomically, and fees and royalties are postings in the same entry. Nothing is 'in flight'
 * without being in an account."
 *
 * **A SALE IS ONE ENTRY.** `settlePostings` returns every leg — the buyer's payment, the seller's
 * proceeds, the platform's fee, each royalty recipient's share, and the item itself — as a single
 * balanced entry. It is tempting to post the sale and then post the royalty, because `royalty_paid`
 * is its own entry kind in the vocabulary. Do not: two entries means a state in which the sale
 * committed and the royalty did not, which is a creator who was not paid for a sale that
 * definitely happened, discoverable only by reconciliation and only in aggregate. One entry
 * cannot half-commit.
 *
 * Every key below is **derived**, never random. `market:settle:<listingId>` in particular is
 * derived from the listing rather than from the order, because the order id does not exist until
 * the transaction that would have created it — so a retry after a lost response would generate a
 * second key and pay twice. The listing id is known before the money moves, which is the only
 * property that makes the key safe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type {
  AccountPurpose,
  AccountType,
  Actor,
  EntryKind,
  LedgerAssetCode,
} from '@cloudsforge/contracts-money'
import type { SaleSplit } from './money.ts'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call the ledger.
 *
 * `ledger:post` alone, and that is the whole of it: this client has exactly one method and it
 * posts to `POST /entries`, gated on `POST_SCOPE = 'ledger:post'` (`ledger/src/server.ts,347`).
 * Market's escrow is a POSTING to an escrow account, never a ledger reservation — the header
 * above says so — so `ledger:reserve` would be authority this service has no call site for, and
 * `ledger:read` likewise: market asks the ledger nothing.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post'])

/**
 * The ledger refused on the state of the world — most often an insufficient balance, which is a
 * 402 to the customer and not an error at all. Never retried with the same request.
 */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

/**
 * Re-exported from contracts rather than restated here.
 *
 * These two were a hand-kept copy of the contracts unions, identical on the day they were written
 * and silently divergent afterwards. When micro-org#495 added the `inventory` purpose for the
 * exchange desk, the copy did not gain it, and `engagement.ts` — which builds its account ref from
 * `engagementAccount()` in contracts — stopped typechecking against a local union that no longer
 * described the same set. The failure surfaced at the release build for the whole estate, in a
 * service that has nothing to do with the desk.
 *
 * A duplicated union does not warn when it falls behind; it just narrows. Sourcing them means the
 * next member added in contracts arrives here too, and a member this service genuinely cannot
 * handle becomes a visible switch-exhaustiveness error instead of an assignability one.
 */
export type { AccountPurpose, AccountType }

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  /** Set only on a correction. 04-domain-model §2.2 invariant 3: never an edit. */
  readonly reversesEntryId?: string
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
}

/* ------------------------------------------------------------------ account shorthands */

/** A user's, community's or organisation's own money. Always a liability: we owe it to them. */
function holder(
  subject: string,
  assetCode: LedgerAssetCode,
  purpose: AccountPurpose,
): AccountRef {
  return { subject, assetCode, purpose, type: 'liability' }
}

/** The platform's revenue line. The only non-liability account this service ever posts to. */
function platformFees(assetCode: LedgerAssetCode): AccountRef {
  return { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' }
}

/* ------------------------------------------------------------------ reservations */

export interface ReservationInput {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
}

/**
 * Move `available` → `reserved`. The posting pair behind every escrow row in this service.
 *
 * The available/reserved split is two ACCOUNTS, not two columns (04-domain-model §2.1), which is
 * what makes a reservation auditable, reversible and impossible to lose track of. A column would
 * make "how much of this user's balance is spoken for" a number nobody can reconstruct after the
 * fact.
 */
export function reservePostings(input: ReservationInput): readonly PostingRequest[] {
  return [
    {
      account: holder(input.subject, input.assetCode, 'available'),
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: holder(input.subject, input.assetCode, 'reserved'),
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

/** The mirror: `reserved` back to `available`, on cancellation, expiry or being outbid. */
export function releasePostings(input: ReservationInput): readonly PostingRequest[] {
  return [
    {
      account: holder(input.subject, input.assetCode, 'reserved'),
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: holder(input.subject, input.assetCode, 'available'),
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

/* ------------------------------------------------------------------ the sale */

export interface SettlementInput {
  readonly buyerSubject: string
  readonly sellerSubject: string
  /** What the price is denominated in — `SHARD`, `EMBER`, `USD`. */
  readonly assetCode: LedgerAssetCode
  /** What the ITEM is, as the ledger knows it — `TOKEN:<urn>`. Never the same account as above. */
  readonly itemAssetCode: LedgerAssetCode
  readonly quantity: bigint
  readonly split: SaleSplit
  /**
   * Where the seller's proceeds land.
   *
   * `payout_due` when the listing carries a dispute window: the money is the seller's, and it is
   * not yet spendable, and both of those facts are true at once — which is exactly what a separate
   * account purpose is for. `available` when there is no window.
   */
  readonly proceedsPurpose: 'available' | 'payout_due'
}

/**
 * Every leg of a custodial sale, as one balanced entry.
 *
 * Balanced per asset code, by construction:
 *
 *   `assetCode`      debit  buyer.reserved      = price
 *                    credit seller.<proceeds>   = sellerProceeds  ⎫
 *                    credit platform.fees       = platformFee     ⎬ = price, because money.ts
 *                    credit royalty_i.available = share_i         ⎭   defines proceeds as the
 *                                                                     remainder. See its header.
 *   `itemAssetCode`  debit  seller.reserved     = quantity
 *                    credit buyer.available     = quantity
 *
 * The buyer is debited from `reserved` rather than from `available` because their funds were
 * escrowed when they bid or offered, and a fixed-price purchase escrows them a moment earlier in
 * the same transaction. Debiting `available` here would be a second charge for money already set
 * aside — and worse, it would let a bidder spend their escrowed funds elsewhere and still win.
 */
export function settlePostings(input: SettlementInput): readonly PostingRequest[] {
  const postings: PostingRequest[] = []
  let sequence = 0
  const push = (account: AccountRef, direction: 'debit' | 'credit', amount: bigint, assetCode: LedgerAssetCode): void => {
    // A zero-amount posting is not an error in this service's arithmetic — a 0-bps royalty
    // recipient produces one — but the ledger has no use for it and it makes an entry harder to
    // read. Dropped here rather than in each caller.
    if (amount === 0n) return
    postings.push({ account, direction, amount, assetCode, sequence: sequence++ })
  }

  push(holder(input.buyerSubject, input.assetCode, 'reserved'), 'debit', input.split.price, input.assetCode)
  push(
    holder(input.sellerSubject, input.assetCode, input.proceedsPurpose),
    'credit',
    input.split.sellerProceeds,
    input.assetCode,
  )
  push(platformFees(input.assetCode), 'credit', input.split.platformFee, input.assetCode)
  for (const share of input.split.royaltyShares) {
    push(holder(share.subject, input.assetCode, 'available'), 'credit', share.amount, input.assetCode)
  }

  push(holder(input.sellerSubject, input.itemAssetCode, 'reserved'), 'debit', input.quantity, input.itemAssetCode)
  push(holder(input.buyerSubject, input.itemAssetCode, 'available'), 'credit', input.quantity, input.itemAssetCode)

  return postings
}

/**
 * Release a seller's proceeds from `payout_due` to `available`, once the dispute window has run.
 *
 * A movement between two of the seller's own accounts, so nobody's total changes and no fee is
 * taken twice. The fee and the royalty were settled at sale time and are not revisited here.
 */
export function payoutPostings(input: ReservationInput): readonly PostingRequest[] {
  return [
    {
      account: holder(input.subject, input.assetCode, 'payout_due'),
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: holder(input.subject, input.assetCode, 'available'),
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

export interface RefundInput {
  readonly buyerSubject: string
  readonly sellerSubject: string
  readonly assetCode: LedgerAssetCode
  readonly split: SaleSplit
}

/**
 * Undo a settled sale, when a dispute is resolved in the buyer's favour.
 *
 * Posted as its own entry with `reversesEntryId` set, never as an edit of the original —
 * 04-domain-model §2.2 invariant 3, "a correction is a new entry ... never an edit". The postings
 * are the mirror of `settlePostings`' money legs.
 *
 * **The platform's fee is refunded too, and the royalty recipients give theirs back.** It is
 * tempting to keep the fee: the platform did the work. But a refund that returns the buyer's full
 * price while only clawing back part of it does not balance, and making it balance by absorbing
 * the difference into an expense account turns every dispute into a silent write-off nobody
 * approved. If the platform wants to keep a fee on a refunded sale, that is a SECOND entry with
 * its own kind and its own approval, not a hole in this one.
 *
 * The item legs are deliberately absent: a refund returns the money, and returning the item is a
 * separate question with a separate answer per asset kind — a game item may have been consumed, a
 * token may have been transferred on. `refundEntry` therefore restores the buyer's funds and the
 * operator decides about the item, which is what the dispute record is for.
 */
export function refundPostings(input: RefundInput): readonly PostingRequest[] {
  const postings: PostingRequest[] = []
  let sequence = 0
  const push = (account: AccountRef, direction: 'debit' | 'credit', amount: bigint): void => {
    if (amount === 0n) return
    postings.push({ account, direction, amount, assetCode: input.assetCode, sequence: sequence++ })
  }

  push(holder(input.sellerSubject, input.assetCode, 'payout_due'), 'debit', input.split.sellerProceeds)
  push(platformFees(input.assetCode), 'debit', input.split.platformFee)
  for (const share of input.split.royaltyShares) {
    push(holder(share.subject, input.assetCode, 'available'), 'debit', share.amount)
  }
  push(holder(input.buyerSubject, input.assetCode, 'available'), 'credit', input.split.price)

  return postings
}

/* ------------------------------------------------------------------ derived keys */

/**
 * The key one operation is posted under, for ever.
 *
 * All derived from an id that exists BEFORE the money moves. A key derived from a row the
 * transaction is about to create does not survive a retry, because the retry generates a
 * different id and therefore a different key — and pays a second time.
 */
export const idempotencyKeys = {
  reserveListing: (listingId: string): string => `market:escrow:listing:${listingId}`,
  reserveBid: (bidId: string): string => `market:escrow:bid:${bidId}`,
  reserveOffer: (offerId: string): string => `market:escrow:offer:${offerId}`,
  release: (escrowId: string): string => `market:release:${escrowId}`,
  /** Derived from the LISTING. One listing settles once — `orders_listing_uniq` says the same. */
  settle: (listingId: string): string => `market:settle:${listingId}`,
  payout: (orderId: string): string => `market:payout:${orderId}`,
  refund: (disputeId: string): string => `market:refund:${disputeId}`,
} as const

/* ------------------------------------------------------------------ the http client */

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      try {
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all,
        // because `HttpClient` attempts a non-idempotent method exactly once without one.
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.reversesEntryId !== undefined
              ? { reversesEntryId: request.reversesEntryId }
              : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
              // 754 double, and a large amount does not survive one — it does not fail either, it
              // comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        })
        return {
          id: body.entry.id,
          kind: body.entry.kind,
          recordedAt: body.entry.recordedAt,
          replayed: body.replayed,
        }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the
 * entry posted, and the only safe response is to retry with the same key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
