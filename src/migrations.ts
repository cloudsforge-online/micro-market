/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * ---------------------------------------------------------------------------------------------
 * **THE FIVE CONSTRAINTS THIS SERVICE EXISTS TO ADD. Each is a CHECK, not a rule in a route.**
 *
 *   `listings_active_is_escrowed`   04-domain-model §6.1: "a listing that cannot reserve cannot
 *                                   be listed — that is what makes 'sold twice' impossible". An
 *                                   `active` listing that has not named its escrow is a row that
 *                                   cannot exist. There is no reservation concept ANYWHERE in the
 *                                   frozen estate: a marketplace listing there holds nothing, so
 *                                   a balance can be spent twice and the second spend is the one
 *                                   that fails, after both buyers were told yes.
 *
 *   `orders_listing_uniq`           One listing yields at most ONE order, for ever. This is the
 *                                   last line under every concurrency defence in this repository
 *                                   — the row lock in `bids.ts`, the conditional status claim in
 *                                   `orders.ts`, the job lease in `jobs.ts`. Those three are the
 *                                   design; this is what happens if all three are wrong at once.
 *
 *   `orders_partition`              `fee + royalty + proceeds = amount`, checked by Postgres. The
 *                                   arithmetic in `money.ts` guarantees it; this is what
 *                                   guarantees the arithmetic was actually used. An order that
 *                                   does not partition its own price is a ledger entry that will
 *                                   not balance, and an unbalanced ledger is a P0 in 17 §8.
 *
 *   `orders_one_settlement_artefact` 04-domain-model §6.2: "every order references exactly one
 *                                   settlement artefact — a ledger entry for custodial, an
 *                                   on-chain transaction for non-custodial. An order with
 *                                   neither is a bug that reconciliation catches." Here it is a
 *                                   bug that cannot be written down. Note `= 1`, not `>= 1`: an
 *                                   order claiming BOTH is as wrong as one claiming neither,
 *                                   because it means the same sale settled twice in two systems.
 *
 *   `escrows_settled_names_entry`   A released or captured escrow names the entry that did it. An
 *                                   escrow that claims to have been released and cannot say by
 *                                   what is exactly the state that makes "was this refunded?"
 *                                   unanswerable.
 *
 * **AND THE COLUMN THAT IS NOT HERE.** There is no `balance` column, no `held_amount`, no
 * `escrow_balance`. `escrows.amount` is the amount of a REFERENCE to a ledger reservation, and
 * `escrows.hold_entry_id` is the reservation. 04-domain-model §11: no user balance column
 * anywhere outside the ledger's projection. Market records intent and state; the ledger records
 * value. If a column here ever starts being decremented, this service has become a second ledger
 * and the trial balance has stopped meaning anything.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key IS the dedupe: a redelivered event conflicts and the handler is never re-run. Here
      -- that is not hygiene — a redelivered 'entitlement.revoked' must not delist a seller's
      -- listings a second time after they have legitimately relisted.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'idempotency',
    // The shape is the ledger's, which took it from forge-pay's store.ts:153. The claim INSERT and
    // the work share ONE transaction, so the stored response can never disagree with what
    // committed. See src/idempotency.ts for the four properties this table is here to give.
    up: `
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        request_hash text        not null,
        response     jsonb,
        -- What the key produced, so an operator can join a caller's key to the sale it made. Text
        -- rather than a uuid FK: the artefact may be an on-chain transaction hash, and it may
        -- belong to another service's table entirely (a ledger entry id).
        artefact_id  text,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 5,
    name: 'collections_and_verification',
    up: `
      create table if not exists collections (
        id             uuid        primary key default gen_random_uuid(),
        owner_subject  text        not null,
        slug           text        not null,
        name           text        not null,
        description    text        not null default '',
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        constraint collections_slug_uniq unique (slug),
        -- A slug is a URL segment. Constrained here so it cannot become a path traversal.
        constraint collections_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
        constraint collections_name_length check (char_length(name) between 1 and 120)
      );

      -- A collection's DEFAULT royalty split. Snapshotted onto each listing at creation — see
      -- listing_royalties. Editing this must never change the terms of a sale already in flight.
      create table if not exists collection_royalties (
        collection_id uuid    not null references collections (id) on delete cascade,
        subject       text    not null,
        bps           integer not null,
        primary key (collection_id, subject),
        constraint collection_royalties_bps_range check (bps between 0 and 10000)
      );

      -- 04-domain-model §6.3. **Risk indicators are computed, not editorial**, so nothing here
      -- stores a score: a level, the evidence it was set on, and who set it. The indicators
      -- themselves are derived from the indexer at read time — see risk.ts.
      create table if not exists verifications (
        subject_urn text        primary key,
        level       text        not null default 'unverified',
        evidence    jsonb       not null default '{}'::jsonb,
        reviewed_by text,
        reviewed_at timestamptz,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        constraint verifications_level_known check (
          level in ('unverified','claimed','verified','flagged')
        ),
        -- A level that somebody chose says who chose it. 'unverified' is the absence of a
        -- decision and is the only level that may have no reviewer.
        constraint verifications_reviewed_is_attributed check (
          level = 'unverified' or (reviewed_by is not null and reviewed_at is not null)
        )
      );
    `,
  },
  {
    version: 6,
    name: 'listings',
    // 04-domain-model §6.1.
    up: `
      create table if not exists listings (
        id                uuid          primary key default gen_random_uuid(),
        seller_subject    text          not null,
        -- Required for an on-chain listing and meaningless for a custodial one: on-chain, the
        -- user's own wallet is the counterparty and the platform never holds the key (AD-14).
        seller_wallet_id  text,
        collection_id     uuid          references collections (id) on delete set null,
        asset_kind        text          not null,
        item_urn          text          not null,
        quantity          numeric(78,0) not null,
        -- What the LEDGER calls the item being sold, so a custodial reservation can be posted
        -- against it: 'TOKEN:<urn>' for a token, 'SHARD' for shards. Distinct from asset_code,
        -- which is what the PRICE is denominated in. Conflating the two is how a sale ends up
        -- reserving the wrong asset and balancing anyway.
        item_asset_code   text          not null,
        pricing_mode      text          not null,
        price             numeric(78,0),
        reserve_price     numeric(78,0),
        asset_code        text          not null,
        settlement_mode   text          not null,
        royalty_bps       integer       not null default 0,
        platform_fee_bps  integer       not null default 0,
        auction_ends_at   timestamptz,
        expires_at        timestamptz,
        status            text          not null default 'draft',
        -- Set by a moderation case or a dispute, in the SAME TRANSACTION as the case. Settlement's
        -- claim query carries 'and frozen = false', so a freeze is enforced by the database rather
        -- than by a check somebody remembered to write above the settlement call. A check before
        -- the transaction is a check with a race in it.
        frozen            boolean       not null default false,
        -- The escrow row that holds this listing's item. **Deliberately not a foreign key**: the
        -- escrow row already carries listing_id, and a second FK in the other direction makes the
        -- pair a cycle that neither table can be created or dropped without. The escrow row is the
        -- authority; this is the index into it.
        escrow_id         uuid,
        -- The on-chain escrow's transaction hash, for settlement_mode = 'onchain'. The indexer
        -- confirms it; this service never signs anything.
        onchain_escrow_tx text,
        -- How long the seller's proceeds sit in payout_due after settlement. Snapshotted from the
        -- environment at creation, NOT read at settlement: changing the window must not
        -- retroactively change the terms a seller already listed under.
        dispute_window_ms bigint        not null default 0,
        close_lease_owner text,
        close_lease_until timestamptz,
        created_at        timestamptz   not null default now(),
        updated_at        timestamptz   not null default now(),
        activated_at      timestamptz,
        ended_at          timestamptz,

        constraint listings_asset_kind_known check (
          asset_kind in ('token','game_item','entitlement','membership','brand_asset','collectible')
        ),
        constraint listings_pricing_mode_known check (
          pricing_mode in ('fixed','auction','offers_only')
        ),
        constraint listings_settlement_mode_known check (
          settlement_mode in ('custodial','onchain')
        ),
        constraint listings_status_known check (
          status in ('draft','active','settling','sold','cancelled','expired')
        ),
        constraint listings_quantity_positive check (quantity > 0),
        constraint listings_price_positive check (price is null or price > 0),
        constraint listings_reserve_positive check (reserve_price is null or reserve_price > 0),
        constraint listings_bps_range check (
          royalty_bps between 0 and 10000 and platform_fee_bps between 0 and 10000
        ),
        -- The seller must be left something. money.ts refuses the split and this refuses the row,
        -- which means a listing whose terms cannot produce a valid sale cannot be created at all
        -- rather than failing at the moment somebody buys it.
        constraint listings_terms_leave_the_seller_something check (
          royalty_bps + platform_fee_bps < 10000
        ),
        constraint listings_fixed_has_price check (
          pricing_mode <> 'fixed' or price is not null
        ),
        constraint listings_auction_has_end check (
          pricing_mode <> 'auction' or (auction_ends_at is not null and price is not null)
        ),
        constraint listings_onchain_names_a_wallet check (
          settlement_mode <> 'onchain' or seller_wallet_id is not null
        ),
        constraint listings_dispute_window_non_negative check (dispute_window_ms >= 0),

        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **A LISTING THAT CANNOT RESERVE CANNOT BE LISTED.** 04-domain-model §6.1.
        --
        -- The whole anti-double-sale argument in one constraint. A custodial listing that is
        -- open for business has moved the item from the seller's 'available' to their 'reserved'
        -- in the ledger, and escrow_id names the row that records it. An on-chain listing has an
        -- escrow transaction on the chain. Either way, an ACTIVE listing that holds nothing is a
        -- row that cannot commit.
        --
        -- The frozen estate has no reservation concept of any kind — grep for it returns nothing
        -- — so a listing there holds nothing at all and the same balance backs any number of
        -- simultaneous sales.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        constraint listings_active_is_escrowed check (
          status not in ('active','settling')
          or (settlement_mode = 'custodial' and escrow_id is not null)
          or (settlement_mode = 'onchain' and onchain_escrow_tx is not null)
        )
      );

      create index if not exists listings_seller_idx on listings (seller_subject, created_at desc);
      create index if not exists listings_collection_idx
        on listings (collection_id, created_at desc)
        where collection_id is not null;
      -- The browse path. Partial, so it is the size of the market rather than of its history.
      create index if not exists listings_active_idx
        on listings (asset_kind, created_at desc)
        where status = 'active';
      -- The auction-close sweep's access path. Partial and narrow: the sweep runs every few
      -- seconds and must never be a sequential scan of every listing ever made.
      create index if not exists listings_auction_due_idx
        on listings (auction_ends_at)
        where status = 'active' and pricing_mode = 'auction';
      create index if not exists listings_expiring_idx
        on listings (expires_at)
        where status = 'active' and expires_at is not null;

      -- The royalty split as it stood WHEN THE LISTING WAS CREATED.
      --
      -- Snapshotted from collection_royalties rather than joined to it, because a royalty is a
      -- term of the sale. Joining live would mean an owner could edit the collection's split
      -- while an auction was running and be paid under terms the bidders never saw — which is not
      -- a bug in a query, it is a way to take money.
      create table if not exists listing_royalties (
        listing_id uuid    not null references listings (id) on delete cascade,
        subject    text    not null,
        bps        integer not null,
        primary key (listing_id, subject),
        constraint listing_royalties_bps_range check (bps between 0 and 10000)
      );
    `,
  },
  {
    version: 7,
    name: 'escrows',
    // THE REFERENCE, NOT THE MONEY. See the file header.
    up: `
      create table if not exists escrows (
        id              uuid          primary key default gen_random_uuid(),
        listing_id      uuid          not null references listings (id) on delete cascade,
        kind            text          not null,
        subject         text          not null,
        asset_code      text          not null,
        amount          numeric(78,0) not null,
        bid_id          uuid,
        offer_id        uuid,
        order_id        uuid,
        state           text          not null default 'held',
        -- **The ledger entry that MADE the reservation.** Not nullable: an escrow row that cannot
        -- name the posting that moved the value is an assertion that money is held somewhere,
        -- with nothing to check it against. That is precisely what a marketplace with no
        -- reservation concept has today, and it is why "did this listing actually hold the item"
        -- is currently an unanswerable question.
        hold_entry_id   text          not null,
        -- The entry that released or captured it. Null while held.
        settle_entry_id text,
        held_at         timestamptz   not null default now(),
        settled_at      timestamptz,
        constraint escrows_kind_known check (
          kind in ('listing_item','bid_funds','offer_funds','proceeds')
        ),
        constraint escrows_state_known check (state in ('held','released','captured')),
        constraint escrows_amount_positive check (amount > 0),
        -- A settled escrow names the entry that settled it and when. See the file header.
        constraint escrows_settled_names_entry check (
          state = 'held'
          or (settle_entry_id is not null and settled_at is not null)
        ),
        constraint escrows_held_has_no_settlement check (
          state <> 'held' or (settle_entry_id is null and settled_at is null)
        )
      );

      -- One held item escrow per listing, ever. Not partial on state: a listing whose item escrow
      -- was released is a listing that is over, and a second escrow against it would be a relist,
      -- which is a new listing row. Making this total rather than partial is what stops a
      -- cancel-then-reactivate cycle from stacking reservations.
      create unique index if not exists escrows_listing_item_uniq
        on escrows (listing_id)
        where kind = 'listing_item';
      -- One funds escrow per bid and per offer. The bid row and the escrow row are written in one
      -- transaction, so this is the constraint that makes "a bid holds its money" total.
      create unique index if not exists escrows_bid_uniq
        on escrows (bid_id) where bid_id is not null;
      create unique index if not exists escrows_offer_uniq
        on escrows (offer_id) where offer_id is not null;
      create unique index if not exists escrows_order_proceeds_uniq
        on escrows (order_id) where kind = 'proceeds';
      create index if not exists escrows_held_idx
        on escrows (listing_id) where state = 'held';
    `,
  },
  {
    version: 8,
    name: 'bids_and_offers',
    // 04-domain-model §6.2.
    up: `
      create table if not exists bids (
        id              uuid          primary key default gen_random_uuid(),
        listing_id      uuid          not null references listings (id) on delete cascade,
        bidder_subject  text          not null,
        amount          numeric(78,0) not null,
        asset_code      text          not null,
        escrow_id       uuid,
        status          text          not null default 'leading',
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **ONE CLOCK DOMAIN, AND IN THIS SERVICE IT IS THE DATABASE'S.**
        --
        -- The lesson is billing/src/entitlements.ts:169, where 'granted_at' defaulted to Postgres'
        -- now() while 'isEntitlementActive' compared it against the application's clock. Sixty
        -- milliseconds of skew between the two hosts made a just-granted entitlement read as "not
        -- yet active", and the purchase response said 'active: false' for something the customer
        -- had at that moment paid for.
        --
        -- Billing fixed it by moving the stamp INTO the application, because that is where its
        -- comparison lives. Market fixes the same problem in the opposite direction, because every
        -- auction comparison here happens in SQL — 'auction_ends_at > now()' in the bid's own
        -- statement, 'auction_ends_at <= now()' in the close sweep. So the stamp is the database's
        -- too, and there is one clock rather than one per replica. An application-stamped
        -- 'placed_at' would reintroduce exactly billing's bug, with an auction's outcome as the
        -- prize: a bid from a fast-clocked replica accepted after the close.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        placed_at       timestamptz   not null default now(),
        constraint bids_amount_positive check (amount > 0),
        constraint bids_status_known check (
          status in ('leading','outbid','won','lost','withdrawn')
        )
      );

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- **AT MOST ONE LEADING BID PER LISTING.**
      --
      -- The database half of the concurrent-bid defence. 'placeBid' takes a row lock on the
      -- listing so two simultaneous bids serialise and the second sees the first — that is the
      -- design. This index is what happens if the lock is ever removed by someone who thinks it
      -- is redundant: the second insert raises 23505 instead of producing two winners.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists bids_leading_uniq
        on bids (listing_id) where status = 'leading';
      create index if not exists bids_listing_idx on bids (listing_id, amount desc, placed_at);
      create index if not exists bids_bidder_idx on bids (bidder_subject, placed_at desc);

      create table if not exists offers (
        id               uuid          primary key default gen_random_uuid(),
        listing_id       uuid          not null references listings (id) on delete cascade,
        offerer_subject  text          not null,
        amount           numeric(78,0) not null,
        asset_code       text          not null,
        escrow_id        uuid,
        status           text          not null default 'open',
        expires_at       timestamptz,
        -- The database's clock, for the same reason as bids.placed_at above.
        created_at       timestamptz   not null default now(),
        resolved_at      timestamptz,
        constraint offers_amount_positive check (amount > 0),
        constraint offers_status_known check (
          status in ('open','accepted','declined','withdrawn','expired')
        ),
        constraint offers_resolved_has_time check (
          status = 'open' or resolved_at is not null
        )
      );

      -- One open offer per buyer per listing. A second offer is an amendment, which is a withdraw
      -- and a re-offer — otherwise a buyer's funds are escrowed N times for one intent to buy
      -- once, and their spendable balance quietly disappears.
      create unique index if not exists offers_open_uniq
        on offers (listing_id, offerer_subject) where status = 'open';
      create index if not exists offers_listing_idx on offers (listing_id, amount desc);
      create index if not exists offers_expiring_idx
        on offers (expires_at) where status = 'open' and expires_at is not null;
    `,
  },
  {
    version: 9,
    name: 'orders',
    // 04-domain-model §6.2, and the three constraints in the file header.
    up: `
      create table if not exists orders (
        id                      uuid          primary key default gen_random_uuid(),
        listing_id              uuid          not null references listings (id),
        buyer_subject           text          not null,
        seller_subject          text          not null,
        item_urn                text          not null,
        item_asset_code         text          not null,
        quantity                numeric(78,0) not null,
        amount                  numeric(78,0) not null,
        fee_amount              numeric(78,0) not null,
        royalty_amount          numeric(78,0) not null,
        seller_proceeds         numeric(78,0) not null,
        asset_code              text          not null,
        settlement_mode         text          not null,
        journal_entry_id        text,
        outbound_transaction_id text,
        source                  text          not null,
        proceeds_state          text          not null default 'released',
        payout_due_at           timestamptz,
        payout_entry_id         text,
        settled_at              timestamptz   not null,

        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **ONE LISTING, AT MOST ONE ORDER, FOR EVER.** The last line under every concurrency
        -- defence in this repository. If the row lock in bids.ts, the conditional status claim in
        -- orders.ts and the job lease in jobs.ts are all wrong at once, this is what turns a
        -- double settlement into a failed transaction instead of a second payment.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        constraint orders_listing_uniq unique (listing_id),

        constraint orders_amounts_non_negative check (
          amount > 0 and fee_amount >= 0 and royalty_amount >= 0 and seller_proceeds >= 0
        ),
        constraint orders_quantity_positive check (quantity > 0),
        -- The money invariant, enforced by Postgres. money.ts computes it; this proves money.ts
        -- was the thing that computed it.
        constraint orders_partition check (
          fee_amount + royalty_amount + seller_proceeds = amount
        ),
        constraint orders_source_known check (source in ('purchase','auction','offer')),
        constraint orders_settlement_mode_known check (
          settlement_mode in ('custodial','onchain')
        ),
        constraint orders_proceeds_state_known check (proceeds_state in ('held','released')),
        -- EXACTLY one settlement artefact. Not "at least one": an order naming both a ledger entry
        -- and an on-chain transaction means one sale settled twice, in two systems, which is worse
        -- than one that settled in neither.
        constraint orders_one_settlement_artefact check (
          (case when journal_entry_id is not null then 1 else 0 end)
          + (case when outbound_transaction_id is not null then 1 else 0 end) = 1
        ),
        constraint orders_held_proceeds_have_a_due_date check (
          proceeds_state <> 'held' or payout_due_at is not null
        ),
        -- An on-chain sale never holds proceeds: there is nothing to hold. The buyer paid the
        -- seller's own wallet and the platform was never a party to the movement.
        constraint orders_onchain_holds_nothing check (
          settlement_mode <> 'onchain' or proceeds_state = 'released'
        )
      );

      create index if not exists orders_buyer_idx on orders (buyer_subject, settled_at desc);
      create index if not exists orders_seller_idx on orders (seller_subject, settled_at desc);
      -- The payout sweep's access path.
      create index if not exists orders_payout_due_idx
        on orders (payout_due_at) where proceeds_state = 'held';

      -- What each royalty recipient was actually paid, per order. The audit trail for "the split
      -- said 60/40, what did they get" — a question that cannot be answered from the rates alone
      -- once largest-remainder has handed somebody a dust unit.
      create table if not exists order_royalties (
        order_id uuid          not null references orders (id) on delete cascade,
        subject  text          not null,
        amount   numeric(78,0) not null,
        primary key (order_id, subject),
        constraint order_royalties_amount_non_negative check (amount >= 0)
      );
    `,
  },
  {
    version: 10,
    name: 'moderation_and_disputes',
    // 04-domain-model §6.3.
    up: `
      create table if not exists moderation_cases (
        id           uuid        primary key default gen_random_uuid(),
        subject_kind text        not null,
        subject_urn  text        not null,
        -- Set when the case is about a listing, so the freeze can be applied and lifted in the
        -- same transaction as the case's state change. Null for a case against a seller or a
        -- collection, which freeze through their own paths.
        listing_id   uuid        references listings (id) on delete cascade,
        reason       text        not null,
        action       text        not null default 'none',
        state        text        not null default 'open',
        opened_by    text        not null,
        opened_at    timestamptz not null default now(),
        resolved_by  text,
        resolved_at  timestamptz,
        notes        text,
        constraint moderation_subject_kind_known check (
          subject_kind in ('listing','collection','seller','item')
        ),
        constraint moderation_action_known check (action in ('none','freeze','delist')),
        constraint moderation_state_known check (state in ('open','upheld','dismissed')),
        -- A resolved case says who resolved it. A moderation decision with no name on it is not
        -- auditable, and 17 §2 requires an audit event for every privileged action.
        constraint moderation_resolved_is_attributed check (
          state = 'open' or (resolved_by is not null and resolved_at is not null)
        ),
        -- A case that freezes or delists names the listing it acts on. An action with no target
        -- is a case that appears to have done something and did not.
        constraint moderation_action_has_a_target check (
          action = 'none' or listing_id is not null
        )
      );

      create index if not exists moderation_open_idx
        on moderation_cases (opened_at) where state = 'open';
      create index if not exists moderation_subject_idx
        on moderation_cases (subject_urn, opened_at desc);
      -- One open freeze per listing. Two open freezes would mean resolving the first unfreezes a
      -- listing the second still considers frozen.
      create unique index if not exists moderation_open_freeze_uniq
        on moderation_cases (listing_id)
        where state = 'open' and action in ('freeze','delist') and listing_id is not null;

      create table if not exists disputes (
        id                  uuid        primary key default gen_random_uuid(),
        order_id            uuid        not null references orders (id) on delete cascade,
        raiser_subject      text        not null,
        reason              text        not null,
        state               text        not null default 'open',
        -- The REVERSAL entry that refunded it. 04-domain-model §2.2 invariant 3: "a correction is
        -- a new entry with reverses_entry_id set. Never an edit." So a refund here is a ledger
        -- entry id, never an UPDATE of the order's amounts.
        resolution_entry_id text,
        opened_at           timestamptz not null default now(),
        resolved_by         text,
        resolved_at         timestamptz,
        constraint disputes_state_known check (
          state in ('open','resolved_refunded','resolved_upheld','withdrawn')
        ),
        constraint disputes_resolved_is_attributed check (
          state = 'open' or resolved_at is not null
        ),
        -- A refund names the entry that made it. A dispute recorded as refunded with no entry is
        -- a customer who has been told they were repaid and has not been.
        constraint disputes_refund_names_its_entry check (
          state <> 'resolved_refunded' or resolution_entry_id is not null
        )
      );

      create unique index if not exists disputes_open_uniq
        on disputes (order_id) where state = 'open';
      create index if not exists disputes_open_all_idx on disputes (opened_at) where state = 'open';
    `,
  },
  {
    version: 11,
    name: 'engagement',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- SUBSIDIES AND BOUNTIES — docs/ecosystem/21 §5, "never ghost demand".
      --
      -- The marketplace's cold start is circular: zero listings begets zero buyers begets zero
      -- listings, and a first seller pays full fees to list into a void. So the platform funds
      -- the SUPPLY side — it waives listing fees for a window, and it pays a bounty for the
      -- first listings — and it is forbidden, structurally, from funding the DEMAND side.
      --
      -- **THE REFUSAL IS THE POINT OF THIS MIGRATION.** 21 §2 rejects "fake it" outright:
      -- synthetic bids, ghost bettors, invisible house positions. It is the one form of this
      -- that costs nothing, and it is fraud. A comment saying "market never places bids" is
      -- worth nothing the day somebody writes the route; the three ALTERs at the bottom make a
      -- platform-funded bid, offer or escrow UNREPRESENTABLE instead.
      -- ══════════════════════════════════════════════════════════════════════════════════════

      -- A zero-fee listing window. Bounded in TIME and in MONEY: a window with no budget is an
      -- unbounded spend, and "we forgot it was on" is the ordinary way that happens.
      create table if not exists engagement_windows (
        id              uuid          primary key default gen_random_uuid(),
        name            text          not null,
        starts_at       timestamptz   not null,
        ends_at         timestamptz   not null,
        -- The most this window may forgo in fees, and what it has forgone so far. The pair is
        -- worlds' seasons.reward_budget_shards shape (worlds/src/migrations.ts:331-341), for the
        -- same reason: a budget nothing decrements is a budget nobody is keeping.
        budget_shards   numeric(78,0) not null,
        spent_shards    numeric(78,0) not null default 0,
        -- The bounty a seller is paid for a qualifying listing, and how many listings qualify.
        -- Zero bounty means this window only waives fees.
        bounty_shards   numeric(78,0) not null default 0,
        bounty_max_listings integer   not null default 0,
        created_by      text          not null,
        created_at      timestamptz   not null default now(),

        constraint engagement_windows_ordered check (ends_at > starts_at),
        constraint engagement_windows_budget_positive check (budget_shards > 0),
        -- The same shape as seasons_within_budget: spend is bounded by the budget IN THE ROW,
        -- so an over-spend is not a race a handler can lose — it is a write that does not commit.
        constraint engagement_windows_within_budget check (
          spent_shards >= 0 and spent_shards <= budget_shards
        ),
        constraint engagement_windows_bounty_pair check (
          (bounty_shards = 0) = (bounty_max_listings = 0)
        ),
        constraint engagement_windows_bounty_nonnegative check (
          bounty_shards >= 0 and bounty_max_listings >= 0
        ),
        constraint engagement_windows_named check (char_length(name) between 1 and 200)
      );

      -- At most one window may be live at any instant. Two overlapping windows would make "which
      -- budget did this listing's waiver come out of" a question with two answers, and an
      -- exclusion constraint answers it in the schema rather than in whichever handler reads
      -- first. btree_gist is what lets a range and equality share one index.
      create extension if not exists btree_gist;
      alter table engagement_windows
        drop constraint if exists engagement_windows_no_overlap;
      alter table engagement_windows
        add constraint engagement_windows_no_overlap
        exclude using gist (tstzrange(starts_at, ends_at) with &&);

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- 21 §7.4: "Every engagement grant resolves to a ledger entry pair; a grant with no
      -- posting cannot exist."
      --
      -- 'ledger_entry_id' is NOT NULL, which is the strongest form of that sentence available:
      -- the row cannot be written at all until the posting exists. This is 'escrows.hold_entry_id'
      -- (migration 5, :354) applied to the engagement programme, and its comment there is exactly
      -- the argument — "a row that cannot name the posting that moved the value is an assertion
      -- that money is held somewhere, with nothing to check it against."
      --
      -- The residual window is deliberate and points the safe way: a crash between the ledger
      -- post and this insert leaves an ENTRY WITH NO ROW, which over-states the programme's
      -- spend in the ledger and is visible there. The retry replays on the same idempotency key
      -- (derived from the natural key below, never from this row's id) and adopts the entry. The
      -- opposite arrangement — a row written first — would be a claim that a seller was paid
      -- when nobody was.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists engagement_grants (
        id               uuid          primary key default gen_random_uuid(),
        window_id        uuid          references engagement_windows (id),
        grant_kind       text          not null,
        -- Who received the value. For a bounty, the seller; for a fee subsidy, the platform's own
        -- fee account — the seller's benefit there is the fee they did NOT pay.
        beneficiary      text          not null,
        listing_id       uuid          references listings (id) on delete set null,
        amount_shards    numeric(78,0) not null,
        -- NOT NULL. See the block above. Text rather than a uuid FK: it is a row micro-ledger
        -- owns, exactly like escrows.hold_entry_id.
        ledger_entry_id  text          not null,
        correlation_id   text,
        granted_at       timestamptz   not null default now(),

        -- The closed list, and it is closed for the reason in this migration's header: every kind
        -- here pays a SELLER or the platform's own fee line. There is no kind that funds a bid,
        -- an offer or a buyer, and adding one would have to survive review of this comment.
        constraint engagement_grants_kind_known check (
          grant_kind in ('listing_fee_subsidy','first_listing_bounty')
        ),
        constraint engagement_grants_amount_positive check (amount_shards > 0),
        -- A bounty names the listing it was earned by; a subsidy names the listing whose fee it
        -- paid. Either way a grant with no listing is a payment nobody can trace to a cause.
        constraint engagement_grants_names_a_listing check (listing_id is not null),
        -- **THE BENEFICIARY IS NEVER AN ENGAGEMENT ACCOUNT.** A grant that credited an
        -- engagement account would be the programme paying itself, which inflates the spend
        -- figure §7.4 exists to make countable.
        constraint engagement_grants_beneficiary_is_not_the_programme check (
          beneficiary not like 'engagement:%'
          and beneficiary <> 'platform:engagement-treasury'
        )
      );

      -- One bounty per (window, listing), and one subsidy per (window, listing). The natural key
      -- the ledger idempotency key is ALSO derived from, so a replayed post and a refused insert
      -- describe the same fact rather than disagreeing about it.
      create unique index if not exists engagement_grants_natural_uniq
        on engagement_grants (grant_kind, listing_id) where listing_id is not null;

      create index if not exists engagement_grants_window_idx
        on engagement_grants (window_id, granted_at desc);

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- WHAT MAKES A WAIVER A SUBSIDY RATHER THAN A DISCOUNT.
      --
      -- A zero-fee window works through the fee rate this service ALREADY snapshots per listing
      -- ('listings.platform_fee_bps', migration 5) — so the seller pays nothing and settlement's
      -- one-balanced-entry arithmetic is untouched. But a waiver alone means the engagement
      -- account funds NOTHING: the platform simply earns less, the "budget" is fictional, and 21
      -- §4's promise that an auditor can reconstruct the programme from the ledger is false for
      -- every subsidy.
      --
      -- So the listing remembers WHICH window waived its fee and WHAT RATE was waived, and at
      -- settlement the forgone amount is posted out of 'engagement:market' into the platform's
      -- own fee line. The seller pays nothing, the revenue line is whole, and the cost lands
      -- where the programme can be held to it. Without 'waived_fee_bps' the original rate is
      -- gone — 'platform_fee_bps' is already 0 by then — and the subsidy could not be sized.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      alter table listings add column if not exists engagement_window_id uuid
        references engagement_windows (id);
      alter table listings add column if not exists engagement_waived_fee_bps integer;

      alter table listings drop constraint if exists listings_waiver_is_complete;
      alter table listings add constraint listings_waiver_is_complete check (
        (engagement_window_id is null) = (engagement_waived_fee_bps is null)
      );
      -- A waiver that waived nothing is not a waiver, and a rate outside the fee's own range
      -- would size a subsidy nobody could have been charged.
      alter table listings drop constraint if exists listings_waived_rate_in_range;
      alter table listings add constraint listings_waived_rate_in_range check (
        engagement_waived_fee_bps is null
        or (engagement_waived_fee_bps > 0 and engagement_waived_fee_bps <= 10000)
      );
      -- A waived listing charges the seller nothing. Stated here so the two columns cannot drift
      -- into describing a listing that was "subsidised" while still charging full freight.
      alter table listings drop constraint if exists listings_waived_charges_nothing;
      alter table listings add constraint listings_waived_charges_nothing check (
        engagement_window_id is null or platform_fee_bps = 0
      );

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- NEVER GHOST DEMAND — 21 §5, as three constraints rather than three sentences.
      --
      -- Every route by which value could enter this marketplace as DEMAND names a subject: an
      -- escrow holds it, a bid places it, an offer makes it. If none of those subjects can be an
      -- engagement account, then the platform cannot bid against its own sellers however the
      -- code is later written — including by somebody who has never read 21 §2.
      --
      -- Safe as an ALTER on live tables: no engagement subject has ever existed in this estate
      -- (the grammar itself only learned the spelling in micro-contracts 743e9ca), so no
      -- existing row can violate these and the validation scan cannot fail.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      alter table escrows drop constraint if exists escrows_never_platform_funded;
      alter table escrows add constraint escrows_never_platform_funded check (
        subject not like 'engagement:%' and subject <> 'platform:engagement-treasury'
      );

      alter table bids drop constraint if exists bids_never_platform_funded;
      alter table bids add constraint bids_never_platform_funded check (
        bidder_subject not like 'engagement:%' and bidder_subject <> 'platform:engagement-treasury'
      );

      alter table offers drop constraint if exists offers_never_platform_funded;
      alter table offers add constraint offers_never_platform_funded check (
        offerer_subject not like 'engagement:%'
        and offerer_subject <> 'platform:engagement-treasury'
      );
    `,
  },
]

/**
 * The version this build requires. `index.ts` asserts it at boot and refuses to serve below it.
 *
 * More than hygiene here: below version 6 the `listings_active_is_escrowed` constraint does not
 * exist and a listing could be opened for business holding nothing, and below version 9 neither
 * `orders_listing_uniq` nor `orders_partition` exists — so one listing could be sold twice and an
 * order could be written whose fee, royalty and proceeds do not add up to its price.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * A new service leaves this at 0.
 *
 * There is nothing to baseline against: 03-repository-responsibilities lists `cloudsforge-market`
 * as `new`. No marketplace exists in the frozen estate — no listings table, no orders, no escrow,
 * no reservation concept anywhere. Nothing is ported and nothing is adopted.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'engagement_grants',
  'engagement_windows',
  'disputes',
  'moderation_cases',
  'order_royalties',
  'orders',
  'offers',
  'bids',
  'escrows',
  'listing_royalties',
  'listings',
  'verifications',
  'collection_royalties',
  'collections',
  'idempotency_keys',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
