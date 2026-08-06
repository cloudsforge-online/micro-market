/**
 * A listing's gallery: references into micro-studio, ordered, and only the seller's to change.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THIS SERVICE NEVER TOUCHES AN IMAGE
 *
 * There is no byte in this file, no `Buffer`, no `content-type`, no directory and no bucket. An
 * image belongs to **micro-studio**, which is the estate's single media service: it decides the
 * format from magic bytes rather than from a header, refuses SVG outright, bounds dimensions and
 * pixel count, strips EXIF and GPS, and serves the bytes with `nosniff` and a restrictive CSP
 * (`studio/src/server.ts`). Re-implementing any of that here would give the estate two places to
 * secure and two to keep current, and on the day they disagreed the weaker one is the one that
 * would be used.
 *
 * What market owns is the two facts studio cannot know: **which listing an asset belongs to, and
 * who is allowed to say so.** That is this file.
 *
 * ## WHAT IS NOT CHECKED, SAID OUT LOUD
 *
 * Attaching does **not** call studio. This service does not confirm the asset exists, does not
 * confirm it belongs to the seller, and does not recompute the checksum over its bytes. Three
 * reasons, in order of weight:
 *
 *   1. **Nothing here can be made unsafe by a wrong id.** Studio decides who may read an asset's
 *      bytes: public bytes are public to the world already, and private bytes answer 403 to the
 *      browser regardless of what this table says (`studio/src/server.ts`, the `:id/bytes` route).
 *      A row naming an asset that does not exist renders as a broken image — a cosmetic defect —
 *      and cannot leak anything, move money, or change who owns what.
 *   2. **An HTTP call inside this transaction would be a worse defect than the one it closes.**
 *      The listing row is held under `for update` for the whole of each function below. Calling a
 *      peer while holding it would put a network round trip inside a row lock on the hottest row
 *      in this service — the same reasoning `server.ts`'s idempotency wrapper gives for not
 *      threading its claim transaction through the ledger calls.
 *   3. Studio is already the authority on its own assets. A copy of its answer, taken at attach
 *      time and never refreshed, is a cache with no invalidation — it would go stale the moment an
 *      owner flipped an asset back to private, and would then be a *confident* wrong answer rather
 *      than an absent one.
 *
 * ## THE CHECKSUM IS RECORDED, NOT VERIFIED, AND CERTAINLY NOT ATTESTED
 *
 * `checksum` is `sha256:<64 lowercase hex>` — studio's spelling (`studio/src/assets.ts`) and
 * tessera's (`tessera/src/migrations.ts`), because the estate has one vocabulary for a content
 * address rather than two dialects. It is stored so that two systems can talk about the same bytes
 * and so an operator can ask studio about a listing's image by its address.
 *
 * **It is not evidence of anything.** Studio computed it; this row remembers what the client said
 * studio said. And there is no chain behind it: Hearth has NO Registry of Authorship contract —
 * `tessera/src/kiln.ts` records that the Solidity has never been written, and mint's
 * catalogue can only deploy three ERC-20 variants — so studio's own `anchor.state` is
 * `'unanchored'` on every asset that exists today. No payload, response or screen produced from
 * this table may call an image "verified", "attested", "anchored" or "on-chain". On a platform
 * that custodies real money, a badge that always passes is worse than no badge: it teaches buyers
 * to trust a check that has never once been performed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { emitOn, type Db, type Tx } from './outbox.ts'
import {
  FrozenError,
  ListingError,
  ListingStateError,
  type ListingStatus,
} from './listings.ts'

/**
 * One topic for the whole gallery rather than three verbs.
 *
 * A consumer of this fact — a search index, a CDN purge, an activity feed — cares that *listing X's
 * pictures are now this list*, which is what the payload carries. Three topics (`attached`,
 * `detached`, `reordered`) would be three contracts to register and three rules to write in
 * `micro-notify` for one piece of information, and a consumer that handled two of them would be
 * subtly wrong rather than obviously incomplete. The verb is still on the wire as `change`, for a
 * feed that wants to render a sentence.
 *
 * Keyed by `listing_id`, like every other topic this service emits, because ordering is per
 * `(topic, key)` and an attach followed immediately by a reorder must arrive in that order.
 */
export const IMAGES_CHANGED_TOPIC = 'market.listing_image.changed'

/**
 * The gallery ceiling, stated once.
 *
 * **The schema is what enforces it** — `listing_images_position_range` bounds `position` to
 * `0 <= position < 10` and `listing_images_position_uniq` makes `(listing_id, position)` unique,
 * so ten distinct slots each usable once cap the count without a trigger and without a counter.
 * The constant below exists so the refusal a seller reads names the number, and so this module can
 * refuse before Postgres has to. If the two ever disagree, the database wins and the seller gets a
 * 500 — which is why `listingimages.test.ts` asserts the constraint directly rather than only
 * through this function.
 */
export const MAX_LISTING_IMAGES = 10

/** studio's spelling of a content address, character for character. See the file header. */
export const CHECKSUM_SHAPE = /^sha256:[0-9a-f]{64}$/

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * The statuses in which a gallery may still be edited.
 *
 * A `draft` is not on the market and a seller is still composing it. An `active` listing is on the
 * market and its photographs are its shopfront; a seller correcting a badly-lit photograph must not
 * have to cancel and relist, which would release the escrow and lose the listing's age and its
 * bids.
 *
 * **Every other status is closed, and that is the substantive rule here.** `settling`, `sold`,
 * `cancelled` and `expired` are states in which the listing has stopped being an offer and started
 * being a RECORD of one. The photographs are part of what a buyer agreed to buy: an order names
 * the listing (`orders_listing_uniq`), a dispute is raised against that order, and the question a
 * dispute actually asks is "was the item as shown?". A seller who could re-photograph a sold
 * listing could answer that question after the fact, in their own favour, with no trace — the
 * gallery has no history table and this row is overwritten in place. Refusing the edit is what
 * makes the evidence worth having.
 *
 * `settling` is inside the closed set deliberately, not by omission: it is the window in which
 * money is moving, and it is exactly the moment at which the record must stop moving.
 */
const EDITABLE_STATUSES: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['draft', 'active'])

export interface ListingImage {
  readonly listingId: string
  readonly studioAssetId: string
  readonly checksum: string
  /** Dense and zero-based: a gallery is always `0 … n-1`. See `rewriteGallery`. */
  readonly position: number
  readonly attachedAt: Date
}

interface ListingImageRow {
  readonly listing_id: string
  readonly studio_asset_id: string
  readonly checksum: string
  readonly position: number
  readonly attached_at: Date
}

const IMAGE_COLUMNS = 'listing_id, studio_asset_id, checksum, position, attached_at'

function toListingImage(row: ListingImageRow): ListingImage {
  return {
    listingId: row.listing_id,
    studioAssetId: row.studio_asset_id,
    checksum: row.checksum,
    position: row.position,
    attachedAt: row.attached_at,
  }
}

export interface ListingImageDeps {
  readonly sql: Db
  readonly producer: string
}

type Actor = `user:${string}` | `service:${string}` | `operator:${string}` | 'system'

/* ------------------------------------------------------------------ reads */

/** One listing's gallery, in gallery order. */
export async function listingImages(
  sql: Db | Tx,
  listingId: string,
): Promise<readonly ListingImage[]> {
  const rows = await sql<ListingImageRow[]>`
    select ${sql.unsafe(IMAGE_COLUMNS)} from listing_images
     where listing_id = ${listingId}
     order by position
  `
  return rows.map(toListingImage)
}

/**
 * Every listing's gallery, for a page of listings, in ONE query.
 *
 * The browse route renders up to fifty listings. Calling `listingImages` per listing would make
 * that fifty-one round trips — the N+1 that turns a fast list endpoint into a slow one under
 * exactly the load it was built for. Listings with no images are absent from the map rather than
 * present with an empty array, so a caller has to decide what "no images" renders as instead of
 * being handed one silently.
 */
export async function listingImagesFor(
  sql: Db,
  listingIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ListingImage[]>> {
  const byListing = new Map<string, ListingImage[]>()
  // An empty `= any('{}')` is a legal query and a pointless round trip. The caller that hands us
  // an empty page is the common case on a filtered browse, not an edge case.
  if (listingIds.length === 0) return byListing
  const rows = await sql<ListingImageRow[]>`
    select ${sql.unsafe(IMAGE_COLUMNS)} from listing_images
     where listing_id = any(${listingIds as string[]})
     order by listing_id, position
  `
  for (const row of rows) {
    const image = toListingImage(row)
    const bucket = byListing.get(image.listingId)
    if (bucket) bucket.push(image)
    else byListing.set(image.listingId, [image])
  }
  return byListing
}

/* ------------------------------------------------------------------ the guard */

interface LockedListing {
  readonly id: string
  readonly sellerSubject: string
  readonly status: ListingStatus
}

/**
 * Take the listing's row lock and answer the three questions every write below asks.
 *
 * The lock is not decoration. It is what serialises two concurrent gallery writes for one listing,
 * which is what lets `attachListingImage` compute the next position as `count` rather than racing
 * two attaches into the same slot — and it is what makes the status check meaningful, because a
 * status read outside a lock is a status that can change between the check and the write.
 *
 * Ownership is re-checked HERE even though the routes check it first. The route's check is what
 * produces the right STATUS CODE (a 404, never a 403 — see `server.ts`'s error map: a distinct
 * refusal for "exists but is not yours" is an enumeration oracle for who is selling what). This
 * one is what makes the rule true for every caller, including a job or a future route that forgets.
 */
async function lockEditableListing(
  tx: Tx,
  listingId: string,
  sellerSubject: string,
): Promise<LockedListing> {
  const rows = await tx<{ id: string; seller_subject: string; status: ListingStatus; frozen: boolean }[]>`
    select id, seller_subject, status, frozen from listings where id = ${listingId} for update
  `
  const row = rows[0]
  // The same sentence for "no such listing" and "not yours", for the reason above.
  if (!row) throw new ListingStateError('no such listing')
  if (row.seller_subject !== sellerSubject) throw new ListingStateError('no such listing')
  // A frozen listing is one a human is looking at. Letting its seller change the photographs
  // underneath that review would make the review a review of something else.
  if (row.frozen) throw new FrozenError()
  if (!EDITABLE_STATUSES.has(row.status)) {
    throw new ListingStateError(
      `a ${row.status} listing's images are part of the record of what was sold and cannot be changed`,
    )
  }
  return { id: row.id, sellerSubject: row.seller_subject, status: row.status }
}

/**
 * Replace a listing's gallery with exactly this ordering, positions `0 … n-1`.
 *
 * **Delete-then-insert, rather than an `update … set position = …` per row.** A unique constraint
 * in Postgres is checked as each ROW is updated, not at the end of the statement, so renumbering in
 * place hits a transient duplicate whenever two rows swap or a gap closes — a defect that appears
 * only when the rows happen to be processed in the unlucky order, which is to say in production.
 * `listing_images_position_uniq` could be made `deferrable`, but a deferrable uniqueness constraint
 * is one that is briefly untrue, and this table is small by construction (ten rows, ceiling) so
 * rewriting it costs nothing worth protecting.
 *
 * `attached_at` is carried across for a row that survives, so a reorder does not make every
 * photograph look newly added.
 */
async function rewriteGallery(
  tx: Tx,
  listingId: string,
  ordered: readonly { studioAssetId: string; checksum: string; attachedAt: Date | null }[],
): Promise<readonly ListingImage[]> {
  await tx`delete from listing_images where listing_id = ${listingId}`
  const written: ListingImage[] = []
  for (const [index, image] of ordered.entries()) {
    const rows = await tx<ListingImageRow[]>`
      insert into listing_images (listing_id, studio_asset_id, checksum, position, attached_at)
      values (
        ${listingId},
        ${image.studioAssetId},
        ${image.checksum},
        ${index},
        ${image.attachedAt ?? new Date()}
      )
      returning ${tx.unsafe(IMAGE_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new ListingStateError('the gallery could not be written')
    written.push(toListingImage(row))
  }
  return written
}

/** The payload every change emits. The gallery AS IT NOW STANDS, so a consumer needs no history. */
function changedPayload(
  listing: LockedListing,
  change: 'attached' | 'detached' | 'reordered',
  images: readonly ListingImage[],
): Record<string, unknown> {
  return {
    listingId: listing.id,
    // Named so a consumer can address the person without a second call into this service. The same
    // reason `market.offer.made` carries `sellerSubject` — see `topics.ts`.
    sellerSubject: listing.sellerSubject,
    change,
    imageCount: images.length,
    // Ids and addresses only. No URL: where a browser reaches studio is a DEPLOYMENT fact that
    // this service reads from its own environment, and baking one into an event would freeze
    // today's hostname into a row that outlives it.
    images: images.map((image) => ({
      studioAssetId: image.studioAssetId,
      checksum: image.checksum,
      position: image.position,
    })),
  }
}

/* ------------------------------------------------------------------ writes */

export interface AttachImageInput {
  readonly listingId: string
  readonly sellerSubject: string
  readonly studioAssetId: string
  readonly checksum: string
  readonly actor: Actor
  readonly correlationId: string
}

/**
 * Add one studio asset to the end of a listing's gallery.
 *
 * **There is no `position` parameter, deliberately.** A caller-chosen slot is either already taken
 * — in which case the server has to shift the tail, which is the renumbering race `rewriteGallery`
 * exists to avoid — or it is beyond the end, in which case the gallery becomes sparse and
 * `position` stops meaning "the nth photograph". Appending is the only insertion with no such
 * choice to get wrong, and `setListingGallery` below is how a seller orders them afterwards.
 */
export async function attachListingImage(
  deps: ListingImageDeps,
  input: AttachImageInput,
): Promise<{ readonly image: ListingImage; readonly images: readonly ListingImage[] }> {
  requireAssetId(input.studioAssetId)
  requireChecksum(input.checksum)

  const outcome = await deps.sql.begin(async (tx) => {
    const listing = await lockEditableListing(tx, input.listingId, input.sellerSubject)
    const existing = await listingImages(tx, listing.id)

    if (existing.some((image) => image.studioAssetId === input.studioAssetId)) {
      // A conflict rather than a silent success. The primary key already refuses the row; saying
      // so plainly is what stops a seller believing they have two photographs when they have one.
      throw new ListingStateError('that image is already in the gallery for this listing')
    }
    if (existing.length >= MAX_LISTING_IMAGES) {
      throw new ListingStateError(
        `a listing may hold at most ${MAX_LISTING_IMAGES} images; remove one first`,
      )
    }

    // `existing.length` is safe as the next position because every gallery is dense — see
    // `rewriteGallery` — and because the listing's row lock is held, so no second attach can be
    // computing the same number.
    const rows = await tx<ListingImageRow[]>`
      insert into listing_images (listing_id, studio_asset_id, checksum, position)
      values (${listing.id}, ${input.studioAssetId}, ${input.checksum}, ${existing.length})
      returning ${tx.unsafe(IMAGE_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new ListingStateError('the image could not be attached')
    const image = toListingImage(row)
    const images = [...existing, image]

    await emitOn(tx, deps.producer, {
      topic: IMAGES_CHANGED_TOPIC,
      key: listing.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: changedPayload(listing, 'attached', images),
    })
    return { value: { image, images } }
  })
  return outcome.value
}

export interface DetachImageInput {
  readonly listingId: string
  readonly sellerSubject: string
  readonly studioAssetId: string
  readonly actor: Actor
  readonly correlationId: string
}

/**
 * Remove one studio asset from a listing's gallery, and close the gap it leaves.
 *
 * **Detaching something that is not attached is a success, not a 404.** The caller asked for a
 * gallery without that image and that is the gallery they get; a retry of a DELETE whose response
 * was lost must not report a failure for work that succeeded. Nothing is emitted in that case,
 * because nothing changed — an event for a no-op is how a feed fills with entries nobody did.
 *
 * The gap is closed rather than left sparse. A sparse gallery would make `attachListingImage`'s
 * next position climb past the range check while the listing held only three photographs, and a
 * seller who had swapped a few would be told their gallery is full when it visibly is not.
 */
export async function detachListingImage(
  deps: ListingImageDeps,
  input: DetachImageInput,
): Promise<{ readonly detached: boolean; readonly images: readonly ListingImage[] }> {
  requireAssetId(input.studioAssetId)

  const outcome = await deps.sql.begin(async (tx) => {
    const listing = await lockEditableListing(tx, input.listingId, input.sellerSubject)
    const existing = await listingImages(tx, listing.id)
    const survivors = existing.filter((image) => image.studioAssetId !== input.studioAssetId)
    if (survivors.length === existing.length) {
      return { value: { detached: false, images: existing } }
    }

    const images = await rewriteGallery(
      tx,
      listing.id,
      survivors.map((image) => ({
        studioAssetId: image.studioAssetId,
        checksum: image.checksum,
        attachedAt: image.attachedAt,
      })),
    )
    await emitOn(tx, deps.producer, {
      topic: IMAGES_CHANGED_TOPIC,
      key: listing.id,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: changedPayload(listing, 'detached', images),
    })
    return { value: { detached: true, images } }
  })
  return outcome.value
}

export interface GalleryEntry {
  readonly studioAssetId: string
  readonly checksum: string
}

export interface SetGalleryInput {
  readonly listingId: string
  readonly sellerSubject: string
  /** The whole gallery, in the order it should render. Position is the index; there is no field. */
  readonly images: readonly GalleryEntry[]
  readonly actor: Actor
  readonly correlationId: string
}

/**
 * Set a listing's whole gallery at once: the reorder, and the bulk edit.
 *
 * A complete replacement rather than a list of moves, which is why the route that calls it is a
 * `PUT` and why it needs no idempotency wrapper: sending the same ordering twice produces the same
 * gallery. A "move image 3 to position 1" verb would be neither — two clients issuing two moves
 * against one gallery produce an ordering neither of them asked for, and a retried move applies
 * twice.
 *
 * An entry not already attached is attached by this call, and an attached asset the caller omits is
 * detached by it. That is what "the whole gallery" means; a caller who wanted to add one image
 * without re-sending the rest has `attachListingImage`.
 */
export async function setListingGallery(
  deps: ListingImageDeps,
  input: SetGalleryInput,
): Promise<readonly ListingImage[]> {
  if (input.images.length > MAX_LISTING_IMAGES) {
    throw new ListingError(`a listing may hold at most ${MAX_LISTING_IMAGES} images`)
  }
  const seen = new Set<string>()
  for (const entry of input.images) {
    requireAssetId(entry.studioAssetId)
    requireChecksum(entry.checksum)
    // Refused here rather than left to the primary key, because the key would refuse the SECOND
    // insert half way through a rewrite that has already deleted the old gallery. The transaction
    // rolls back either way; this produces a sentence a seller can act on instead of a 500.
    if (seen.has(entry.studioAssetId)) {
      throw new ListingError('the same image cannot appear twice in one gallery')
    }
    seen.add(entry.studioAssetId)
  }

  const outcome = await deps.sql.begin(async (tx) => {
    const listing = await lockEditableListing(tx, input.listingId, input.sellerSubject)
    const existing = await listingImages(tx, listing.id)
    const attachedAt = new Map(existing.map((image) => [image.studioAssetId, image.attachedAt]))

    const images = await rewriteGallery(
      tx,
      listing.id,
      input.images.map((entry) => ({
        studioAssetId: entry.studioAssetId,
        checksum: entry.checksum,
        attachedAt: attachedAt.get(entry.studioAssetId) ?? null,
      })),
    )

    // Same list in the same order is not a change. The rewrite above ran regardless — it is
    // cheaper than deciding not to — but the BUS must not carry an event for a gallery nobody
    // altered, or every page refresh that re-sent the current ordering would look like an edit.
    const before = existing.map((image) => image.studioAssetId).join(',')
    const after = images.map((image) => image.studioAssetId).join(',')
    if (before !== after) {
      await emitOn(tx, deps.producer, {
        topic: IMAGES_CHANGED_TOPIC,
        key: listing.id,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: changedPayload(listing, 'reordered', images),
      })
    }
    return { value: images }
  })
  return outcome.value
}

/* ------------------------------------------------------------------ input shapes */

/**
 * `ListingError`, which `server.ts` maps to 400 — the same class `createListing` throws for a bad
 * royalty. A new error class would need a new arm in that map, and an arm nobody added is a 500 for
 * a request that was simply malformed.
 */
function requireChecksum(value: string): void {
  if (!CHECKSUM_SHAPE.test(value)) {
    throw new ListingError(
      'checksum must be sha256:<64 lowercase hex>, exactly as micro-studio reports it',
    )
  }
}

function requireAssetId(value: string): void {
  // Checked here as well as by the `uuid` column, because Postgres answers a malformed uuid with
  // 22P02, which reaches the error handler unrecognised and becomes a 500 — see `itemIdOf` in
  // `server.ts` for the same defect on the path parameter.
  if (!UUID_SHAPE.test(value)) throw new ListingError('a studio asset id must be a uuid')
}
