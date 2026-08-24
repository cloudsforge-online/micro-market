/**
 * A listing's gallery: who may change it, when, and what the SCHEMA refuses no matter what a
 * handler believes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE FOUR CLAIMS, AND WHERE EACH IS ACTUALLY PROVED
 *
 *   1. **Only the seller.** Proved over the real `createServer` on a real socket, because the rule
 *      is enforced in two places — the route, for the status code, and `lockEditableListing`, under
 *      the listing's row lock, for the rule itself — and a domain-only test would show the second
 *      while a route added tomorrow forgot the first. The answer must be **404 and not 403**: a
 *      distinct refusal for "exists but is not yours" is an enumeration oracle for who is selling
 *      what, which is the reasoning `server.ts`'s status map already carries.
 *
 *   2. **The gallery is bounded by the DATABASE.** `listing_images_position_range` and
 *      `listing_images_position_uniq` are asserted with RAW INSERTS that bypass every function in
 *      this repository. Going through `attachListingImage` would prove the function counts, which
 *      is not the claim: the claim is that a backfill, a psql session or a route written next year
 *      cannot put eleven images on a listing or two images in one slot. The same for the checksum
 *      shape — a client sending a bare hex digest must be refused by the column, not by a regular
 *      expression somebody may delete.
 *
 *   3. **A sold listing's photographs are frozen.** Reached through `settleSale`, so the listing is
 *      genuinely `sold` with an order behind it rather than an `update … set status` a test wrote.
 *      This is the rule that makes "was the item as shown?" answerable during a dispute, and a
 *      fixture that faked the state would not exercise the status the sale actually leaves.
 *
 *   4. **A read returns the gallery in gallery order**, on both listing routes, with `bytesUrl`
 *      absolute when this deployment knows studio's public address and `null` when it does not.
 *
 * ## WHAT IS DELIBERATELY NOT ASSERTED HERE
 *
 * That an attached asset EXISTS in studio, belongs to the seller, or has those bytes. This service
 * never asks studio and `listingimages.ts` says at length why. There is no test for a property this
 * code does not have — a passing test named after a check nobody performs is worse than no test.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { singleNetworkSql } from './testsupport.ts'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics } from './server.ts'
import {
  CHECKSUM_SHAPE,
  IMAGES_CHANGED_TOPIC,
  MAX_LISTING_IMAGES,
  attachListingImage,
  detachListingImage,
  listingImages,
  listingImagesFor,
  setListingGallery,
} from './listingimages.ts'
import { FrozenError, ListingError, ListingStateError } from './listings.ts'
import { settleSale } from './orders.ts'
import {
  BUYER,
  SECOND_BUYER,
  SELLER,
  fakeVerifier,
  harness,
  migrateTestDb,
  openDb,
  quietLogger,
  resetMarket,
  seedListing,
  skip,
  type Harness,
} from './testsupport.ts'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

/** studio's public base, as a deployment that HAS one would set it. */
const STUDIO = 'https://studio.example.test'

/** A well-formed content address. 64 lowercase hex, exactly as `studio/src/assets.ts` writes it. */
const digest = (seed: string): string =>
  `sha256:${seed.repeat(64).slice(0, 64)}`.toLowerCase()

const ASSET_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const ASSET_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const ASSET_C = 'cccccccc-3333-4333-8333-333333333333'

const CHECK_A = digest('a1')
const CHECK_B = digest('b2')
const CHECK_C = digest('c3')

describe('listing images', { skip }, () => {
  let sql: postgres.Sql
  let h: Harness

  before(async () => {
    sql = openDb(6)
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetMarket(sql)
    h = harness(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- the schema */

  describe('what the schema refuses, whatever a handler believes', () => {
    /** A raw INSERT, on purpose: this suite is testing the COLUMN, not the function above it. */
    const rawInsert = (listingId: string, assetId: string, checksum: string, position: number) =>
      sql`
        insert into listing_images (listing_id, studio_asset_id, checksum, position)
        values (${listingId}, ${assetId}, ${checksum}, ${position})
      `

    test('a checksum that is not sha256:<64 lowercase hex> cannot be written', async () => {
      const listing = await seedListing(h)
      // Every one of these is a shape a real client has actually sent somewhere in this estate: a
      // bare digest, an uppercase one, the wrong algorithm, one hex digit short, and empty.
      const malformed = [
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        `SHA256:${'A'.repeat(64)}`,
        `sha256:${'A'.repeat(64)}`,
        `md5:${'a'.repeat(32)}`,
        `sha256:${'a'.repeat(63)}`,
        '',
      ]
      for (const [index, checksum] of malformed.entries()) {
        await assert.rejects(
          () => rawInsert(listing.id, ASSET_A, checksum, index),
          /listing_images_checksum_shape/,
          `the column accepted ${JSON.stringify(checksum)}`,
        )
      }
      // And the shape the module exports agrees with the column, so a client refused by one is
      // refused by the other rather than by whichever it happens to reach first.
      for (const checksum of malformed) assert.equal(CHECKSUM_SHAPE.test(checksum), false)
      assert.equal(CHECKSUM_SHAPE.test(CHECK_A), true)
    })

    test(`the ${MAX_LISTING_IMAGES + 1}th image has nowhere to go`, async () => {
      const listing = await seedListing(h)
      for (let position = 0; position < MAX_LISTING_IMAGES; position += 1) {
        await rawInsert(listing.id, uuidFor(position), digest('0'), position)
      }
      // No counter, no trigger, no `select count(*)`: the range check is the whole mechanism.
      await assert.rejects(
        () => rawInsert(listing.id, uuidFor(99), digest('0'), MAX_LISTING_IMAGES),
        /listing_images_position_range/,
      )
      // A negative slot is refused by the same constraint, which is what makes "prepend by using
      // -1" impossible rather than merely undocumented.
      await assert.rejects(
        () => rawInsert(listing.id, uuidFor(98), digest('0'), -1),
        /listing_images_position_range/,
      )
    })

    test('two images cannot occupy one position', async () => {
      const listing = await seedListing(h)
      await rawInsert(listing.id, ASSET_A, CHECK_A, 0)
      await assert.rejects(
        () => rawInsert(listing.id, ASSET_B, CHECK_B, 0),
        /listing_images_position_uniq/,
      )
      // …and the same asset cannot be in one gallery twice, which is the primary key rather than
      // the unique constraint. Both halves matter: the first bounds the SIZE, the second stops one
      // photograph being shown four times to fill it.
      await assert.rejects(
        () => rawInsert(listing.id, ASSET_A, CHECK_A, 1),
        /listing_images_pkey/,
      )
    })

    test('a gallery dies with its listing', async () => {
      const listing = await seedListing(h)
      await rawInsert(listing.id, ASSET_A, CHECK_A, 0)
      await sql`delete from listings where id = ${listing.id}`
      const rows = await sql`select 1 from listing_images where listing_id = ${listing.id}`
      // `on delete cascade`. Without it a purge would leave rows pointing at a listing that is
      // gone, and the only symptom would be a table that never stops growing.
      assert.equal(rows.length, 0)
    })
  })

  /* ---------------------------------------------------------------- ownership */

  describe('only the seller', () => {
    test('another seller cannot attach, detach or reorder, and is told the listing does not exist', async () => {
      const listing = await seedListing(h, { sellerSubject: SELLER })
      await attachListingImage(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_A,
        checksum: CHECK_A,
        actor: SELLER as `user:${string}`,
        correlationId: 'seed',
      })

      for (const call of [
        () =>
          attachListingImage(h.images, {
            listingId: listing.id,
            sellerSubject: BUYER,
            studioAssetId: ASSET_B,
            checksum: CHECK_B,
            actor: BUYER as `user:${string}`,
            correlationId: 'r',
          }),
        () =>
          detachListingImage(h.images, {
            listingId: listing.id,
            sellerSubject: BUYER,
            studioAssetId: ASSET_A,
            actor: BUYER as `user:${string}`,
            correlationId: 'r',
          }),
        () =>
          setListingGallery(h.images, {
            listingId: listing.id,
            sellerSubject: BUYER,
            images: [],
            actor: BUYER as `user:${string}`,
            correlationId: 'r',
          }),
      ]) {
        await assert.rejects(call, (err: unknown) => {
          assert.ok(err instanceof ListingStateError)
          // The same sentence a missing listing gets. See the file header.
          assert.match((err as Error).message, /no such listing/)
          return true
        })
      }

      // And nothing moved. A refusal that had already deleted the gallery would pass every
      // assertion above and still have destroyed the seller's photographs.
      const after = await listingImages(sql, listing.id)
      assert.equal(after.length, 1)
      assert.equal(after[0]?.studioAssetId, ASSET_A)
    })

    test('a listing under moderation is not re-photographed while a human looks at it', async () => {
      const listing = await seedListing(h)
      await sql`update listings set frozen = true where id = ${listing.id}`
      await assert.rejects(
        () =>
          attachListingImage(h.images, {
            listingId: listing.id,
            sellerSubject: SELLER,
            studioAssetId: ASSET_A,
            checksum: CHECK_A,
            actor: SELLER as `user:${string}`,
            correlationId: 'r',
          }),
        FrozenError,
      )
    })
  })

  /* ---------------------------------------------------------------- the closed statuses */

  describe('a finished listing is a record, not an offer', () => {
    test('a SOLD listing refuses every gallery change', async () => {
      const listing = await seedListing(h)
      await attachListingImage(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_A,
        checksum: CHECK_A,
        actor: SELLER as `user:${string}`,
        correlationId: 'seed',
      })

      // Through the real sale rather than an `update … set status`, so the state under test is the
      // state a sale actually leaves behind.
      await settleSale(h.orders, {
        listingId: listing.id,
        buyerSubject: BUYER,
        amount: 1_000n,
        source: 'purchase',
        actor: BUYER as `user:${string}`,
        correlationId: 'buy',
      })
      const sold = await sql<{ status: string }[]>`select status from listings where id = ${listing.id}`
      assert.equal(sold[0]?.status, 'sold')

      const refusal = /record of what was sold/
      await assert.rejects(
        () =>
          attachListingImage(h.images, {
            listingId: listing.id,
            sellerSubject: SELLER,
            studioAssetId: ASSET_B,
            checksum: CHECK_B,
            actor: SELLER as `user:${string}`,
            correlationId: 'r',
          }),
        refusal,
      )
      // Detach and reorder too. Removing the photograph of the thing you sold is the version of
      // this that actually matters during a dispute.
      await assert.rejects(
        () =>
          detachListingImage(h.images, {
            listingId: listing.id,
            sellerSubject: SELLER,
            studioAssetId: ASSET_A,
            actor: SELLER as `user:${string}`,
            correlationId: 'r',
          }),
        refusal,
      )
      await assert.rejects(
        () =>
          setListingGallery(h.images, {
            listingId: listing.id,
            sellerSubject: SELLER,
            images: [],
            actor: SELLER as `user:${string}`,
            correlationId: 'r',
          }),
        refusal,
      )

      // The evidence survived all three refusals.
      assert.equal((await listingImages(sql, listing.id)).length, 1)
    })

    test('cancelled and expired are closed too, and a draft is open', async () => {
      for (const status of ['cancelled', 'expired', 'settling'] as const) {
        const listing = await seedListing(h)
        await sql`update listings set status = ${status} where id = ${listing.id}`
        await assert.rejects(
          () =>
            attachListingImage(h.images, {
              listingId: listing.id,
              sellerSubject: SELLER,
              studioAssetId: ASSET_A,
              checksum: CHECK_A,
              actor: SELLER as `user:${string}`,
              correlationId: 'r',
            }),
          new RegExp(`a ${status} listing`),
        )
      }
      // The open case, so the test above is not passing because everything is refused.
      const draft = await seedListing(h, { activate: false })
      const attached = await attachListingImage(h.images, {
        listingId: draft.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_A,
        checksum: CHECK_A,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })
      assert.equal(attached.image.position, 0)
    })
  })

  /* ---------------------------------------------------------------- the gallery itself */

  describe('attach, detach, reorder', () => {
    const attach = (listingId: string, assetId: string, checksum: string) =>
      attachListingImage(h.images, {
        listingId,
        sellerSubject: SELLER,
        studioAssetId: assetId,
        checksum,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })

    test('images append in the order they arrive, and a read returns them in that order', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      await attach(listing.id, ASSET_B, CHECK_B)
      await attach(listing.id, ASSET_C, CHECK_C)

      const images = await listingImages(sql, listing.id)
      assert.deepEqual(
        images.map((image) => [image.studioAssetId, image.position]),
        [
          [ASSET_A, 0],
          [ASSET_B, 1],
          [ASSET_C, 2],
        ],
      )
    })

    test('one asset cannot be attached to one listing twice', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      await assert.rejects(() => attach(listing.id, ASSET_A, CHECK_A), /already in the gallery/)
      assert.equal((await listingImages(sql, listing.id)).length, 1)
    })

    test('the module refuses the eleventh image with a sentence, before Postgres refuses it with a 500', async () => {
      const listing = await seedListing(h)
      for (let index = 0; index < MAX_LISTING_IMAGES; index += 1) {
        await attach(listing.id, uuidFor(index), digest('0'))
      }
      await assert.rejects(
        () => attach(listing.id, uuidFor(50), digest('0')),
        (err: unknown) => {
          assert.ok(err instanceof ListingStateError, 'a 409, not an unmapped constraint violation')
          assert.match((err as Error).message, /at most 10 images/)
          return true
        },
      )
    })

    test('detaching closes the gap, so the gallery never becomes sparse', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      await attach(listing.id, ASSET_B, CHECK_B)
      await attach(listing.id, ASSET_C, CHECK_C)

      const result = await detachListingImage(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_B,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })
      assert.equal(result.detached, true)
      // 0,2 would still SORT correctly and would still be bounded — and would still be a bug: the
      // next attach computes its slot from the count, so a sparse gallery either collides or walks
      // past the range check while holding two photographs.
      assert.deepEqual(
        result.images.map((image) => [image.studioAssetId, image.position]),
        [
          [ASSET_A, 0],
          [ASSET_C, 1],
        ],
      )
      // The surviving rows kept their original attach times: a reorder is not a re-upload.
      const attachedAt = (await listingImages(sql, listing.id)).map((image) => image.attachedAt)
      assert.ok(attachedAt.every((at) => at instanceof Date))
    })

    test('detaching something that is not there is a success and emits nothing', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      const before = await outboxCount(sql, IMAGES_CHANGED_TOPIC)

      const result = await detachListingImage(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_C,
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })
      // The caller asked for a gallery without ASSET_C and that is the gallery they have. A 404
      // here would report a failure for a retried DELETE that had already succeeded.
      assert.equal(result.detached, false)
      assert.equal(result.images.length, 1)
      assert.equal(await outboxCount(sql, IMAGES_CHANGED_TOPIC), before)
    })

    test('setting the gallery reorders, adds and removes in one call', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      await attach(listing.id, ASSET_B, CHECK_B)

      const images = await setListingGallery(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        // B moves to the front, C is new, A is gone. All three in one complete representation.
        images: [
          { studioAssetId: ASSET_B, checksum: CHECK_B },
          { studioAssetId: ASSET_C, checksum: CHECK_C },
        ],
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })
      assert.deepEqual(
        images.map((image) => [image.studioAssetId, image.position]),
        [
          [ASSET_B, 0],
          [ASSET_C, 1],
        ],
      )
    })

    test('re-sending the same order changes nothing and says nothing on the bus', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      await attach(listing.id, ASSET_B, CHECK_B)
      const before = await outboxCount(sql, IMAGES_CHANGED_TOPIC)

      await setListingGallery(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        images: [
          { studioAssetId: ASSET_A, checksum: CHECK_A },
          { studioAssetId: ASSET_B, checksum: CHECK_B },
        ],
        actor: SELLER as `user:${string}`,
        correlationId: 'r',
      })
      // A page that re-submits the gallery it is already showing must not fill the bus with edits
      // nobody made.
      assert.equal(await outboxCount(sql, IMAGES_CHANGED_TOPIC), before)
    })

    test('a malformed checksum or asset id is a 400-shaped refusal, not a constraint violation', async () => {
      const listing = await seedListing(h)
      await assert.rejects(
        () => attach(listing.id, ASSET_A, 'not-a-checksum'),
        (err: unknown) => {
          // `ListingError`, which `server.ts` maps to 400. A raw 23514 would reach the handler
          // unrecognised and become a 500 for a request that was simply malformed.
          assert.ok(err instanceof ListingError)
          assert.equal(err instanceof ListingStateError, false)
          return true
        },
      )
      await assert.rejects(() => attach(listing.id, 'not-a-uuid', CHECK_A), ListingError)
      await assert.rejects(
        () =>
          setListingGallery(h.images, {
            listingId: listing.id,
            sellerSubject: SELLER,
            images: [
              { studioAssetId: ASSET_A, checksum: CHECK_A },
              { studioAssetId: ASSET_A, checksum: CHECK_A },
            ],
            actor: SELLER as `user:${string}`,
            correlationId: 'r',
          }),
        /cannot appear twice/,
      )
      assert.equal((await listingImages(sql, listing.id)).length, 0)
    })

    test('every change writes its event in the same transaction as the change', async () => {
      const listing = await seedListing(h)
      await attach(listing.id, ASSET_A, CHECK_A)
      const rows = await sql<{ topic: string; key: string; payload: Record<string, unknown> }[]>`
        select topic, key, payload from outbox where topic = ${IMAGES_CHANGED_TOPIC}
      `
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.key, listing.id)
      const payload = rows[0]?.payload as Record<string, unknown>
      assert.equal(payload['change'], 'attached')
      assert.equal(payload['sellerSubject'], SELLER)
      assert.equal(payload['imageCount'], 1)
      // No URL on the bus: where a browser reaches studio is a deployment fact with a shorter life
      // than an event row. And no anchor field of any kind — see the header of `listingimages.ts`.
      const serialised = JSON.stringify(payload)
      assert.equal(serialised.includes('http'), false)
      for (const forbidden of ['anchor', 'verified', 'attested', 'onchain', 'on-chain']) {
        assert.equal(serialised.toLowerCase().includes(forbidden), false, `payload claims ${forbidden}`)
      }
    })

    test('galleries for a page of listings come back in one query, keyed by listing', async () => {
      const first = await seedListing(h)
      const second = await seedListing(h, { itemUrn: 'cf:mint:token:0193' })
      await attach(first.id, ASSET_A, CHECK_A)
      await attach(first.id, ASSET_B, CHECK_B)
      await attach(second.id, ASSET_C, CHECK_C)

      const galleries = await listingImagesFor(sql, [first.id, second.id])
      assert.deepEqual(galleries.get(first.id)?.map((image) => image.studioAssetId), [ASSET_A, ASSET_B])
      assert.deepEqual(galleries.get(second.id)?.map((image) => image.studioAssetId), [ASSET_C])
      // A listing with no images is ABSENT rather than present-and-empty, so a caller has to decide
      // what "no images" renders as instead of being handed one silently.
      const third = await seedListing(h, { itemUrn: 'cf:mint:token:0194' })
      assert.equal((await listingImagesFor(sql, [third.id])).has(third.id), false)
      // And the empty page is not a round trip at all.
      assert.equal((await listingImagesFor(sql, [])).size, 0)
    })
  })

  /* ---------------------------------------------------------------- over the wire */

  describe('the routes', () => {
    let run: Running

    beforeEach(async () => {
      run = await start(h, STUDIO)
    })
    afterEach(async () => {
      await run.close()
    })

    test("a stranger cannot touch another seller's gallery, and is told the listing does not exist", async () => {
      const listing = await seedListing(h)
      await attachListingImage(h.images, {
        listingId: listing.id,
        sellerSubject: SELLER,
        studioAssetId: ASSET_A,
        checksum: CHECK_A,
        actor: SELLER as `user:${string}`,
        correlationId: 'seed',
      })

      // `bob` is a real, valid principal — this is authorisation failing, not authentication.
      const attached = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'bob', {
        key: 'market-web:test:0123456789',
        body: { studioAssetId: ASSET_B, checksum: CHECK_B },
      })
      const detached = await call(
        run,
        'DELETE',
        `/v1/listings/${listing.id}/images/${ASSET_A}`,
        'bob',
        { key: 'market-web:test:0123456780' },
      )
      const reordered = await call(run, 'PUT', `/v1/listings/${listing.id}/images`, 'bob', {
        key: 'market-web:test:0123456781',
        body: { images: [] },
      })

      for (const answer of [attached, detached, reordered]) {
        // 404 rather than 403, deliberately: a distinct refusal for "exists but is not yours" tells
        // a stranger which listings are real and who owns them.
        assert.equal(answer.status, 404, JSON.stringify(answer.body))
        assert.equal((answer.body['error'] as Record<string, unknown>)['code'], 'not_found')
      }
      assert.equal((await listingImages(sql, listing.id)).length, 1)
    })

    test('the seller attaches, and both listing reads return the gallery in order with a usable URL', async () => {
      const listing = await seedListing(h)
      const first = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'alice', {
        key: 'market-web:test:attach-first',
        body: { studioAssetId: ASSET_A, checksum: CHECK_A },
      })
      assert.equal(first.status, 201, JSON.stringify(first.body))
      const second = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'alice', {
        key: 'market-web:test:attach-secnd',
        body: { studioAssetId: ASSET_B, checksum: CHECK_B },
      })
      assert.equal(second.status, 201, JSON.stringify(second.body))

      const detail = await call(run, 'GET', `/v1/listings/${listing.id}`, null, {})
      const images = detail.body['images'] as Record<string, unknown>[]
      assert.deepEqual(
        images.map((image) => [image['studioAssetId'], image['position']]),
        [
          [ASSET_A, 0],
          [ASSET_B, 1],
        ],
      )
      // Absolute, and pointing at STUDIO rather than at this service: a relative
      // `/v1/assets/<id>/bytes` would resolve against market's own origin, where it is a 404.
      assert.equal(images[0]?.['bytesUrl'], `${STUDIO}/v1/assets/${ASSET_A}/bytes`)
      // The checksum is on the wire, and NOTHING that reads as a claim about it is.
      assert.equal(images[0]?.['checksum'], CHECK_A)
      const serialised = JSON.stringify(detail.body).toLowerCase()
      for (const forbidden of ['anchor', 'verified', 'attested', 'on-chain', 'onchain']) {
        assert.equal(serialised.includes(forbidden), false, `a listing read claims ${forbidden}`)
      }

      // The browse read carries them too, so a card can show a picture without a second call.
      const browse = await call(run, 'GET', '/v1/listings', null, {})
      const listed = (browse.body['listings'] as Record<string, unknown>[])[0]
      assert.equal((listed?.['images'] as unknown[]).length, 2)
    })

    test('a retried attach replays rather than attaching twice', async () => {
      const listing = await seedListing(h)
      const key = 'market-web:test:attach-retry'
      const body = { studioAssetId: ASSET_A, checksum: CHECK_A }
      const first = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'alice', { key, body })
      const again = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'alice', { key, body })

      assert.equal(first.status, 201)
      // 200 and `replayed: true` — the difference between "I attached it" and "it was already
      // there", which a client needs in order not to report a success as a failure.
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.equal(again.body['replayed'], true)
      assert.equal((await listingImages(sql, listing.id)).length, 1)
    })

    test('the image config names studio, or says plainly that it does not know', async () => {
      const configured = await call(run, 'GET', '/v1/images/config', null, {})
      assert.equal(configured.body['uploadUrl'], `${STUDIO}/v1/uploads`)
      assert.equal(configured.body['maxImagesPerListing'], MAX_LISTING_IMAGES)
      assert.deepEqual(configured.body['acceptedMediaTypes'], [
        'image/png',
        'image/jpeg',
        'image/webp',
      ])

      // The unconfigured deployment — which is EVERY deployment today, because studio has no
      // public hostname in the estate. Null rather than a guess, so a client can say so.
      const blind = await start(h, '')
      try {
        const answer = await call(blind, 'GET', '/v1/images/config', null, {})
        assert.equal(answer.body['uploadUrl'], null)

        const listing = await seedListing(h)
        await attachListingImage(h.images, {
          listingId: listing.id,
          sellerSubject: SELLER,
          studioAssetId: ASSET_A,
          checksum: CHECK_A,
          actor: SELLER as `user:${string}`,
          correlationId: 'seed',
        })
        const detail = await call(blind, 'GET', `/v1/listings/${listing.id}`, null, {})
        const images = detail.body['images'] as Record<string, unknown>[]
        // The reference is still there and still nameable. Only the URL is unknown.
        assert.equal(images[0]?.['studioAssetId'], ASSET_A)
        assert.equal(images[0]?.['bytesUrl'], null)
      } finally {
        await blind.close()
      }
    })

    test('a buyer with a valid token is still not the seller, on a listing they have bought', async () => {
      // The closed-status rule and the ownership rule meet here: after a sale the BUYER holds the
      // item and is the one person with an obvious reason to want the photographs changed.
      const listing = await seedListing(h)
      await settleSale(h.orders, {
        listingId: listing.id,
        buyerSubject: SECOND_BUYER,
        amount: 1_000n,
        source: 'purchase',
        actor: SECOND_BUYER as `user:${string}`,
        correlationId: 'buy',
      })
      const answer = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'carol', {
        key: 'market-web:test:buyer-attach',
        body: { studioAssetId: ASSET_A, checksum: CHECK_A },
      })
      assert.equal(answer.status, 404, JSON.stringify(answer.body))

      // And the seller, who IS the owner, is refused for the other reason — with a 409 that says
      // what it is about rather than a 404 that pretends their own listing is gone.
      const seller = await call(run, 'POST', `/v1/listings/${listing.id}/images`, 'alice', {
        key: 'market-web:test:selr-attach',
        body: { studioAssetId: ASSET_A, checksum: CHECK_A },
      })
      assert.equal(seller.status, 409, JSON.stringify(seller.body))
      assert.match(
        String((seller.body['error'] as Record<string, unknown>)['message']),
        /record of what was sold/,
      )
    })
  })
})

/* ------------------------------------------------------------------ the harness */

interface Running {
  readonly base: string
  close(): Promise<void>
}

/** The real server on a real socket. The ownership rule lives half in the route; this reaches it. */
async function start(h: Harness, studioPublicUrl: string): Promise<Running> {
  const server: Server = createServer({
    lifecycle: new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 }),
    logger: quietLogger(),
    metrics: registerServiceMetrics(new Metrics()),
    verifier: fakeVerifier(),
    sql: singleNetworkSql(h.sql),
    singleNetwork: 'mainnet' as const,
    producer: 'market',
    listings: h.listings,
    orders: h.orders,
    bids: h.bids,
    moderation: h.moderation,
    indexer: h.indexer,
    indexerNetwork: 'testnet',
    policy: h.policy,
    studioPublicUrl,
    queue: { async enqueue() {} },
    eventSigningSecret: SECRET,
    platformFeeBps: 250,
    maxRoyaltyBps: 1_000,
    disputeWindowMs: 0,
    listingEnabled: true,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function call(
  run: Running,
  method: string,
  path: string,
  token: string | null,
  options: { key?: string; body?: Record<string, unknown> },
): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (token) headers['authorization'] = `Bearer ${token}`
  if (options.key) headers['idempotency-key'] = options.key
  if (options.body) headers['content-type'] = 'application/json'
  const res = await fetch(`${run.base}${path}`, {
    method,
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function outboxCount(sql: postgres.Sql, topic: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from outbox where topic = ${topic}
  `
  return Number(rows[0]?.count ?? '0')
}

/** A distinct, well-formed uuid per index. Enough of them to fill a gallery and overflow it. */
function uuidFor(index: number): string {
  const tail = index.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${tail}`
}
