/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
const REQUIRED: Record<string, string> = {
  MARKET_DATABASE_URL: 'postgres://market:market@127.0.0.1:5432/market',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'a-real-looking-secret-of-sufficient-length',
  LEDGER_URL: 'http://127.0.0.1:4007',
  INDEXER_URL: 'http://127.0.0.1:4008',
  POLICY_URL: 'http://127.0.0.1:4010',
}

/**
 * **`MARKET_SERVICE_TOKEN` used to be in the block above, and taking it out is the fix, not a
 * relaxation.**
 *
 * It is a token with a hard-coded 600-second life (`identity/src/tokens.ts:33`) that nothing can
 * renew. Requiring it kept a BOOT DEPENDENCY on the thing being retired: a container given the
 * long-lived `MARKET_IDENTITY_CREDENTIAL` and no token is correctly configured, and refusing to
 * start it would be this service insisting on its own defect. The tests below hold the replacement
 * contract instead — either may be absent, both may be absent, and each is still checked for
 * placeholder and length when it is present.
 */
/** Fabricated. The shape identity issues, none of the entropy — never a value from tokens.env. */
const CREDENTIAL = 'cfsc_0000000000000000000000000000000000000test'
const STATIC_TOKEN = 'a-real-looking-token-of-sufficient-length'

for (const [key, value] of Object.entries(REQUIRED)) process.env[key] = value

const { BPS_SCALE, EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

const withEnv = (overrides: Record<string, string | undefined> = {}) => ({
  ...REQUIRED,
  ...overrides,
})

test('the eager export validated the process environment at import', () => {
  // If it had not, this file would have exited with a structured fatal line before reaching here.
  assert.equal(env.databaseUrl, REQUIRED['MARKET_DATABASE_URL'])
})

test('the service name is a constant, not a variable', () => {
  // Making it configurable is how two services end up sharing a migration advisory lock.
  assert.equal(SERVICE, 'market')
})

test('a complete environment loads', () => {
  const env = loadEnv(withEnv(), 'host-1')
  assert.equal(env.databaseUrl, REQUIRED['MARKET_DATABASE_URL'])
  assert.equal(env.instanceId, 'host-1')
  assert.equal(env.port, 4_000)
})

for (const name of Object.keys(REQUIRED)) {
  test(`${name} is required and the error names it`, () => {
    assert.throws(() => loadEnv(withEnv({ [name]: undefined })), (err: unknown) => {
      assert.ok(err instanceof EnvError)
      // A missing variable must name itself. `undefined` propagating into a connection string
      // surfaces four layers later as an unreadable driver error.
      assert.match(err.message, new RegExp(name))
      return true
    })
  })
}

test('a known placeholder secret is refused outright', () => {
  // A placeholder that boots is a placeholder that reaches production.
  for (const placeholder of ['changeme', 'CHANGE_ME', 'placeholder', 'dev-secret']) {
    assert.throws(() => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: placeholder })), EnvError)
  }
})

test('a short secret is refused — length is the only entropy proxy available', () => {
  assert.throws(() => loadEnv(withEnv({ MARKET_SERVICE_TOKEN: 'hunter2' })), /at least 24/)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CREDENTIAL. See the `identityCredential` docblock in `env.ts` for the seventeen hours.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('neither credential nor token is required to BOOT — being loudly wrong beats not running', () => {
  // This is the change. Requiring `MARKET_SERVICE_TOKEN` kept a boot dependency on a 600-second
  // token that nothing can renew, so a container configured correctly for the fix would have
  // refused to start. `upstreams.ts` reports `none` and `index.ts` says so at `fatal`; the absence
  // is explicit, not silent, which is the property that matters.
  const env = loadEnv(withEnv())
  assert.equal(env.identityCredential, null)
  assert.equal(env.serviceToken, null)
})

test('the credential is read, and it is the field `upstreams.ts` prefers', () => {
  const env = loadEnv(withEnv({ MARKET_IDENTITY_CREDENTIAL: CREDENTIAL }))
  assert.equal(env.identityCredential, CREDENTIAL)
  assert.equal(env.serviceToken, null)
})

test('both may be set, which is the state a rolling deploy is actually in', () => {
  const env = loadEnv(
    withEnv({ MARKET_IDENTITY_CREDENTIAL: CREDENTIAL, MARKET_SERVICE_TOKEN: STATIC_TOKEN }),
  )
  assert.equal(env.identityCredential, CREDENTIAL)
  assert.equal(env.serviceToken, STATIC_TOKEN)
})

test('an empty string is an ABSENT credential, not a present one', () => {
  // `MARKET_IDENTITY_CREDENTIAL: ${MARKET_IDENTITY_CREDENTIAL:-}` in the compose expands to empty
  // when the variable is unset, so this is the literal value a real deployment passes. Reading it
  // as present would construct a provider around nothing and throw out of the composition root.
  assert.equal(loadEnv(withEnv({ MARKET_IDENTITY_CREDENTIAL: '' })).identityCredential, null)
  assert.equal(loadEnv(withEnv({ MARKET_SERVICE_TOKEN: '   ' })).serviceToken, null)
})

test('A SERVICE TOKEN PASTED INTO THE CREDENTIAL IS REFUSED BY NAME', () => {
  // The single most likely mistake while this rolls out: both are opaque strings from identity,
  // both authenticate, and a token here would work for ten minutes and then reproduce the exact
  // defect this variable exists to remove. The error names the variable and never quotes it.
  assert.throws(
    () => loadEnv(withEnv({ MARKET_IDENTITY_CREDENTIAL: STATIC_TOKEN })),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match(err.message, /MARKET_IDENTITY_CREDENTIAL/)
      assert.match(err.message, /cfsc_/)
      assert.ok(!err.message.includes(STATIC_TOKEN), 'the error quoted the secret back')
      return true
    },
  )
})

test('the credential is held to the placeholder and length rules like any other secret', () => {
  assert.throws(() => loadEnv(withEnv({ MARKET_IDENTITY_CREDENTIAL: 'changeme' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ MARKET_IDENTITY_CREDENTIAL: 'cfsc_short' })), /at least 24/)
})

test('IDENTITY_URL defaults to the issuer, because that is where a token came from', () => {
  // So a deployment that already names the issuer needs no new URL to get the fix.
  assert.equal(loadEnv(withEnv()).identityUrl, REQUIRED['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv(withEnv({ IDENTITY_URL: 'http://identity:4000' })).identityUrl,
    'http://identity:4000',
  )
})

test('LOG_LEVEL is a closed set', () => {
  assert.equal(loadEnv(withEnv({ LOG_LEVEL: 'debug' })).logLevel, 'debug')
  assert.throws(() => loadEnv(withEnv({ LOG_LEVEL: 'verbose' })), EnvError)
})

test('PORT must be a whole number in range', () => {
  assert.equal(loadEnv(withEnv({ PORT: '8080' })).port, 8_080)
  assert.throws(() => loadEnv(withEnv({ PORT: '0' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ PORT: '70000' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ PORT: '80.5' })), EnvError)
})

test('the platform fee and the maximum royalty are checked AGAINST EACH OTHER at boot', () => {
  // The whole point of the check: if the two ceilings can together reach 100%, a listing at the
  // royalty maximum settles for a seller's proceeds of zero, and one basis point past it for a
  // negative number the ledger refuses AFTER the buyer's funds have been claimed.
  assert.throws(
    () =>
      loadEnv(withEnv({ MARKET_PLATFORM_FEE_BPS: '5000', MARKET_MAX_ROYALTY_BPS: '5000' })),
    /must sum to less than 10000/,
  )
  const ok = loadEnv(withEnv({ MARKET_PLATFORM_FEE_BPS: '4999', MARKET_MAX_ROYALTY_BPS: '5000' }))
  assert.equal(ok.platformFeeBps + ok.maxRoyaltyBps, 9_999)
})

test('the defaults leave the seller most of the sale', () => {
  const env = loadEnv(withEnv())
  assert.equal(env.platformFeeBps, 250)
  assert.equal(env.maxRoyaltyBps, 1_000)
  assert.ok(env.platformFeeBps + env.maxRoyaltyBps < BPS_SCALE)
})

test('a zero dispute window is permitted — it is a business choice, not a mistake', () => {
  assert.equal(loadEnv(withEnv({ MARKET_DISPUTE_WINDOW_MS: '0' })).disputeWindowMs, 0)
})

test('the dispute window defaults to 24 hours and is capped at 30 days', () => {
  assert.equal(loadEnv(withEnv()).disputeWindowMs, 86_400_000)
  assert.throws(() => loadEnv(withEnv({ MARKET_DISPUTE_WINDOW_MS: '999999999999' })), EnvError)
})

test('anti-sniping defaults to two minutes and can be switched off', () => {
  assert.equal(loadEnv(withEnv()).auctionExtensionMs, 120_000)
  assert.equal(loadEnv(withEnv({ MARKET_AUCTION_EXTENSION_MS: '0' })).auctionExtensionMs, 0)
})

test('MARKET_LISTING_ENABLED is a boolean and refuses anything else', () => {
  assert.equal(loadEnv(withEnv()).listingEnabled, true)
  assert.equal(loadEnv(withEnv({ MARKET_LISTING_ENABLED: 'false' })).listingEnabled, false)
  assert.equal(loadEnv(withEnv({ MARKET_LISTING_ENABLED: '0' })).listingEnabled, false)
  assert.throws(() => loadEnv(withEnv({ MARKET_LISTING_ENABLED: 'maybe' })), EnvError)
})

test('INSTANCE_ID falls back to the hostname, then to "unknown"', () => {
  assert.equal(loadEnv(withEnv(), 'pod-7').instanceId, 'pod-7')
  assert.equal(loadEnv(withEnv({ INSTANCE_ID: 'named' }), 'pod-7').instanceId, 'named')
  assert.equal(loadEnv(withEnv(), '').instanceId, 'unknown')
})

test('this service reads exactly one database variable', () => {
  // Rule 1, asserted in a test as well as in CI. The answer to needing another service's data is
  // an HTTP call typed by a published contract, never a second DSN.
  // The foreign variable used to be assembled from parts here rather than written out, because
  // `micro-org`'s rule-1 check scanned test files too and could not tell a variable this service
  // READS from one a test proves it IGNORES — so spelling it failed the build that this very test
  // agrees with. The check now excludes tests, as its sibling hard-coded-DSN check always did, so
  // the name is written plainly and the assertion says what it means.
  const source = withEnv({ LEDGER_DATABASE_URL: 'postgres://elsewhere/ledger' })
  const env = loadEnv(source)
  assert.equal(env.databaseUrl, REQUIRED['MARKET_DATABASE_URL'])
  assert.ok(!Object.values(env).includes('postgres://elsewhere/ledger'))
})

test('the pool size is bounded', () => {
  assert.equal(loadEnv(withEnv({ MARKET_DATABASE_POOL_MAX: '25' })).databasePoolMax, 25)
  assert.throws(() => loadEnv(withEnv({ MARKET_DATABASE_POOL_MAX: '0' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ MARKET_DATABASE_POOL_MAX: '1000' })), EnvError)
})

test('the upstream deadline is bounded on both sides', () => {
  assert.equal(loadEnv(withEnv()).upstreamDeadlineMs, 5_000)
  assert.throws(() => loadEnv(withEnv({ MARKET_UPSTREAM_DEADLINE_MS: '10' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ MARKET_UPSTREAM_DEADLINE_MS: '600000' })), EnvError)
})
