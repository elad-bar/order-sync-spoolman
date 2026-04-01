# Filament inventory

Small Node.js tooling that keeps a **human-editable Amazon filament purchase log** in sync with **[Spoolman](https://github.com/Donkie/Spoolman)** (3D printing filament and spool inventory).

**Flow:** `data/filament-inventory.md` → generated JSON under `data/spoolman/` → Spoolman REST API.

## Requirements

- [Node.js](https://nodejs.org/) **20+** — runs the migrate and Spoolman scripts.
- **[Cursor](https://cursor.com/)** (recommended) — project rules under `.cursor/rules/` apply when you work on `data/filament-inventory.md`. Use **Cursor’s browser** (open Amazon order or product pages in a tab the agent can access) so details like line-item subtotals, quantities, recommended nozzle/bed temps, and listing copy can be reconciled with the table. That matches how the filament rule expects rows to be built (order details over title-only guesses). You can still edit the markdown in any editor; Cursor + browser is the supported path for fast, accurate Amazon pulls.

## Repository layout

| Path | Purpose |
|------|---------|
| `data/filament-inventory.md` | Source of truth: markdown table of filaments, temps, pricing, order metadata |
| `data/spoolman/` | Generated `vendors.json`, `filaments.json`, `spools.json` (gitignored by default) |
| `scripts/` | CLI entry points (migrate, export, cleanup) |
| `lib/` | Markdown parsing, Spoolman client, import helpers |

Column order, item naming, pack splits, pricing, and reconciliation notes are defined in `.cursor/rules/filament-inventory.mdc` (scoped to `data/filament-inventory.md` in Cursor).

## Configuration

Copy **`.env.example`** to **`.env`** in the project root (`.env` is gitignored). Spoolman push scripts need a base URL:

```env
SPOOLMAN_URL=http://your-host:7912
```

If your instance uses HTTP Basic auth, set:

```env
SPOOLMAN_BASIC_USER=...
SPOOLMAN_BASIC_PASS=...
```

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run inventory:migrate` | Reads `data/filament-inventory.md` and writes `data/spoolman/*.json` (no network) |
| `npm run spoolman:push` | POSTs vendors, filaments, and spools from that JSON into Spoolman. Does **not** delete extra records already in Spoolman |
| `npm run spoolman:cleanup` | Deletes Spoolman data via API (see `scripts/spoolman-cleanup.mjs` for flags) |
| `npm run spoolman:reload` | Full reset: cleanup **all** spools, filaments, and vendors in Spoolman, then push from JSON |

**Warning:** `spoolman:reload` makes the live Spoolman catalog match the JSON exactly and **drops** weights, history, and anything else not represented in the exported files. Use when you intentionally want a clean mirror of the markdown-derived data.

### CLI overrides

- Migrate: `node scripts/migrate-from-md.mjs [--markdown PATH] [--out DIR]`
- Export: `node scripts/export-to-spoolman.mjs [--dir PATH]`

## Typical workflow

1. Update `data/filament-inventory.md` after new orders or corrections — in Cursor, open the relevant Amazon pages in the browser tab and work with the agent so rows follow the rule (especially order detail pages for subtotals and qty).
2. Run `npm run inventory:migrate` to refresh local JSON.
3. Run `npm run spoolman:push` (incremental) or `npm run spoolman:reload` (full replace).

## License

Private project; no license declared in-repo.
