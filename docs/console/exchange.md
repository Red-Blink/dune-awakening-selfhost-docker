# Market Board (Exchange)

**Status:** Current | **Last Updated:** August 2026

The Market Board is a **read-only** view of the in-game CHOAM exchange. It reads the
game's own exchange tables (the game writes them; the console never mutates them) so
an admin can see what is currently listed for sale — prices, stock, and sellers — at
a glance. It is modeled on the Market tab from
[Icehunter/dune-admin](https://github.com/Icehunter/dune-admin), rendered in the
console's own theme and components.

See [API-REFERENCE.md](API-REFERENCE.md#market-board) for the endpoint contract.

The panel has two tabs: **Exchange** (the read-only board below) and **Bot
items** (the Market Bot's editable catalog — see [Bot items](#bot-items-catalog-overrides)).
The filter gear and Market Bot icons are unrelated to the tabs and work the
same from either one.

## What it shows

The board is **aggregated by item**: one row per `(template_id, quality_level)`,
with the **lowest price**, **total stock**, and **listing count** across all matching
sell orders. Item name, category, and icon come from the local
`runtime/data/admin-items.json` catalog (`template_id` falls through as the name when
the catalog has no entry); tier is parsed from a `T<n>_` template prefix when present.

Clicking a row drills down to the **individual sell orders** for that item, each with
its resolved seller, price, quantity, and grade.

### Seller resolution

A listing's seller (`owner_id`) is resolved the same way the Players page resolves a
character: `dune.actors.owner_account_id → dune.player_state.character_name`, falling
back to the actor's `class`, then `Unknown`. `player_state` is the decryption view, so
this works without touching encrypted account data.

## Bot listing identification

This is the one piece worth understanding before trusting the `Bot listings` filter.

- The **only** database-level signal that an order is not a real player's is
  `dune.dune_exchange_orders.is_npc_order` (a boolean).
- Every `is_npc_order = true` order belongs to the in-game CHOAM broker NPC (a single
  actor whose class is `Revy`). External market-bot tools operate by posting their
  sell orders **as this NPC**, so in practice `is_npc_order = true` is *the bot
  channel*.

Consequences, by design:

- `is_npc_order = true` lumps the game's own NPC vendor together with any bot posting
  through it — you **cannot** distinguish one bot tool from another at the database
  level.
- A bot that instead lists through a **normal player account** would be classified as
  a *Player* listing, not a *Bot* listing. So `is_npc_order` alone is a **necessary
  but not complete** definition of "bot".

To cover that gap without a schema change, the board lets an admin widen the
definition with a configurable **allowlist of bot owner ids** (see below). The
effective rule is:

- **bot** = `is_npc_order` **OR** `owner_id ∈ botOwnerIds`
- **player** = not a bot (not `is_npc_order` and not in `botOwnerIds`)
- **all** = no owner filter

The board defaults to **All listings**; switch to **Player listings** to focus on
real player activity (most servers are dominated by NPC/broker stock) or **Bot
listings** to see only bot/broker stock.

## Filter configuration (gear icon)

The gear beside the owner selector opens a small overlay with two editable lists:

- **Bot user ids** — owner ids to treat as bot listings, unioned with `is_npc_order`
  as described above. Use this to capture bots that post through player accounts, or
  bots run by other tools. The in-game broker (Revy) appears here as a built-in,
  removable entry: it is classified as a bot via `is_npc_order` rather than an id, and
  removing it (persisted as `includeNpcBroker: false`) stops treating its orders as
  bot — they then fall under player/all like any other seller. Restore it any time.
- **Blacklisted ids** — owner ids to hide from the market entirely. A blacklisted
  seller is excluded from **every** view and every owner filter (including "All").

Both lists are stored **console-side only**, in
`runtime/generated/exchange-config.json` — **no game data is changed**. Ids are
validated as numeric owner-id strings, deduped, and length-capped. Saving the config
is a mutation: it is rate-limited and written to the audit log (only the id counts
are recorded, no personal data). Blacklisting is a moderation action — it changes
what the market shows — which is why every change is audited.

## Market Bot

The Bot button beside the filter gear opens the console-managed **Market Bot**
(ported from [jeffstokes72/eda-exchange-bot](https://github.com/jeffstokes72/eda-exchange-bot),
which itself ports Easy Dune Admin's exchange seeder — the same engine the EDA
Exchange Bot addon drives through the scheduler bridge, now first-class):

- **Market reseed** stocks the CHOAM exchange with NPC sell listings from a bundled
  seed plan (`runtime/data/market-seed-plan.json`) at a configurable price multiplier. Every run
  is **backup → clear the bot's own listings on that exchange → seed**; player
  listings are never touched. Standalone augment items are seeded with their stat
  rolls pinned to the bottom 20% of their ranges; the schedule's **augment
  pricing** option sells them either below their schematics (half the pattern's
  price at the same grade — the default) or at the plan's original prices. Either
  way, buying the pattern and crafting for a better roll stays the premium path.
- **Category multipliers** (1–5x, default 1 = no change) additionally scale the
  seeded prices of three endgame categories on top of the base price multiplier:
  **augments & augment schematics** (matched by template, so the augment pricing
  discount and the multiplier always agree on what an augment is), **ranked
  armor** (worn gear at grades 1–5, including stillsuits and radiation suits),
  and **ranked weapons** (grades 1–5). Armor and weapons are identified by the
  exchange's own taxonomy — the top-level category in the high byte of
  `category_mask` (0 = armor/garments, 1 = weapons) — so grade-0 stock of the
  same gear and every other catalog row keep the base multiplier alone. The
  multiplier is applied before the usual stepped price rounding, and relative
  pricing within a category is preserved (a discounted augment item stays at
  half its pattern's price when both are boosted).
- **Commodity stacks** let the operator set how many full listings of selected
  base-useful commodities each reseed writes (1–20, default 2 — the bundled
  plan's `listings_per_grade`). Units per stack stay at the plan maximum, so
  10 Fuel Cell stacks is 5,000 units. The allowlist is power fuels and
  lubricants, windtrap filters, spice (melange, residue, flour sand, spice
  sand), refining ingots, building materials, schematic pattern fragments, and
  iodine pills. Everything else keeps the plan default. Buyback caps are
  per-unit and do not change.
- **Remove NPC listings** (unseed) empties the bot's own listings on the selected
  exchange without reseeding — the "clear market" ability the EDA bot had before
  Market Bot became console-native. The console counts the bot's listings
  read-only first and only takes a backup + clears when there is something to
  remove. Player listings and pending seller "Take Solari" payments are never
  touched (payments are owned by the seller, not the bot). The seed schedule is
  left as-is, so an **enabled** reseed schedule repopulates the market on its
  next run; disable the schedule to keep the market unseeded.
- **Buyback sweeps** buy player sell listings whose per-unit ask is at or below the
  buyback percentage of the chosen **price basis** — seeded NPC price at that
  listing's grade (default), or the live player-market average / lowest ask with
  seeded fallback. The buyback schedule carries its own category multipliers
  (they may differ from reseed on purpose). The reconstructed seeded basis still
  uses the **reseed** schedule's augment pricing (discounted vs original) so
  ready-made augment caps track what the bot actually lists. Whole listed stacks are
  bought in one pass, sellers are paid through never-expiring "Take Solari"
  payment entries, and concurrent sweeps are safe at the database level
  (`FOR UPDATE ... SKIP LOCKED`). Every run probes eligibility with a read-only
  query first and only takes a backup + sweeps when something qualifies.
  **Probe eligibility** can be run on demand without a backup and explains the
  result with counts for eligible listings, asks above the price threshold,
  templates missing from the seed plan, and invalid-price or empty-stack rows.
- **Buyback Sweep Log** records what the bot did with player sell listings.
  Purchases are `0x0` / success. On a write sweep, leftover eligible listings
  are `0x5` (past Max Buys) or `0x6` (SKIP LOCKED / concurrent sweep), ranked
  from how many purchases happened before that row — so a cheaper locked
  listing is not mislabeled as Max Buys when the loop filled with later rows.
  Idle ticks with player listings and **Refresh log (dry-run)** also classify
  eligible rows (`0x0`), Max Buys leftovers (`0x5`), and skip reasons (`0x1`
  price too high, `0x2` no reference price, `0x3` invalid price, `0x4` invalid
  stack). Dry-run never emits `0x6`. Eligible listings take a top-N cap of
  1000, then leftover budget fills skip reasons; stored batches reserve room
  for leftovers so Max Buys / skipped-locked rows are not crowded out by
  purchases. An empty exchange skips classify. Idle classify on an unchanged
  overpriced board is throttled to at most hourly. Batches are stored in
  `runtime/generated/market-bot/buyback-log.json` (20 most recent, dropped
  after 5 days). The scheduler prunes expired batches at most hourly even when
  buyback is disabled.
- **Backup labeling and retention**: every Market Bot database write is preceded
  by a backup whose filename carries the origin (for example
  `dune-db-market-bot-buyback-<scope>-<timestamp>.backup`; the sidecar's
  `backup_origin` records `market-bot-seed`, `market-bot-buyback`, or
  `market-bot-unseed`), and the Backups page shows them as **Market Bot
  Backup**. Because schedules mint backups unattended, only the **5 newest**
  Market Bot backups are kept: after every successful Market Bot backup, older
  ones are pruned by the sidecar origin — including unlabeled ones written by
  earlier releases. Manual, automatic, and safety backups are never candidates.
  Set `DUNE_MARKET_BOT_BACKUP_KEEP` to change the count.
- **Schedules** run unattended inside the console API process (no browser page needs
  to stay open) and survive restarts. They are console-owned and authorized by RBAC
  at save time. Seed and buyback share one running lock, so they can never write the
  exchange concurrently.

### Bot items (catalog overrides)

The **Bot items** tab, alongside the read-only **Exchange** tab, lets an admin
edit the Market Bot's sellable catalog per item, beyond the reseed schedule's
category-wide multipliers and its ~30-item commodity stack allowlist:

- **Overrides** — enable/disable, reprice, or change the listing count of any
  bundled seed-plan row. A disabled item is dropped from both reseed and
  buyback entirely, not just hidden in the UI.
- **New items** — add a template not in the bundled plan at all. New items can
  only be picked from `runtime/data/admin-items.json` (the same catalog behind
  Give Items / Care Packages), never typed freely. `buildings`, `contracts`,
  and `emotes` categories are excluded from the picker. Any template id in the
  seed plan's own `unsafe_template_ids` list (NPC-only weapon variants,
  story-unique items, etc., flagged by the upstream generator) is hard-blocked
  from both the picker and from being edited if it already exists as an
  override.
- Overrides are stored console-side in `runtime/generated/market-bot/items.json`
  (`{ overrides: { <template_id>: { enabled, price, listings } }, newItems: {
  <template_id>: { name, category, price, listings, ... } } }`) and are never
  written back into the bundled `market-seed-plan.json`. They are merged in at
  read time for both the reseed run and the buyback price caps, so a
  disabled/repriced item's buyback cap always agrees with what the bot
  actually lists.
- `GET /api/exchange/market/items` returns the merged, display-ready catalog;
  `GET /api/exchange/market/items/catalog` backs the "add item" picker;
  `POST /api/exchange/market/items` saves overrides/new items/removals in one
  batch. Reads use the `exchange:market` action, saves use
  `exchange:market-write` — the same actions as the reseed/buyback schedule
  routes.

### EDA Exchange Bot retirement

EDA Exchange Bot is retired because Market Bot is now part of the console. On the
first startup after upgrading, the console validates and copies any surviving EDA
seed and buyback schedules into `runtime/generated/market-bot/`, changes their
source to `console`, backs up the old addon under
`runtime/backups/market-bot-eda-retirement/`, and removes the addon. If EDA was
already uninstalled, the console creates clean disabled Market Bot schedules; game
database listings are not changed. A malformed legacy schedule postpones removal
instead of discarding it, and an interrupted cleanup is retried on the next startup.

Reads, the eligibility probe, and dry-run log refresh require the `exchange:market` action; schedule saves,
run-now, and log clear require `exchange:market-write`. Neither is granted to the viewer tiers
that receive `exchange:read`, so by default only the admin tier (`exchange:*`) sees
the Market Bot button at all. All mutations are rate-limited and audited.

## Scope

The board itself is strictly read-only over game data — it only *classifies and
hides* listings. The Market Bot above is the deliberate exception: its seed and
buyback runs write the game's exchange tables, always behind an explicit RBAC
action, a confirm dialog (for manual runs), an audit entry, and a pre-write
database backup.
