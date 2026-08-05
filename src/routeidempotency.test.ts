/**
 * Every mutating route either replays a retry or has a documented reason not to.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST. `POST /v1/orders/:id/disputes` was a plain INSERT with no
 * natural key and no route wrapper, so a double-clicked button — or any client retrying a request
 * whose response it never saw — opened TWO disputes on one order and froze the listing twice.
 * `POST /v1/moderation/cases` had the same shape. Both sat beside four sibling routes that wrap
 * correctly, and nothing noticed, because the domain tests call `openDispute` directly and never
 * traverse the route.
 *
 * Found by micro-sdk, cataloguing which public routes require an `Idempotency-Key`. The answer for
 * these two was "none", and the SDK could not have known that was a mistake rather than a design.
 *
 * So this asserts the *shape of the file* rather than behaviour, deliberately: the defect is an
 * omission, and an omission has no behaviour to test. A route added tomorrow without a wrapper
 * fails here, and the author must either wrap it or write down why it does not need one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8')

/**
 * Mutating routes that are safe WITHOUT the wrapper, each with the reason it is safe. A route is
 * only exempt if retrying it a second time cannot produce a second artefact.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'POST /v1/events':
    'the inbox, deduplicated on source_event_id — its idempotency is the whole point of the table',
  'POST /v1/collections':
    'collections_slug_uniq (migrations.ts:154) makes a retry a conflict, not a duplicate',
  'POST /v1/listings/:id/activate':
    'a state transition claimed with `where status = ...`; the second attempt matches no row',
  'DELETE /v1/listings/:id': 'DELETE is idempotent by definition',
  'DELETE /v1/listings/:id/images/:assetId':
    'DELETE is idempotent by definition — and `detachListingImage` answers 200 with `detached: false` for an image that was already gone, so a retry reports success rather than a 404 for work that succeeded',
  'DELETE /v1/offers/:id': 'DELETE is idempotent by definition',
  'PUT /v1/listings/:id/images':
    'a PUT of the COMPLETE gallery: the same ordering sent twice leaves the same gallery, and `setListingGallery` emits nothing when the resulting order is unchanged, so a retry is not even an event',
  'POST /v1/disputes/:id/resolve': 'a state transition claimed on the dispute\'s current state',
  'POST /v1/moderation/cases/:id/resolve': 'a state transition claimed on the case\'s current state',
}

function mutatingRoutes(): Array<{ key: string; wrapped: boolean }> {
  const out: Array<{ key: string; wrapped: boolean }> = []
  const re = /define\('(POST|PUT|PATCH|DELETE)', '([^']+)'/g
  const starts: Array<{ key: string; at: number }> = []
  for (let m = re.exec(SERVER); m !== null; m = re.exec(SERVER)) {
    starts.push({ key: `${m[1]} ${m[2]}`, at: m.index })
  }
  const all = [...SERVER.matchAll(/define\('[A-Z]+', '[^']+'/g)].map((m) => m.index ?? 0)
  for (const s of starts) {
    const next = all.find((i) => i > s.at) ?? SERVER.length
    out.push({ key: s.key, wrapped: SERVER.slice(s.at, next).includes('withIdempotentRoute') })
  }
  return out
}

test('every mutating route replays a retry, or says why it need not', () => {
  const unexplained = mutatingRoutes()
    .filter((r) => !r.wrapped && !(r.key in EXEMPT))
    .map((r) => r.key)
  assert.deepEqual(
    unexplained,
    [],
    `these mutating routes neither wrap withIdempotentRoute nor appear in EXEMPT:\n  ${unexplained.join('\n  ')}\n` +
      'A retried request must not create a second artefact. Wrap it, or add it to EXEMPT with the reason it is safe.',
  )
})

test('the two routes this file exists for are wrapped', () => {
  const byKey = new Map(mutatingRoutes().map((r) => [r.key, r.wrapped]))
  assert.equal(byKey.get('POST /v1/orders/:id/disputes'), true, 'a retry must not open a second dispute')
  assert.equal(byKey.get('POST /v1/moderation/cases'), true, 'a retry must not open a second case')
})

test('the checker sees the routes at all', () => {
  // An empty list passes the first test vacuously. This is the line that stops that.
  const routes = mutatingRoutes()
  assert.ok(routes.length >= 10, `expected the server to have many mutating routes, found ${routes.length}`)
  assert.ok(routes.some((r) => r.wrapped), 'no route was detected as wrapped — the detector is broken')
})

test('every wrapped route scopes its key to the AUTHENTICATED caller', () => {
  // The type system already refuses a call with no principal — the parameter is required. What it
  // cannot refuse is the WRONG principal: `subjectOf` is also applied to listing owners and offer
  // makers a few lines away in three of these handlers, and a route that scoped its key to the
  // SELLER of the listing being bought would compile, pass every behavioural test written from one
  // caller's point of view, and put two buyers back in one namespace.
  //
  // So this pins the argument as written: the third argument is the `principal` this handler
  // authenticated, and nothing else.
  // `(\w+)` rather than `([^,]+)`: the declaration a few hundred lines below spreads its typed
  // parameters over several lines, and a looser pattern matches the declaration as well as the
  // calls and then fails on its own signature.
  const calls = [...SERVER.matchAll(/withIdempotentRoute\((\w+), (\w+), (\w+),/g)]
  assert.ok(calls.length >= 7, `expected every wrapped route to be found, saw ${calls.length}`)
  for (const call of calls) {
    assert.deepEqual(
      [call[1], call[2], call[3]],
      ['ctx', 'deps', 'principal'],
      `a wrapped route is keyed on ${call[3]} rather than on the caller it authenticated`,
    )
  }
})

test('no exemption is stale', () => {
  // An exemption for a route that no longer exists is a claim nobody is checking, and it hides the
  // day that route comes back without a wrapper.
  const keys = new Set(mutatingRoutes().map((r) => r.key))
  for (const k of Object.keys(EXEMPT)) {
    assert.ok(keys.has(k), `EXEMPT names ${k}, which is not a route on this server any more`)
  }
})
