# Filament inventory

Sync a **markdown purchase log** in this repo with **[Spoolman](https://github.com/Donkie/Spoolman)** or **[Bambuddy](https://github.com/maziggy/bambuddy)**.

## Requirements

- **[Cursor](https://cursor.com/)** — open this repo as the workspace root and enable **project rules** (see **[`.cursor/rules/filament-inventory.mdc`](.cursor/rules/filament-inventory.mdc)** for table columns and row rules).
- [Node.js](https://nodejs.org/) 20+

## Quick start

Your source table is **`data/amazon-filament-inventory.md`** (outputs to `data/inventory.json`). Generated files live under **`data/`** (often gitignored).

1. `npm install`
2. Edit **`data/amazon-filament-inventory.md`** — in Cursor, **open that file** (or @ it in Chat) so the inventory rule applies when you use AI on the table.
3. `node main.js migrate`
4. Copy `.env.example` to `.env` and set URLs / credentials (see below).
5. `node main.js --sync`  
   Bambuddy: `node main.js --sync --system bambuddy`

Add `--execute` when you want real writes and destructive cleanup. Without it, runs are a **dry run** (safe rehearsal).

`node main.js --help` lists flags.

## CLI

| Command | Meaning |
|--------|--------|
| `node main.js migrate` | Table → `data/inventory.json` only |
| `node main.js --sync` | Migrate, then push to backend (`--system spoolman` default) |
| `node main.js --clean` | Backend cleanup (dry run unless `--execute`) |
| `node main.js --clean --sync --execute` | Cleanup, migrate, push — all live |

Use `--system bambuddy` for Bambuddy. Order when combining: cleanup runs first, then migrate + push if `--sync` is set.

**npm shortcuts:** `npm run inventory:migrate`, `npm run spoolman:push`, `npm run bambuddy:push`, etc. — see `package.json` → `scripts`.

## Environment (`.env`)

| Variable | Backend | Required |
|----------|---------|----------|
| `SPOOLMAN_URL` | Spoolman | Yes (sync/clean) |
| `SPOOLMAN_BASIC_USER` / `SPOOLMAN_BASIC_PASS` | Spoolman | If you use Basic auth |
| `BAMBUDDY_URL` | Bambuddy | Yes (origin only, no `/api/v1`) |
| `BAMBUDDY_API_KEY` | Bambuddy | Yes |
| `LOG_LEVEL` / `DEBUG=1` | Both | Optional — `debug` logs every HTTP |

Cleanup **with `--execute`** can wipe **all** data on that backend for objects this tool manages—only use it when you intend a full reset.

## License

Private project; no license declared in-repo.
