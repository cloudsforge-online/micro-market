/**
 * The indexer, as this service uses it.
 *
 * Two jobs, and they have DIFFERENT failure semantics, which is why they are two methods rather
 * than one client with one deadline:
 *
 *   `tokenFacts`     **Soft.** Feeds the computed risk indicators on a listing page. An indexer
 *                    outage means a listing renders without its indicators, which is a worse page
 *                    and not a wrong one. Refusing to show the listing at all would take the
 *                    marketplace offline for somebody else's incident.
 *
 *   `escrowStatus`   **HARD, for on-chain settlement only.** This is the platform asking the
 *                    chain whether the item is really in escrow. Guessing here would let a seller
 *                    open an on-chain listing against an item they still hold and can still
 *                    transfer, which is a marketplace that sells things that are not for sale.
 *
 * 07-dependency-map says exactly this: "soft for indicators, hard for on-chain settlement".
 *
 * **Only one of the two is a route today.** `escrowStatus` calls
 * `GET /transactions/:chain/:network/:hash/confirmations`, which `micro-indexer` now serves.
 * `tokenFacts` does not, and will not: the capability is keyed by a `micro-mint` item URN the
 * indexer has no registry for, and three of its eight fields need complete holder history or a
 * custody fact about a private key. The long comment on that method is the argument — including
 * the part of it that has since become false, kept and marked rather than quietly deleted. It is a
 * gap in the estate's design rather than a gap in the indexer's build, and it fails as an outage
 * until something owns it.
 *
 * **Nothing here signs anything, and nothing here reads a chain directly.** AD-07: incoming
 * on-chain reality is the indexer's, and market is a consumer of its read model. A service that
 * probed an RPC endpoint itself would be a second, disagreeing source of truth about the chain.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

export const INDEXER_SCOPES: readonly string[] = Object.freeze(['indexer:read'])

/** The indexer could not be reached. Soft callers degrade; the on-chain path refuses. */
export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexerUnavailableError'
  }
}

/**
 * What the chain says about a token, as facts.
 *
 * Deliberately not a score, not a rating, and not a colour. See `risk.ts`.
 */
export interface TokenFacts {
  readonly contractAddress: string
  readonly chain: string
  readonly network: string
  /** True when somebody can still mint more of this. The single most consequential fact here. */
  readonly mintAuthorityPresent: boolean
  readonly ownershipRenounced: boolean
  readonly holderCount: number
  /** The largest single holder's share, in basis points of supply. */
  readonly topHolderBps: number
  readonly firstSeenAt: string | null
  /** True when the deploying wallet's private key has been exported out of custody. */
  readonly deployerWalletExported: boolean
}

/**
 * What the indexer says about the transaction a seller claims funded their escrow.
 *
 * **`known` is the field that ended the defect.** `micro-indexer` now answers 404
 * `transaction_not_found` for a transaction it has never seen and 200 for one it has, so
 * "I have no record of this" and "this has not reached its depth yet" are finally two different
 * answers instead of the single `{confirmed: false}` that made every activation fail with the
 * wrong reason.
 *
 * Every other field is `null` rather than a number when there is nothing honest to put in it —
 * never seen, still pending, or reorged off the chain. A zero here would read as a real depth of
 * zero, and this estate's rule is that a missing value is missing.
 */
export interface EscrowStatus {
  /** False when the indexer has no record of the transaction at all. */
  readonly known: boolean
  /** The only field to act on. False whenever the answer is anything other than a clear yes. */
  readonly confirmed: boolean
  /** Depth on the canonical chain. Null when there is no canonical chain to measure against. */
  readonly confirmations: number | null
  /** The depth this coin requires, from `contracts-chain` via the indexer. Never hardcoded here. */
  readonly requiredConfirmations: number | null
  /** The chain's word: `success`, `failed`, `pending`, `dropped` or `orphaned`. */
  readonly status: string | null
  /** True while the block holding it is still on the canonical chain. */
  readonly canonical: boolean
  /** True when the indexer has stopped vouching for this chain after a reorg past its alarm depth. */
  readonly halted: boolean
}

export interface IndexerClient {
  /** Soft. Returns null when the indexer has never seen this item. */
  tokenFacts(itemUrn: string): Promise<TokenFacts | null>
  /** Hard. Throws `IndexerUnavailableError` rather than guessing. */
  escrowStatus(chain: string, network: string, txHash: string): Promise<EscrowStatus>
}

/** The 200 body of `GET /transactions/:chain/:network/:hash/confirmations`. */
interface ConfirmationBody {
  readonly confirmed?: unknown
  readonly confirmations?: unknown
  readonly requiredConfirmations?: unknown
  readonly status?: unknown
  readonly canonical?: unknown
  readonly halted?: unknown
}

/**
 * The `error.code` inside an indexer failure, or null if there is not one to read.
 *
 * **This is what separates an answer from an outage, and it is why the status alone will not do.**
 * `transaction_not_found` is the indexer saying it has never seen the transaction, which is a
 * fact. `not_found` is the indexer saying it does not serve the path we asked for, which is our
 * own misconfiguration and tells us nothing about any chain. A body that cannot be read is treated
 * as the second: an unreadable failure must never be promoted into a confident negative.
 */
function codeOf(err: HttpError): string | null {
  try {
    const parsed: unknown = JSON.parse(err.body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const error: unknown = (parsed as Record<string, unknown>)['error']
    if (typeof error !== 'object' || error === null) return null
    const code: unknown = (error as Record<string, unknown>)['code']
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

const number = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export interface IndexerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpIndexerClient(options: IndexerClientOptions): IndexerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async tokenFacts(itemUrn) {
      try {
        const body = await client.request<{ facts: TokenFacts | null }>(
          `/v1/tokens/${encodeURIComponent(itemUrn)}/facts`,
          { method: 'GET' },
        )
        return body.facts ?? null
      } catch (err) {
        // ══════════════════════════════════════════════════════════════════════════════════════
        // STILL AN OUTAGE, AND STILL NOT A ROUTE. This is the one of the three capabilities in
        // 18-build-status §3.3j that was NOT built, and the reason is not "not yet":
        //
        //   * It is keyed by an ITEM URN — `cf:mint:token:0192` — which is a `micro-mint` name.
        //     The indexer holds no registry mapping a mint item to a chain contract address, and
        //     putting one there would make the chain's recorder the owner of a fact mint owns.
        //   * Three of `TokenFacts`' eight fields are not derivable from anything any service in
        //     the estate holds. `topHolderBps` and `holderCount` need COMPLETE holder history —
        //     every transfer from genesis — and the follower cold-starts at `tip − 2 × depth`, so
        //     it has never had it and a number computed from what it has would be confidently
        //     wrong. `deployerWalletExported` is a statement about a private key and belongs to
        //     `custody`, not to any chain.
        //   * Even `firstSeenAt` would be a plausible number and a wrong one: the follower
        //     cold-starts at `tip − 2 × depth`, so "first seen" means first seen by that indexer,
        //     and `risk.ts`'s `recently_deployed` indicator would fire on tokens years old.
        //
        // **A correction. The transport argument this comment used to make is dead, and the
        // refusal never rested on it.** It said `mintAuthorityPresent` and `ownershipRenounced`
        // are contract state behind "an `eth_call` this service deliberately never makes". The
        // indexer makes one now: `GET /tokens/:chain/:network/:address` reads exactly those two
        // fields by `eth_call`, at the indexer's own canonical head and only after proving the
        // provider still serves that head (`indexer/src/server.ts:159`,
        // `indexer/src/tokenstate.ts:207-215`). So two of the eight fields became available — keyed
        // by CONTRACT ADDRESS, which is the first bullet, not by the item URN this method is given.
        //
        // So the indicators wait on a token registry, not on a route. Until then the honest
        // report is "we could not check", never "there is nothing to find".
        throw new IndexerUnavailableError(
          err instanceof HttpError && err.status === 404
            ? 'token facts are not a capability any service in the estate serves; see this comment'
            : err instanceof Error
              ? err.message
              : String(err),
        )
      }
    },

    async escrowStatus(chain, network, txHash) {
      // The indexer's own convention: the RESOURCE first, then `:chain/:network`, then the key.
      // Not a `/v1` prefix invented here — the gateway adds and strips that publicly, and it is
      // served either way (`indexer/src/server.ts:134`, `PREFIXES = ['/v1', '']`).
      //
      // ONE template literal, WHOLE, with every segment written out. `indexerclient.test.ts` scans
      // this file for the paths it requests and compares them against the indexer's route patterns
      // segment by segment, so a path split across a `+` reaches that scan as a fragment, and a
      // `${scope}` helper standing for two segments reaches it as one segment — either way the
      // checker is judging a shape it cannot see. That is worse than a wrong path, because nothing
      // goes red. The `scope` variable that used to be here was exactly that hazard.
      const path = `/transactions/${encodeURIComponent(chain)}/${encodeURIComponent(network)}/${encodeURIComponent(txHash)}/confirmations`
      let body: ConfirmationBody
      try {
        body = await client.request<ConfirmationBody>(path, { method: 'GET' })
      } catch (err) {
        // THE 404 BRANCH ONCE RETURNED `{confirmed: false}` AND THAT WAS A PERMANENT LIE — the
        // route did not exist, so every call 404'd and `server.ts` reported "the on-chain escrow
        // is not confirmed yet" for every activation on every chain.
        //
        // It is served now, and a 404 splits in two. `transaction_not_found` is the indexer
        // saying it has no record of this transaction: a real answer, and the seller needs to
        // hear it, because it usually means they pasted the wrong hash or picked the wrong
        // network. Any other 404 is a path this service asked for and the indexer does not serve,
        // which is our own misconfiguration and says nothing about the chain — so it stays an
        // outage, exactly as before.
        if (err instanceof HttpError && err.status === 404 && codeOf(err) === 'transaction_not_found') {
          return {
            known: false,
            confirmed: false,
            confirmations: null,
            requiredConfirmations: null,
            status: null,
            canonical: false,
            halted: false,
          }
        }
        throw new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
      }

      // An unreadable 200 is not an answer. If the field this whole call exists for is not a
      // boolean, the response shape has changed under us, and quietly reading that as "not
      // confirmed" is how the original defect worked — a wrong reason a seller retries against for
      // ever. It is an outage, and it says so.
      if (typeof body.confirmed !== 'boolean') {
        throw new IndexerUnavailableError(
          `the indexer answered ${path} without a boolean 'confirmed'`,
        )
      }
      return {
        known: true,
        confirmed: body.confirmed,
        confirmations: number(body.confirmations),
        requiredConfirmations: number(body.requiredConfirmations),
        status: text(body.status),
        canonical: body.canonical === true,
        halted: body.halted === true,
      }
    },
  }
}
