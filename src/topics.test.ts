/**
 * The producer half of the bus contract, checked against the source rather than against a list.
 *
 * Two families of check, for the two shapes one defect class has already taken in this estate:
 *
 *   1. **The name.** `wallet` emitted `wallet.deposit.credited` for the life of the service while
 *      the registry, `notify` and `activity` all spelled it `wallet.deposit.confirmed`. Nothing
 *      could ever match it. Reconciling the emitted set with the registry in BOTH directions is
 *      what catches that, and reading the literals back out of `src/` is what stops the check
 *      agreeing with itself while the emit sites drift.
 *   2. **The envelope.** Six producers stamped `version` as the integer `1` where the contract
 *      types it `"major.minor"`, so `validateEnvelope` refused every event they ever relayed with
 *      "version: missing". Every suite in the estate was green throughout, because both sides
 *      tested against imagined counterparts. The only check that could have caught it is the one
 *      below: build an envelope with the relay's own `buildEnvelope` and hand it to the contract's
 *      own `classifyEnvelope`.
 *
 * No database. Pure text, set arithmetic and one function call, so it runs in CI even when the
 * database-backed suite skips.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SIGNATURE_HEADER,
  TOPIC_NAMES,
  isRegisteredTopic,
  parseVersion,
  topicsProducedBy,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { buildEnvelope, signEvent } from './outbox.ts'
import {
  AWAITING_REGISTRATION,
  EMITTED_TOPICS,
  SERVICE,
  adoptedProposals,
  envelopeDefects,
  malformedProposals,
  undeclaredTopics,
  unemittedOwnedTopics,
} from './topics.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'testsupport.ts')
    .map((file) => join(SRC, file))
}

/**
 * The files a topic literal may legitimately appear in.
 *
 * `topics.ts` is excluded, and that exclusion is the whole check rather than a convenience: it is
 * the file holding `EMITTED_TOPICS` and the quarantine, and it is the thing being checked. Scanning
 * it would let a quarantine entry justify its own existence — a topic could be declared,
 * quarantined and never emitted, and every assertion below would still agree.
 */
function emitSourceFiles(): readonly string[] {
  return sourceFiles().filter((file) => !file.endsWith('/topics.ts'))
}

/**
 * Every topic literal in this service's namespace that appears anywhere in `src/`.
 *
 * Not `topic: '<name>'`, as identity's equivalent matches: this service names its topics through
 * exported constants (`SOLD_TOPIC = 'market.listing.sold'`), so a scan for the emit-site shape
 * would find nothing at all and pass vacuously. Matching every well-formed `market.*.*` string
 * literal finds both spellings, and it is the one that also catches a CONSTANT that no emit site
 * uses — which is how `market.order.refunded` was found: declared, exported, never emitted, and a
 * name a consumer could have subscribed to for ever.
 *
 * Comment lines are skipped, and that is load-bearing rather than tidy: `outbox.ts` carries a
 * worked `emit({ topic: 'market.listing.sold' … })` example in its header, and counting it would
 * report a topic no code path produces.
 *
 * `action:` and `scope:` lines are skipped for a sharper reason: the policy vocabulary shares this
 * namespace. `policyclient.ts` asks policy about `market.listing.create`, which is a permission
 * and not a topic — three lowercase segments and never emitted by anything.
 */
function topicsInSource(): readonly string[] {
  const found = new Set<string>()
  const literal = new RegExp(`'(${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+)'`, 'g')
  for (const file of emitSourceFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (/\b(?:action|scope|resource|permission)\s*:/.test(line)) continue
      for (const match of line.matchAll(literal)) if (match[1]) found.add(match[1])
    }
  }
  return [...found].sort()
}

/* ------------------------------------------------------------------ the names */

test('the source emits exactly the topics this service declares', () => {
  // Both halves of the drift: a literal `src/` spells that EMITTED_TOPICS does not list, and an
  // entry in EMITTED_TOPICS that no literal backs. The second half is what stops the list being
  // repaired by editing the list.
  assert.deepEqual(
    topicsInSource(),
    [...EMITTED_TOPICS].sort(),
    'src/ and EMITTED_TOPICS disagree about what this service puts on the bus',
  )
})

test('every topic this service emits is one the estate has a name for', () => {
  assert.deepEqual(
    undeclaredTopics(topicsInSource()),
    [],
    'emitted, but in neither the registry nor AWAITING_REGISTRATION — decide which, then say so',
  )
})

test('every registry topic this service owns is actually emitted', () => {
  // The feature-that-can-never-fire direction, and the one that fails silently in production:
  // consumers classify the topic, the code path renders it, and nothing ever arrives.
  assert.deepEqual(
    unemittedOwnedTopics(topicsInSource()),
    [],
    'the registry says market produces these and no emit site does — every consumer of each is dead code',
  )
  // And the registry is being read rather than the check passing vacuously.
  assert.ok(topicsProducedBy(SERVICE).length >= 1)
  assert.ok(TOPIC_NAMES.length >= 40)
})

test('a pending proposal disappears once contracts adopts it', () => {
  // Without this the quarantine becomes a permanent allow-list: the topic gets registered, the
  // entry stays, and the next reader believes the topic is still unregistered.
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
  // market.listing.sold IS registered, and must therefore NOT be quarantined.
  assert.equal(isRegisteredTopic('market.listing.sold'), true)
  assert.equal(Object.hasOwn(AWAITING_REGISTRATION, 'market.listing.sold'), false)
  // And the one this mechanism actually emptied, pinned from both ends so a re-add is caught by a
  // named assertion rather than only by the generic sort above. `micro-contracts` 5e0d11a.
  assert.equal(isRegisteredTopic('market.offer.made'), true)
  assert.equal(Object.hasOwn(AWAITING_REGISTRATION, 'market.offer.made'), false)
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a well-formed market topic, a real ordering key, and a reason worth reading',
  )
})

test('the topic that was declared and never emitted stays gone', () => {
  // `market.order.refunded` was a constant with no emit site. The fact lives on
  // `market.dispute.resolved` with `resolution: 'refunded'`, which IS emitted.
  assert.ok(!topicsInSource().includes('market.order.refunded'))
  assert.ok(topicsInSource().includes('market.dispute.resolved'))
})

/* ------------------------------------------------------------------ the envelope */

const ROW = {
  id: '018f0000-0000-7000-8000-0000000000a1',
  topic: 'market.listing.sold',
  key: '018f0000-0000-7000-8000-0000000000b1',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: SERVICE,
  version: 1,
  actor: 'user:018f0000-0000-7000-8000-0000000000c1',
  correlation_id: 'req-1',
  payload: { orderId: 'o-1' },
}

test('THE RULE: the envelope this relay builds is one the contract accepts', () => {
  // The check whose absence let six producers relay nothing but refusals. `validateEnvelope` is
  // the contract's own function and is literally what activity/src/ingest.ts and notify run on a
  // delivered body — not a restatement of it here.
  for (const topic of topicsInSource()) {
    const envelope = buildEnvelope({ ...ROW, topic })
    assert.deepEqual(
      envelopeDefects(JSON.parse(JSON.stringify(envelope))),
      [],
      `an event on ${topic} would be refused by every consumer in the estate`,
    )
  }
})

test('the version on the wire is "major.minor", never the stored integer', () => {
  const envelope = buildEnvelope(ROW)
  // The specific defect, named, so a reader of a failure knows what broke.
  assert.equal(typeof envelope.version, 'string')
  assert.equal(envelope.version, '1.0')
  assert.equal(parseVersion(envelope.version).ok, true)
  assert.equal(parseVersion(String(ROW.version)).ok, false, 'the stored integer is NOT a wire version')
})

test('a row with no actor and no correlation id still makes a readable envelope', () => {
  // Both columns are nullable and both are refused by the contract if they arrive null. The
  // fallbacks are the contract's own semantics: a service actor, and an event that is its own
  // correlation root.
  const envelope = buildEnvelope({ ...ROW, actor: null, correlation_id: null })
  assert.equal(envelope.actor, 'service:market')
  assert.equal(envelope.correlationId, ROW.id)
  assert.deepEqual(envelopeDefects(JSON.parse(JSON.stringify(envelope))), [])
})

test('envelopeDefects excuses a lagging registry and nothing else', () => {
  // The tolerance is narrow on purpose. An unregistered topic this repository has explained is a
  // consumer being behind its producers; anything else is this service emitting the unreadable.
  const quarantined = buildEnvelope({ ...ROW, topic: 'market.bid.placed' })
  assert.deepEqual(envelopeDefects(JSON.parse(JSON.stringify(quarantined))), [])

  // An unregistered topic the quarantine does NOT explain is not excused.
  const unexplained = { ...buildEnvelope(ROW), topic: 'market.nothing.happened' }
  assert.ok(envelopeDefects(unexplained).length > 0)

  // And a real envelope defect is never excused, even on a quarantined topic.
  const broken = { ...quarantined, version: 1 as unknown as string }
  assert.ok(
    envelopeDefects(broken).some((error) => error.startsWith('version:')),
    'an integer version must be reported however the topic is registered',
  )
})

/**
 * The case that separates this repository's `envelopeDefects` from the contract's own
 * `envelopeDefects(value, awaitingRegistration)`, which ships beside `classifyEnvelope` and looks
 * like a drop-in for it.
 *
 * "Malformed" and "not in this registry" are two facts with two remedies — a producer bug, and a
 * missing registration — and an envelope can carry both. `classifyEnvelope` keeps both, deliberately
 * (`unregisteredTopic` survives on a `malformed` verdict). The contract's flattening wrapper drops
 * the topic whenever any other defect is present, so the author is sent to fix one thing twice.
 *
 * Every other assertion in this suite stays green under that wrapper. This is the only one that
 * would go red, which is the point of writing it.
 */
test('an unproposed topic AND a broken version are reported together, not one per round', () => {
  const both = {
    ...buildEnvelope(ROW),
    topic: 'market.nothing.happened',
    version: 1 as unknown as string,
  }
  const defects = envelopeDefects(both)
  assert.ok(
    defects.some((error) => error.startsWith('version:')),
    `the producer bug must be named: ${defects.join('; ')}`,
  )
  assert.ok(
    defects.some((error) => error.includes('market.nothing.happened')),
    `the missing registration must be named too: ${defects.join('; ')}`,
  )
})

test('the delivery this relay signs is one a contract-following consumer verifies', () => {
  // The other half of the same story: the header name and the signature scheme are the contract's
  // too. Five producers carried drifted local copies (`x-cloudsforge-signature`, `sha256=<hmac>`)
  // and every delivery to activity or notify was refused as "signature: missing".
  const body = JSON.stringify(buildEnvelope(ROW))
  const secret = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'
  assert.equal(SIGNATURE_HEADER, 'cf-signature')
  const verification = verifyDelivery(body, signEvent(body, secret), [secret])
  assert.equal(verification.ok, true)
})

/* ------------------------------------------------------------------ reachability */

/**
 * A guard that proves a topic name is correct proves nothing about whether the emit is reached.
 *
 * `identity/src/sessions.ts` exports `emitSessionRevoked` and NOTHING CALLS IT — `revokeSession`
 * and `revokeAllSessions` update rows without emitting — so `identity.session.revoked` is produced
 * by dead code while identity's own guard passes, because it scans literals rather than
 * reachability. This is the cheapest check that catches that exact shape.
 *
 * The detector is exercised on a fixture FIRST. A repository with no exported emitter would
 * otherwise get a green from a scan that finds nothing because it is broken, which is precisely
 * the "check that cannot fail" this estate keeps rediscovering.
 */
function unreachedEmitters(files: readonly { name: string; text: string }[]): readonly string[] {
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = /^export (?:async )?function (emit[A-Za-z0-9_]*)/.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (/^export (?:async )?function /.test(trimmed)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unreachable-emitter detector can actually fail', () => {
  // identity's defect, reproduced in miniature. Without this the assertion below is worth nothing
  // in a repository whose emit sites are all inline.
  const dead = [{ name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' }]
  assert.deepEqual(unreachedEmitters(dead), ['emitSessionRevoked (sessions.ts:1)'])

  const alive = [
    { name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' },
    { name: 'server.ts', text: 'emitSessionRevoked()\n' },
  ]
  assert.deepEqual(unreachedEmitters(alive), [])
})

test('every exported emitter is reached from somewhere', () => {
  assert.deepEqual(
    unreachedEmitters(sourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'exported, emits an event, and no code path reaches it — the topic is produced by dead code',
  )
})
