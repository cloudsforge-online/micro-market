/**
 * Run a mutating operation at most once per key.
 *
 * **The shape is the ledger's** (`ledger/src/idempotency.ts`), which took it from
 * `repos/forge-pay/services/pay/src/store.ts`. It is not reinvented here; it is inherited,
 * because the four properties below are the whole of the correctness and each of them is easy to
 * lose while writing something that looks equivalent:
 *
 *   1. **The claim INSERT and the work share ONE transaction.** The stored response can therefore
 *      never disagree with what actually committed. A design that claims the key in its own
 *      transaction and then does the work has a window in which the key exists and the sale does
 *      not — and a retry arriving in that window is answered "already bought" for a purchase that
 *      never happened.
 *   2. **A concurrent duplicate blocks rather than races.** The second INSERT waits on the first
 *      transaction's uncommitted row; when that commits, the duplicate reads the stored response
 *      and replays it. A double-clicked Buy button can therefore never produce two orders.
 *   3. **A reused key with a different body is refused, not replayed.** Returning the first
 *      request's answer to a second, different request is worse than an error: the caller believes
 *      the thing it asked for happened.
 *   4. **A claim with no response yet is "in flight", not "done".** If the original transaction
 *      rolled back between the insert and this read, nothing committed, so the honest answer is
 *      "retry" rather than a guess.
 *
 * The key is namespaced by the calling service, for the same reason it is in the ledger: keys are
 * chosen by callers, and two callers independently choosing `buy-2026-07-31` must not collide.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AND BY THE PRINCIPAL, WHICH IS THE PART THAT WAS MISSING.**
 *
 * `originatingService` names MARKET — it is the constant `SERVICE` from `index.ts`, threaded
 * through as `deps.producer`. It says which service stored the key, never which caller chose it.
 * With only the service and the route in the namespace, every principal on the estate shared one
 * key space, and `idempotency_keys.key` is a bare `text` primary key with no actor column beside
 * it (`migrations.ts`). Two sellers presenting the same key with the same body therefore hit
 * the replay branch below, and the second was handed the FIRST one's stored response: their
 * listing was never created and they were told the id of somebody else's.
 *
 * The principal goes in the NAMESPACE rather than the fingerprint, and the two are not
 * interchangeable. In the fingerprint it would make the collision an ERROR — the row exists with a
 * different hash, so the second caller gets `IdempotencyKeyReuseError`, a 409 about a body they
 * never sent, and whoever claims a key first can deny it to everybody else. In the namespace the
 * collision cannot occur at all, which is what an idempotency key means wherever it is done
 * properly. Making it impossible beats making it an error.
 *
 * There is a second reason here specifically: the stored key is handed to `run` and persisted on
 * the listing, where `listings_idempotency_uniq` (migration 12) makes it unique. Scoping the
 * fingerprint alone would have left that string shared between two sellers, and the loser's
 * INSERT would have died on a 23505 against a row it cannot see. One change fixes both layers,
 * because the layer below is keyed on the very string this one scopes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT MAY NOT BE FINGERPRINTED, AND THE DEFECT THAT PROVES IT.**
 *
 * `correlationId` is a trace identifier and it is SUPPOSED to change on every attempt — that is
 * what makes a retry distinguishable from the original in a trace. The ledger fingerprinted the
 * whole request body, `correlationId` included, and so a caller doing exactly the right thing —
 * retrying with a fresh request id — was told its idempotency key had been reused with a
 * different payload. Every honest retry would have 409'd in production, and the caller could not
 * tell that apart from a genuine key collision. `micro-wallet` had to carry a correlation id that
 * was stable per operation rather than per attempt in order to work around it.
 *
 * The regression is documented in `ledger/src/idempotency.test.ts` and pinned here by
 * `idempotency.test.ts` in this repository, in both directions: a fresh correlation id replays, a
 * genuinely different amount still 409s.
 *
 * `idempotencyKey` itself is excluded for the same reason it is not part of the body: it is the
 * key, not the request. Including it would be harmless and confusing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto'
import type { Db, Tx } from './outbox.ts'

/** The claim exists but its transaction has not committed a response yet. The caller retries. */
export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly')
    this.name = 'IdempotencyInFlightError'
  }
}

/** The same key was presented with a different body. 409, always. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body')
    this.name = 'IdempotencyKeyReuseError'
  }
}

/** Fields that legitimately differ between attempts at the *same* operation. See the header. */
const PER_ATTEMPT_FIELDS = new Set(['correlationId', 'idempotencyKey', 'requestId'])

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so
 * two semantically identical bodies that serialised their fields in a different order would
 * fingerprint differently and a legitimate retry would be rejected as reuse. Sorting removes a
 * class of false 409 that would be maddening to diagnose from the caller's side.
 */
export function requestFingerprint(value: unknown): string {
  const subject =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => !PER_ATTEMPT_FIELDS.has(key),
          ),
        )
      : value
  return createHash('sha256').update(canonicalise(subject)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  // A bigint canonicalises to the same text as its decimal string, so a caller that sends
  // `"1000"` and one that sends the parsed amount fingerprint identically. An amount must never
  // reach `JSON.stringify` as a number: at 2^53 it stops being exact and comes back subtly wrong
  // rather than failing.
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/**
 * The delimiter between the caller and the key the caller chose.
 *
 * A pipe rather than another colon, and this is the whole of the injectivity argument. A client
 * key MAY contain colons (`SAFE_IDEMPOTENCY_KEY`, `server.ts`) and a principal is a token
 * subject, so with `:` on both sides the principal `user:a` with key `b:cccccccc` and the
 * principal `user:a:b` with key `cccccccc` would produce one string — which is the cross-caller
 * collision this function exists to remove, reintroduced by its own punctuation. `|` is outside
 * the client-key charset, so the LAST `|` always separates the two however either is spelled.
 *
 * It also makes the new format visibly distinct from the old one, which is what lets a key
 * written before this change be told apart from one written after it. See `namespacedKey`.
 */
const PRINCIPAL_DELIMITER = '|'

/**
 * The stored key, namespaced by the calling service, the route, AND the principal.
 *
 * The route is in the key because the same client key presented to `POST /v1/listings` and to
 * `POST /v1/listings/:id/buy` describes two different operations, and a caller reusing its
 * request id across both is doing something reasonable.
 *
 * The principal is in it because keys are chosen by callers and callers do not coordinate. See
 * the header for why this belongs here rather than in the fingerprint.
 *
 * ── KEYS IN FLIGHT ACROSS THE DEPLOY, AND WHY THIS IS A CLEAN BREAK ───────────────────────────
 *
 * A key claimed before this change is stored as `market:/v1/listings:K` and will never be found
 * again, because the same request now looks for `market:/v1/listings:user:…|K`. That is deliberate
 * and it is not fixable by a transition, for a reason worth writing down: THE OLD ROW DOES NOT
 * RECORD WHOSE IT WAS. `idempotency_keys` has no actor column (`migrations.ts`), so a
 * compatibility read that fell back to the legacy key on a miss would be exactly the cross-caller
 * read being removed here — it would preserve the defect for the length of the transition rather
 * than close it, and preserve it precisely in the window where two callers are most likely to be
 * mid-retry at once.
 *
 * What the break costs is bounded, and much smaller than that:
 *
 *   * a key is only in flight for as long as a client's retry window, and a deploy restarts this
 *     process anyway, so the exposed set is "requests retried across one restart";
 *   * six of the seven wrapped routes have an artefact-level natural key that catches a duplicate
 *     with no claim row at all — `orders_listing_uniq`, `bids_leading_uniq`, `offers_open_uniq`,
 *     `disputes_open_uniq`, `moderation_open_freeze_uniq`. A lost claim there costs a wasted
 *     INSERT, not a second order;
 *   * the seventh, `POST /v1/listings`, is guarded by `listings_idempotency_uniq` on this very
 *     string — so a retry that crosses the restart writes at most one extra DRAFT listing, which
 *     holds no reservation and sells nothing until it is activated.
 *
 * And the two formats cannot be confused: no legacy key contains a `|`, and every new one does,
 * so nothing written before this change can ever resolve against something written after it. The
 * legacy rows are left where they are; the reaper takes them at their TTL.
 */
export function namespacedKey(
  originatingService: string,
  route: string,
  principal: string,
  clientKey: string,
): string {
  return `${originatingService}:${route}:${principal}${PRINCIPAL_DELIMITER}${clientKey}`
}

export interface IdempotentOutcome<T> {
  readonly result: T
  readonly replayed: boolean
}

export interface IdempotencyInput<T> {
  readonly originatingService: string
  readonly route: string
  /**
   * The authenticated caller, as `user:<id>` or `service:<name>` — `subjectOf(principal)` at every
   * call site. Required rather than optional: an omitted principal is the defect this parameter
   * was added to close, and a default would let it back in silently.
   */
  readonly principal: string
  readonly clientKey: string
  readonly requestHash: string
  /**
   * The work. Returns the response to store and, when the work created one, the artefact id — so
   * the claim row points at the order, listing or entry and an operator can join a caller's key
   * to what it produced.
   */
  readonly run: (tx: Tx, storedKey: string) => Promise<{ response: T; artefactId: string | null }>
}

export async function withIdempotency<T>(
  sql: Db,
  input: IdempotencyInput<T>,
): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.originatingService, input.route, input.principal, input.clientKey)

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, route, request_hash)
      values (${key}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `
      const existing = rows[0]
      if (!existing) throw new IdempotencyInFlightError()
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError()
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError()
      }
      return { value: { result: existing.response as T, replayed: true } }
    }

    const { response, artefactId } = await input.run(tx, key)

    await tx`
      update idempotency_keys
         set response = ${tx.json(response as Record<string, never>)},
             artefact_id = ${artefactId}
       where key = ${key}
    `

    return { value: { result: response, replayed: false } }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * How many keys one DELETE claims.
 *
 * An unbounded DELETE over a table that has never been pruned is a single long transaction
 * holding a row lock on everything it removes, producing one enormous batch of dead tuples. Short
 * statements let autovacuum keep up and keep the reaper out of the way of the claim INSERT at the
 * head of every purchase.
 */
const REAP_BATCH = 5_000

/**
 * Delete idempotency keys past their TTL. Returns how many rows went.
 *
 * The cutoff is the entire safety argument: expiring a key EARLY means the next replay of it buys
 * the item a second time, so the TTL has to outlive every caller's retry horizon rather than be
 * as short as the table would like.
 *
 * A claim row that produced an artefact is kept regardless of age. It is the only link between a
 * caller's key and the order it made, and losing it turns "did my retry buy this twice" into an
 * unanswerable question.
 */
export async function reapIdempotencyKeys(sql: Db, ttlDays: number): Promise<number> {
  // An ISO string with an explicit cast, not a Date: postgres.js resolves a prepared statement's
  // parameter types from the server's ParameterDescription, and inside a subquery it does not come
  // back with the timestamptz serialiser — a raw Date is then handed to the text encoder and
  // throws. The cast removes the question. The string is UTC, which is what the column stores.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (;;) {
    const result = await sql`
      delete from idempotency_keys
       where key in (
         select key from idempotency_keys
          where created_at < ${cutoff}::timestamptz
            and artefact_id is null
          limit ${REAP_BATCH}
       )
    `
    total += result.count
    if (result.count < REAP_BATCH) return total
  }
}
