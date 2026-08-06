# cloudsforge-market

[![ci](https://github.com/cloudsforge-online/micro-market/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-market/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

Listings, auctions, offers, orders, escrow, royalties, moderation and reversible disputes for the
Forge Market.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

```
pnpm install
pnpm migrate     # a one-shot job. Never run from the service.
pnpm start
pnpm check       # typecheck + 298 tests
pnpm verify      # boot the real service and sell something through it
```

---

## What it is

| | |
|---|---|
| **Owns** | `collections`, `listings`, `escrows`, `bids`, `offers`, `orders`, `order_royalties`, `moderation_cases`, `disputes`, `verifications` |
| **Calls** | `ledger` (reservations, captures, refunds — **hard**), `indexer` (escrow confirmation — **hard** for on-chain listings; token facts — soft), `policy` (listing verdicts — soft) |
| **Holds no** | money. There is no `balance` column, and there is not meant to be |
| **Publishes** | `market.listing.listed`, `market.listing.sold`, `market.listing.removed`, `market.bid.placed`, `market.offer.made`, `market.order.paid_out`, `market.order.refunded`, `market.dispute.opened`, `market.dispute.resolved`, `market.moderation.opened`, `market.moderation.resolved` |
| **Consumes** | `identity.user.deleted` |

Every amount is `bigint` in the code and `numeric(78,0)` in the schema. There is no float anywhere
near an amount, and no scaled decimal: a `numeric(x,1)` money column is a rounding error with a
currency symbol on it. See `src/money.ts`, which is the only place a rounding rule is stated.

---

## The one idea

**This service holds no money, and it is arranged so that it cannot start to.**

An `escrows` row is a *reference* to a ledger reservation — an amount, an asset code, and the id of
the entry that reserved it. It is not a balance, and nothing in this repository can spend it. Every
fee, every royalty, every settlement and every refund is a double-entry call to `micro-ledger` whose
idempotency key is **derived** from the thing being paid for, never generated:

```
market:escrow:listing:<listingId>
market:escrow:bid:<bidId>
market:escrow:offer:<offerId>
market:settle:<listingId>
market:settle:<listingId>:funds:<buyerSubject>
```

A derived key is what makes a lost HTTP response safe. Two workers that both decide to settle one
auction compute the *same* key, the ledger replays the first entry for the second caller, and the
seller is credited once. A `randomUUID()` key — which is what the frozen estate does — mints a
second key for the second attempt and the upstream honours both.

That is the second line of defence. The first is the database:

| Constraint | What it makes impossible |
|---|---|
| `orders_listing_uniq` | One listing yields at most one order, for ever. The same item cannot be sold to two buyers |
| `orders_partition` | `fee + royalty + proceeds = amount`, checked by Postgres on every insert. Money cannot leak out of a split |
| `listings_active_is_escrowed` | A listing cannot be active unless it names the ledger reservation holding its item. Nothing is ever for sale that the seller has not actually put up |
| `moderation_open_freeze_uniq` | One open freeze per listing |
| `disputes_open_uniq` | One open dispute per order |
| `disputes_refund_names_its_entry` | A dispute recorded as refunded must name the entry that refunded it |

The third is the application, and it is the weakest of the three — which is the right order.

---

## Background work is leased, never timed

There is no `setInterval` in `src/`. Every recurring thing is a row in the `jobs` table claimed
`for update skip locked` by `@cloudsforge/jobs`, and the lease key names the **contended resource**
rather than the stream:

| Job | Lease key | Why that key |
|---|---|---|
| `outbox.relay` | the stream | Ordering is the point |
| `auction.sweep` | the stream | It only *finds* due auctions and enqueues them. It never settles |
| `auction.close` | `listing:<listingId>` | Two different auctions are genuinely independent; keying on the stream would serialise the estate's closes behind one worker |
| `payout.release` | `order:<orderId>` | One payout per order |
| `market.expire` | the stream | It releases escrows, and that is the dangerous one — see the header of `src/jobs.ts` |
| `idempotency.reap` | the stream | Housekeeping |

`auction.close` is the one that carries the argument. It is not a timer that fires at
`auction_ends_at`; it is a claim on a listing whose end has passed, and the settlement inside it
claims the listing's *status* in the same transaction as the order row. Two workers racing one
auction is a test in this repository, not a hope.

---

## Idempotency, and the two defects it is written against

Every mutating route requires an `Idempotency-Key` header, and the claim shares one transaction
with the work it protects.

### A key belongs to the caller who chose it

The stored key is `market:<route>:<principal>|<client key>`. The principal is the authenticated
subject — `user:<id>` or `service:<name>` — and it is there because callers choose their own keys
and do not coordinate. Without it the namespace was `market:<route>:<client key>`, which names
*this service* rather than the caller, so two sellers who derived their key from the payload — a
common and defensible reading of what an idempotency key is — collided deterministically, and the
second was replayed the first's response: their listing was never created and they were handed the
id of somebody else's.

The principal is in the **namespace** rather than the fingerprint on purpose. In the fingerprint it
would make the collision an *error*: the second caller gets a 409 about a body they never sent, and
whoever claims a key first can deny it to everyone else. In the namespace the collision cannot
happen at all. The stored key is also what lands in `listings.idempotency_key`, under
`listings_idempotency_uniq`, so scoping the namespace scopes that index to the seller too — the
fingerprint alternative would have left the loser's INSERT dying on a `23505` against a row it
cannot see.

The `|` is not decoration: a client key may contain colons, so with a colon on both sides the
principal `user:a` with key `b:cccccccc` and the principal `user:a:b` with key `cccccccc` would be
one string, and the collision would be back. It also means no key written before this change can
ever resolve against one written after it.

### The fingerprint excludes the per-attempt fields

```ts
const PER_ATTEMPT_FIELDS = new Set(['correlationId', 'idempotencyKey', 'requestId'])
```

`correlationId` is a trace identifier and it is *supposed* to change between attempts — that is what
makes a retry distinguishable from the original in a trace. `micro-ledger` fingerprinted the whole
body, `correlationId` included, so a caller doing exactly the right thing got a 409 on an honest
retry. That regression is pinned there in `ledger/src/idempotency.test.ts` and it is pinned here in
`src/idempotency.test.ts` under `A RETRY WITH A FRESH CORRELATION ID REPLAYS RATHER THAN 409ING`,
and again as a text assertion in CI so it cannot be deleted in a refactor without a red build.

A reused key with a genuinely *different* body is still a 409. Both halves matter.

---

## The indexer routes this service asks for, checked as SHAPES

`src/indexerclient.test.ts` asserts that every path `src/indexerclient.ts` requests is a whole route
shape `micro-indexer` serves. It matters that it is a shape and not a prefix, and this repository is
where that lesson was paid for twice.

**The first version of this guard would have missed the defect it exists to catch.** It matched
`path.startsWith(prefix)` against a list containing `/v1/chains/`, and it pinned the *count* of
unserved paths rather than their shapes. `micro-mint` then shipped exactly this class of defect —
its client called `/v1/chains/:chain/:network/transactions/:hash` and
`/v1/chains/:chain/:network/tokens/:address`, neither of which the indexer has ever served — and
run against those two paths the prefix guard judges **zero** of them unserved, because both begin
with `/v1/chains/`, which really is a served prefix. A count is not a shape.

It compares segment by segment now (`src/indexerclient.test.ts`, `matches`), against the route table
copied from `indexer/src/server.ts` under both spellings of `PREFIXES`
(`indexer/src/server.ts`). The dialect is `micro-mint`'s
(`mint/scripts/checkindexerroutes.mjs`), copied rather than invented a third time. A second test
mutates it — five paths the indexer does not serve, including mint's real one — and requires the
matcher to reject every one, so a guard that has quietly become vacuous fails in the suite.

**Two source changes came with it.** The escrow path is now one whole template literal with every
segment written out (`src/indexerclient.ts`); it used to build a `${scope}` holding
`chain/network`, and an interpolation is one opaque segment to any checker, so that path arrived at
the guard as a four-segment shape which **matches `/transactions/:chain/:network/:hash`** — the
wrong route, reported as fine. And the argument in `tokenFacts`' refusal was corrected: it claimed
`mintAuthorityPresent` and `ownershipRenounced` were behind "an `eth_call` this service deliberately
never makes", which stopped being true when `micro-indexer` gained
`GET /tokens/:chain/:network/:address` (`indexer/src/server.ts`,
`indexer/src/tokenstate.ts`). **The refusal is unchanged and stands on its remaining
grounds** — the capability is keyed by a `micro-mint` item URN the indexer has no registry for, and
three of `TokenFacts`' eight fields need complete holder history or a custody fact about a private
key. The dead argument is marked in place rather than deleted, because a ledger of reasoning whose
wrong entries vanish cannot be audited.

---

## Health, and why there are three endpoints

`/livez` is static — it answers from the process, touches nothing, and is what the restart policy
reads. `/readyz` runs real probes through `@cloudsforge/lifecycle` and is what the load balancer
reads. The hard/soft split is a decision, not a default:

| Probe | Kind | Why |
|---|---|---|
| Postgres | hard | Nothing works without it |
| identity JWKS | soft | Tokens already issued keep verifying from cache; a JWKS blip must not stop the market |
| **ledger** | **hard** | 07-dependency-map marks `market → ledger` hard for the reason a probe encodes: a market that cannot reserve, capture or refund can still *take a bid*, and that is the shape of the incident where a buyer's funds are gone and no order exists |
| indexer | soft for the probe, **hard on the on-chain path** | The risk indicators simply do not render, which is designed degradation. Activating an *on-chain* listing is not degradable: it asks the chain whether the escrow is real, and an unreachable indexer is a 503 rather than a refusal — "we could not ask" must never become "it is not confirmed" |
| policy | soft | Designed degradation — policy fails **open and flagged**, never open and silent |

Migrations are never run by the service process. `src/migrator.ts` is a separate one-shot job, and
here that matters twice over: below `SCHEMA_VERSION` neither `listings_active_is_escrowed` nor
`orders_listing_uniq` may exist, so a listing could be opened for business holding nothing and the
same item could be sold twice. A service that could create those at boot is a service that could
start without them. `index.ts` asserts the schema version and refuses to serve below it.

---

## Findings against `micro-org`

Recorded rather than worked around silently. All three concern the reusable workflows this
repository calls, and each one made a check red for a repository that was actually compliant.

1. **`service-ci.yml`'s `build` job has no Postgres service container**, so a database-backed suite
   cannot run in the reusable workflow. Every sibling avoids this by keeping a bespoke CI file,
   which is the thing 03 §5 is trying to drive to zero. This repository calls the reusable workflow
   *and* carries one extra job that provides a database; **delete `database` the day
   `service-ci.yml` gains a `postgres-service` input.** `micro-trade` recorded this first.

2. **Rule 1's check has no exemption for a test-only DSN.** It greps `src/` for
   `[A-Z][A-Z0-9_]*_(DATABASE_URL|DB_URL|POSTGRES_URL)` and fails on anything that is not the one
   declared database variable — so the `<service>_test_database_url` name that `worlds`, `wallet`,
   `studio` and `settlement` all use would fail it. This repository names its test variable
   `MARKET_TEST_DATABASE_URL` to stay green, which is the cheap half of the fix; the other half belongs in
   `micro-org`.

3. **That same check matches prose and test fixtures, not declarations.** Two consequences here.
   The note in `src/testsupport.ts` explaining *why* the name is rejected has to write it in lower
   case, or the explanation fails the build. And `src/env.test.ts` contains a test that proves this
   service ignores another service's connection string — the check cannot tell a variable the
   service **reads** from one a test proves it **ignores**, so the foreign name is assembled from
   its parts rather than spelled. `worlds`' own CI file already anticipates this class of problem
   for rule 8 — *"a check that cannot tell a timer from a sentence about one is a check people
   learn to ignore"* — and rule 1 has the same defect without the same guard.

4. **`service-ci.yml`'s `image` job cannot pass extra build contexts.** The Dockerfile needs
   `runtimepkgs` and `contractpkgs` until AD-02 publishes the `@cloudsforge/*` packages, and the
   reusable job has no input for them, so `build-image: false` is set and the image is proved by a
   local job that does pass them. This disappears with AD-02 rather than needing a fix.

---

## Layout

```
src/
  money.ts          all the arithmetic, in bigint. The one place a rounding rule is stated
  migrations.ts     the schema, and the six constraints that are the real controls
  migrator.ts       the one-shot job. Never called by the service
  listings.ts       create, activate (which RESERVES), end. A listing is nothing until the ledger agrees
  escrow.ts         hold, release, capture — each exactly once, whatever calls it
  bids.ts           bids, offers, anti-sniping, and the due-auction query
  orders.ts         settlement, the auction close, proceeds and payouts
  moderation.ts     freezes and disputes, both reversible
  risk.ts           computed indicators. No score, no grade, no colour — see the header
  idempotency.ts    the claim, scoped to the caller, and the fingerprint that excludes per-attempt fields
  outbox.ts         the transactional outbox and the signed relay
  jobs.ts           every background timer, as a lease
  ledgerclient.ts   postings, reservations, derived keys, and the failure taxonomy
  indexerclient.ts  escrow confirmation and token facts. Never-seen and unconfirmed are two answers
  policyclient.ts   fails open AND flagged
  server.ts         routes, the error shape, the auth-fault mapping
  env.ts            every variable, validated at boot — including the fee/royalty ceiling check
  index.ts          the composition root, in order
scripts/
  verify.ts         boot the real service, sell a real item, print the ledger entry that paid for it
```

## Tests

`node:test` against a real Postgres. **347 `test(`/`it(` declarations, which run as 355 cases,
zero skipped** (measured 2026-08-04 against `postgres:16-alpine`; a few declarations sit in loops).

```
MARKET_TEST_DATABASE_URL=postgres://…/market_test pnpm test
```

The database-backed cases run against the real `MIGRATIONS` rather than a fixture schema,
deliberately: a fixture would let the constraints drift out of the tests that exist to prove they
fire. `--test-concurrency=1` is required and not a preference — every database file truncates this
service's tables, and a `TRUNCATE` takes an `AccessExclusiveLock` that deadlocks against another
file's inserts.

The ones that carry the argument:

| Proof | Where |
|---|---|
| Two simultaneous equal bids leave **exactly one** winner | `bids.test.ts` |
| Eight simultaneous bids leave one leader and one held escrow | `bids.test.ts` |
| Two workers closing one auction produce **exactly one** settlement, and the seller is credited once | `auctions.test.ts` |
| Four workers closing one auction still produce exactly one order | `auctions.test.ts` |
| Two simultaneous purchases produce exactly one order and one posted entry | `orders.test.ts` |
| Escrow is released exactly once under two concurrent releasers | `orders.test.ts` |
| A captured escrow can never be released afterwards | `orders.test.ts` |
| The payout happens exactly once under two concurrent workers | `orders.test.ts` |
| A frozen listing blocks settlement — **through the worker, not only the HTTP route** | `auctions.test.ts`, `moderation.test.ts` |
| Two callers, one key, identical bodies — **two artefacts**, one each | `callerscoping.test.ts` |
| A different principal never waits on somebody else's claim | `callerscoping.test.ts` |
| The same principal still blocks on its own claim, and then replays | `callerscoping.test.ts` |
| A retry with a fresh correlation id replays rather than 409ing | `idempotency.test.ts` |
| A concurrent duplicate blocks and then replays — it never double-runs | `idempotency.test.ts` |
| The same key with a different body is a 409, not a replay | `idempotency.test.ts` |
| The royalty split sums **exactly** to the royalty, with no rounding leak | `orders.test.ts` |
| Fee + royalty + proceeds equals the price, asserted by Postgres | `migrations.test.ts` |
| One listing yields at most one order, for ever | `migrations.test.ts` |
| An auction with no bids expires and the item is released — an outcome, not a failure | `auctions.test.ts` |
| An auction below its reserve refunds **every** bid | `auctions.test.ts` |
| The reserve is never leaked through a bid refusal | `bids.test.ts` |
| The auction close is keyed on the auction, not the stream | `jobs.test.ts` |
| A listing the ledger will not reserve is never activated | `listings.test.ts` |

`pnpm verify` boots the real service on a real socket and drives a sale through the real routes. On
a listing at 1000 SHARD with a 2.5% fee and a 5% royalty it settles to one balanced entry —
`debit 1000` from the buyer's reserved SHARD against `credit 925 / 25 / 50` to seller, platform and
creator, plus the item moving from the seller's reserved to the buyer's available in the same entry.
Both asset codes net to exactly zero.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
