/**
 * **THE MODERATION GATE AND THE TEN-MINUTE TOKEN, DRIVEN PAST THE EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect, as measured rather than as reasoned about
 *
 * `MARKET_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The composition root read it once, at import — `const token = () => env.serviceToken` — and
 * handed that to the ledger, the indexer and policy. On the live estate the token inside
 * `cloudsforge-estate-market-1` had been expired for **63,056 seconds** — seventeen and a half
 * hours — while the container served normally. Presenting it to policy from inside that container
 * returned `401 {"error":{"code":"unauthenticated",...}}`, and a real seller listing came back 201
 * with `policy: {decision:"review", reasons:["policy_unavailable"], degraded:true}`.
 *
 * ## Why the visible symptom was nothing at all
 *
 * `policyclient.ts` is correct and stays correct: a 401 is policy refusing US, not policy
 * judging the listing, so it degrades rather than denying. That is what stops a seller being told
 * they are banned by our own misconfiguration. It is also what made this invisible — the
 * marketplace kept working, and **every listing on it went up with no moderation decision ever
 * made**. The header of `policyclient.ts` names that as the worst of the three outcomes: not a
 * degraded gate, an absent one, with the evidence flag firing on every listing so that it means
 * nothing.
 *
 * So the assertion this file is built around is not "the call did not throw". It is
 * **`degraded === false`** — policy was actually asked, and actually answered.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They build their own client, or use `fakePolicy`, and do it a millisecond later. **A test that
 * mints a token and immediately uses it proves nothing about this defect** — the token is never
 * asked to survive its own lifetime, and at the speed of a test a hard-coded string and a live
 * credential are indistinguishable. `policyclient.test.ts` beside this file is green against a
 * `fetch` that never reads a header. That is the property this file removes: below, the clock moves
 * **ELEVEN MINUTES** past a token the process already holds, that token is shown to be refused **by
 * a real `Verifier`**, and only then is the listing decision asked for again.
 *
 * ## The assertion that stops this file being green for the wrong reason
 *
 * `authorizedFetch` re-mints and replays on a 401. So a completely broken refresh SCHEDULE would
 * still end in a real verdict — one 401, one re-mint, one replay — and a test that only checked the
 * verdict would pass over it. The post-expiry case therefore asserts **zero 401s**: the token must
 * have been refreshed on schedule, before it was ever presented. `EIGHT HOURS` then lists
 * thirty-two times across a whole shift and holds the same bar.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `httpPolicyClient`, `httpLedgerClient`, a real `Verifier` and jose's own expiry arithmetic.
 *     The verdicts below come back through the real client's real parsing.
 *   * **Simulated**: the clock, and the two peers' transports. `mock.timers` moves `Date` only, so
 *     jose decides expiry from the same instant the provider schedules against — nothing here
 *     decides expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `httpPolicyClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS SERVICE
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `token: () => env.serviceToken` turns the first two tests below red — and `BASELINE` models that
 * exact old seam, against the same fixtures, so this file also demonstrates the failure it fixes.
 *
 * No database. Nothing here touches a table, so it runs wherever `node --test` does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'
import { LEDGER_SCOPES } from './ledgerclient.ts'
import { POLICY_SCOPES, type ListingPolicyInput } from './policyclient.ts'

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const POLICY = 'http://policy:4000'
const LEDGER = 'http://ledger:4000'
const INDEXER = 'http://indexer:4000'

/** Fabricated: identity's shape, none of its entropy. Never a value out of `tokens.env`. */
const CREDENTIAL = 'cfsc_0000000000000000000000000000000000000test'

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged — rotation IS expiry. */
const SERVICE_TTL_SECONDS = 600

/** What this service actually demands of its own token, read from the files that declare it. */
const SCOPES = [...POLICY_SCOPES, ...LEDGER_SCOPES] as readonly string[]

/** Well in the past, and fixed, so nothing here depends on the day it is run. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

afterEach(() => mock.timers.reset())

const LISTING: ListingPolicyInput = {
  sellerSubject: 'user:11111111-1111-4111-8111-111111111111',
  assetKind: 'collectible',
  itemUrn: 'cf:mint:item:0192',
  amount: '250000',
  assetCode: 'EMBER',
  settlementMode: 'custodial',
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY AND A REAL POLICY, in the sense that matters.
 *
 * Identity signs RS256 tokens with a 600-second expiry against the simulated clock. Policy hands
 * whatever it is given to a real `Verifier`, checks `policy:decide` off the verified principal, and
 * answers 401 when jose says the token is bad — which is what the live estate's policy did.
 * Nothing decides expiry by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

interface Call {
  readonly peer: 'policy' | 'ledger'
  readonly token: string | null
  readonly status: number
}

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  calls: Call[]
  consecutive401: number
  /** A pre-minted token valid at `T0` that cannot be renewed. The defect's input. */
  readonly staticToken: string
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * The case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this process
   * believes is fresh which policy rejects anyway — clock skew between the two, a credential
   * revoked mid-flight, a process paused between reading the token and sending it.
   */
  refuseNextBearer: boolean
}

async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const keySet = (async () => publicKey) as never
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet })

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated
  // instant are the same string. identity mints a uuidv7 jti per token; the counter restores that,
  // and without it "the service minted a genuinely new token" could not be asserted at all.
  let jti = 0
  const mint = (issuedAtMs: number): Promise<string> =>
    new SignJWT({ typ: 'service', scopes: SCOPES, jti: `t-${++jti}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt(Math.floor(issuedAtMs / 1000))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('service:market')
      .setExpirationTime(Math.floor(issuedAtMs / 1000) + SERVICE_TTL_SECONDS)
      .sign(privateKey)

  const staticToken = await mint(T0)

  const self: World = {
    exchanges: 0,
    calls: [],
    consecutive401: 0,
    staticToken,
    refuseNextBearer: false,

    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        return new Response(
          JSON.stringify({
            token: await mint(Date.now()),
            service: 'market',
            scopes: SCOPES,
            expiresIn: SERVICE_TTL_SECONDS,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      const peer: 'policy' | 'ledger' = url.startsWith(POLICY) ? 'policy' : 'ledger'
      const need = peer === 'policy' ? 'policy:decide' : 'ledger:post'

      // The loop guard counts CONSECUTIVE refusals rather than total calls, because
      // `authorizedFetch` re-mints and replays exactly once on a 401 — a fault would show as an
      // unbroken run of them, while a cap on the total would be a cap on how many listings a test
      // may drive, which is the wrong quantity entirely.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping')

      const presented =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      const refuse = (status: number): Response => {
        self.consecutive401 += 1
        self.calls.push({ peer, token: presented, status })
        return new Response(
          '{"error":{"code":"unauthenticated","message":"a valid bearer token is required"}}',
          { status },
        )
      }

      if (presented === null) return refuse(401)
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false
        return refuse(401)
      }
      try {
        const principal = await verifier.principal(presented)
        if (principal.kind !== 'service' || !principal.scopes.includes(need)) return refuse(403)
      } catch {
        // jose refused it: expired, or not signed by this key. THE CLIFF, seen from policy's side.
        return refuse(401)
      }

      self.consecutive401 = 0
      self.calls.push({ peer, token: presented, status: 201 })
      // A `deny` on purpose: it is a verdict this service would never invent for itself, so a
      // caller reading it back has proof the gate was consulted rather than defaulted.
      return new Response(
        peer === 'policy'
          ? JSON.stringify({ decision: { decision: 'deny', reasons: ['seller_too_new'] } })
          : JSON.stringify({
              entry: { id: 'entry-1', kind: 'market_escrow', recordedAt: '2024-01-01T00:00:00Z' },
              replayed: false,
            }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch,
  }
  return self
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** See the header: this is what makes the file a
 * test of THIS SERVICE'S wiring rather than of `@cloudsforge/auth`.
 */
function upstreamsFor(w: World, credential: string | null, staticToken: string | null) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    serviceToken: staticToken,
    ledgerUrl: LEDGER,
    indexerUrl: INDEXER,
    policyUrl: POLICY,
    upstreamDeadlineMs: 4_000,
  }
  return buildUpstreams(env, { fetch: w.fetch, originatingService: 'market' })
}

const policyCalls = (w: World): Call[] => w.calls.filter((call) => call.peer === 'policy')
const count401 = (w: World): number => w.calls.filter((call) => call.status === 401).length

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASES
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('the credential is EXCHANGED, and a listing is really moderated at minute zero', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  assert.equal(upstreams.mode, 'exchanged', 'buildUpstreams did not choose the credential')
  assert.equal(w.exchanges, 0, 'the provider exchanged before anything needed a token')

  const verdict = await upstreams.policy.evaluateListing(LISTING)

  assert.equal(verdict.degraded, false, 'the gate was not consulted')
  assert.equal(verdict.decision, 'deny')
  assert.deepEqual(verdict.reasons, ['seller_too_new'])
  assert.equal(w.exchanges, 1, 'the credential was not exchanged for a token')
  assert.deepEqual(policyCalls(w).map((call) => call.status), [201])
  assert.notEqual(policyCalls(w)[0]?.token, CREDENTIAL, 'the CREDENTIAL was presented as a bearer')
  assert.ok(policyCalls(w)[0]?.token?.startsWith('ey'), 'what was presented is not a JWT')
})

test('THE PROPERTY: eleven minutes on, the gate still decides — and it costs no 401', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  await upstreams.policy.evaluateListing(LISTING)
  const bootToken = policyCalls(w)[0]?.token
  assert.ok(bootToken)
  assert.equal(w.exchanges, 1)

  // ── ELEVEN MINUTES. The token this process minted at boot is now dead. ───────────────────────
  clockAt(11 * 60 * 1_000)

  // Proved against a REAL `Verifier` and jose's own arithmetic rather than asserted. If this line
  // ever stops throwing, the rest of this test is meaningless and it should fail here.
  await assert.rejects(
    (async () => {
      const response = await w.fetch(`${POLICY}/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bootToken}` },
      })
      if (!response.ok) throw new Error(`policy refused the boot token: ${response.status}`)
    })(),
    /policy refused the boot token: 401/,
    'the boot token outlived 600 seconds; the cliff is not being modelled',
  )

  const before401s = count401(w)
  const beforeCalls = w.calls.length

  // The listing a seller creates eleven minutes after a deploy. Under the old seam this is where
  // policy starts 401ing for ever and every listing goes up unmoderated with nobody told.
  const verdict = await upstreams.policy.evaluateListing(LISTING)

  const after = w.calls.slice(beforeCalls)
  assert.deepEqual(after.map((call) => call.status), [201], 'the post-expiry listing was refused')
  assert.notEqual(after[0]?.token, bootToken, 'the DEAD boot token was presented again')
  assert.equal(w.exchanges, 2, 'the provider did not re-mint on schedule')
  assert.equal(verdict.degraded, false, 'the gate was absent — this is the live estate defect')
  assert.equal(verdict.decision, 'deny')

  // ── THE ASSERTION THAT STOPS THIS BEING GREEN FOR THE WRONG REASON ──────────────────────────
  // `authorizedFetch` would have rescued a totally broken schedule with one 401 + re-mint + replay,
  // and the verdict would still have come back. Zero 401s means the token was refreshed BEFORE it
  // was presented, which is the guarantee. The replay path is the backstop, not the mechanism.
  assert.equal(
    count401(w),
    before401s,
    'the post-expiry call cost a 401 — the refresh SCHEDULE is broken and the replay path hid it',
  )
})

test('BASELINE: the seam this replaced leaves the gate ABSENT from minute ten', async () => {
  clockAt(0)
  const w = await world()
  // `identityCredential: null`, `serviceToken: <a real 600s JWT>` — i.e. exactly what
  // `const token = () => env.serviceToken` did, and exactly what the estate runs today.
  const upstreams = upstreamsFor(w, null, w.staticToken)
  assert.equal(upstreams.mode, 'static', 'the baseline is not modelling the pre-minted token')

  const atBoot = await upstreams.policy.evaluateListing(LISTING)
  assert.equal(atBoot.degraded, false, 'the baseline failed at minute zero')
  assert.equal(atBoot.decision, 'deny')

  clockAt(11 * 60 * 1_000)
  const after = await upstreams.policy.evaluateListing(LISTING)

  // **This is the 201 measured on the live estate, reproduced.** The listing is not refused — it
  // is created, flagged, and never actually judged, and nothing anywhere says the cause was this
  // container's own credential rather than policy being down.
  assert.equal(after.degraded, true)
  assert.equal(after.decision, 'review')
  assert.deepEqual(after.reasons, ['policy_unavailable'])
  assert.deepEqual(w.calls.slice(1).map((call) => call.status), [401])
  assert.equal(w.exchanges, 0, 'the baseline exchanged something; it is not the old seam')
})

test('EIGHT HOURS of listings, and not one 401', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  // Thirty-two listings spread over eight hours — a whole shift, each step crossing at least one
  // token lifetime. Listings a minute apart would never test anything the first case does not.
  const RUNS = 32
  const STEP_MS = (8 * 60 * 60 * 1_000) / RUNS
  assert.ok(
    STEP_MS > SERVICE_TTL_SECONDS * 1_000,
    'the step is shorter than a token lifetime, so this proves nothing the minute-zero case does not',
  )

  for (let run = 0; run < RUNS; run += 1) {
    clockAt(run * STEP_MS)
    const verdict = await upstreams.policy.evaluateListing(LISTING)
    assert.equal(verdict.degraded, false, `the listing at hour ${(run * STEP_MS) / 3_600_000} was unmoderated`)
  }

  assert.equal(w.calls.length, RUNS, 'a listing made more than one policy call')
  assert.deepEqual([...new Set(w.calls.map((call) => call.status))], [201])
  // One exchange per listing, because each step is longer than a token's whole life. The point is
  // that it kept up, not the exact count — but a count of 1 would mean the schedule never fired.
  assert.ok(w.exchanges >= RUNS - 1, `the provider exchanged only ${w.exchanges} times across ${RUNS} listings`)
  // Distinct bearers, so "it re-minted" is a fact about the wire rather than about a counter.
  assert.ok(
    new Set(w.calls.map((call) => call.token)).size >= RUNS - 1,
    'the same token was reused past its life',
  )
})

test('THE PRECEDENCE: with BOTH set, the credential wins and the dead token is never presented', async () => {
  // **This is the state the estate will actually be in**: `MARKET_SERVICE_TOKEN` is set today and
  // stays set while the credential is added. If the static token won, the deploy would look
  // correct, the boot log would say `exchanged`, and the cliff would still be there. No other case
  // in this file can see that, because each sets exactly one of the two.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, w.staticToken)
  assert.equal(upstreams.mode, 'exchanged', 'the pre-minted token beat the credential')

  await upstreams.policy.evaluateListing(LISTING)
  assert.equal(w.exchanges, 1, 'the credential was not exchanged; the static token was used instead')
  assert.notEqual(w.calls[0]?.token, w.staticToken, 'the un-renewable token was presented')

  // Eleven minutes on, the static token is dead. If it had won at minute zero this would degrade.
  clockAt(11 * 60 * 1_000)
  const verdict = await upstreams.policy.evaluateListing(LISTING)
  assert.equal(verdict.degraded, false)
  assert.equal(w.exchanges, 2)
})

test('THE BACKSTOP: a bearer this process believes is fresh, refused anyway, is re-minted and replayed once', async () => {
  // The case the SCHEDULE cannot cover: the refresh point is computed from this process's clock and
  // `expiresIn`, policy decides from `exp` and ITS clock, and nothing makes those agree. A
  // credential revoked mid-flight looks identical. Without `authorizedFetch` in the wiring the
  // listing would degrade — and `POST /decisions` carries no idempotency key, so `HttpClient`
  // attempts it exactly once and would not retry its way out.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  w.refuseNextBearer = true
  const verdict = await upstreams.policy.evaluateListing(LISTING)

  assert.deepEqual(
    w.calls.map((call) => call.status),
    [401, 201],
    'the 401 was not replayed — `authorizedFetch` is not wired into the clients',
  )
  assert.notEqual(w.calls[1]?.token, w.calls[0]?.token, 'the REJECTED token was replayed unchanged')
  assert.equal(w.exchanges, 2, 'the rejected token was not discarded and re-minted')
  // And the gate still decided, which is the point: a skewed clock is survivable, not silencing.
  assert.equal(verdict.degraded, false)
  assert.equal(verdict.decision, 'deny')
})

test('no credential and no token sends NOTHING, rather than an unauthenticated request', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, null, null)
  assert.equal(upstreams.mode, 'none')

  const verdict = await upstreams.policy.evaluateListing(LISTING)

  // **Nothing was sent.** `HttpClient` omits the header for `undefined`, so a resolve-to-undefined
  // would have gone out unauthenticated, come back 401, and been recorded as policy being
  // unreachable — when the truth is nobody gave this service a credential. Those are different
  // mornings, and `market_service_token_usable` is the gauge that tells them apart.
  assert.deepEqual(w.calls, [], 'an unauthenticated request was sent to policy')
  assert.equal(verdict.degraded, true, 'a listing was moderated with no credential at all')
})

test('the LEDGER is on the same credential — the wiring is not policy-only', async () => {
  // `upstreams.ts` hands one `token` and one `fetch` to all three clients, and this is the
  // assertion that says so about more than one of them. The ledger is the hard dependency: with it
  // unauthenticated, no listing reserves, no bid escrows and no sale settles.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  clockAt(11 * 60 * 1_000)
  const entry = await upstreams.ledger.postEntry({
    kind: 'market_escrow',
    actor: 'service:market',
    correlationId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'market:escrow:listing:abc',
    postings: [],
  })

  assert.equal(entry.id, 'entry-1')
  assert.deepEqual(w.calls.map((call) => [call.peer, call.status]), [['ledger', 201]])
  assert.equal(w.exchanges, 1)
})
