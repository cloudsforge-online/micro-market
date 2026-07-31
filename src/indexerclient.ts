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

export interface EscrowStatus {
  readonly confirmed: boolean
  readonly confirmations: number
  /** What the chain says is now held, so a caller can check it against what was listed. */
  readonly heldQuantity: string | null
}

export interface IndexerClient {
  /** Soft. Returns null when the indexer has never seen this item. */
  tokenFacts(itemUrn: string): Promise<TokenFacts | null>
  /** Hard. Throws `IndexerUnavailableError` rather than guessing. */
  escrowStatus(chain: string, txHash: string): Promise<EscrowStatus>
}

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
        // A 404 is an ANSWER — the indexer has never seen this item — and is distinguishable from
        // an outage. Collapsing the two would make an unknown token indistinguishable from a
        // broken indexer, and the page would show "no indicators" for both.
        if (err instanceof HttpError && err.status === 404) return null
        throw new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
      }
    },

    async escrowStatus(chain, txHash) {
      try {
        return await client.request<EscrowStatus>(
          `/v1/chains/${encodeURIComponent(chain)}/transactions/${encodeURIComponent(txHash)}/escrow`,
          { method: 'GET' },
        )
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // Not an outage: the chain has no such transaction. An unconfirmed escrow, reported as
          // one, so the listing is refused rather than opened against nothing.
          return { confirmed: false, confirmations: 0, heldQuantity: null }
        }
        throw new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
