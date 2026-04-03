# Filament inventory

Sync a **markdown purchase log** in this repo with **[Spoolman](https://github.com/Donkie/Spoolman)** or **[Bambuddy](https://github.com/maziggy/bambuddy)**.

## Requirements

- [Cursor](https://cursor.com/) is optional. It can help you shape the inventory markdown from your Amazon orders so the table matches what this project expects—open this repo as the workspace if you use it. If you let the assistant use a browser to read orders, you sign in yourself in that window; do not put your Amazon password in the chat.
- [Node.js](https://nodejs.org/) 20+

## How to use

1. **Install dependencies** — run `npm install` once.

2. **Configure the backend** — copy **`.env.example`** to **`.env`** and set URLs and credentials to match (see **[Environment](#environment-env)**). 

3. **Update the purchase table** — edit **`data/amazon-filament-inventory.md`** with the conventions in **[`filament-inventory.mdc`](.cursor/rules/filament-inventory.mdc)**. To pull orders from Amazon in Cursor, use **Agent** + browser and paste the prompt from **[Starter prompt](#starter-prompt)**.

4. **Dry-run sync**
   - **Spoolman (default):** `node main.js --sync`
   - **Bambuddy:** `node main.js --sync --system bambuddy`

5. **Push for real** — same command as step 4 with **`--execute`**.

## Environment (`.env`)

| Variable | Backend | Required |
|----------|---------|----------|
| `SPOOLMAN_URL` | Spoolman | Yes (sync/clean) |
| `SPOOLMAN_BASIC_USER` / `SPOOLMAN_BASIC_PASS` | Spoolman | If you use Basic auth |
| `BAMBUDDY_URL` | Bambuddy | Yes (origin only, no `/api/v1`) |
| `BAMBUDDY_API_KEY` | Bambuddy | Yes |
| `LOG_LEVEL` / `DEBUG=1` | Both | Optional — `debug` logs every HTTP |

Cleanup **with `--execute`** can wipe **all** data on that backend for objects this tool manages—only use it when you intend a full reset.

## Starter prompt

**Agent** mode + MCP browser. Paste into chat (edit the **Goal** line for a different time window).

```text
You have access to the browser tools. Use them to help update my filament purchase log.

@data/amazon-filament-inventory.md — follow this file’s project rule for the markdown table (column order, Item name, Order ID from real order pages, pack splits, unit pricing).

Goal: Reconcile my inventory with filament purchases from roughly the last 6 months by reading my live Amazon order pages in the browser (not by asking me to paste full order dumps unless the site blocks you).

How we handle login (non-negotiable):
- Do not ask me for my Amazon password in chat.
- Open (or navigate to) Amazon sign-in / orders in the browser; if login, CAPTCHA, OTP, or “approve sign-in” appears, pause and tell me to complete it manually in that tab, then say when I’m done so you continue.
- If automated access to order content fails (blocks, empty snapshots), switch to: I’ll complete the minimum manual step in the tab, you retry; or I’ll paste one “Order details” page at a time.

What to do after I can see “Your Orders”:
1. List orders in the target window (last ~6 months). Focus on items that are 3D printer filament, accessories we already track as filament-adjacent in the table, or obvious multi-pack spool listings—skip unrelated categories unless I ask otherwise.
2. For each relevant order, open Order details and extract: exact Amazon Order ID (from URL or page), line items, quantities, per-line subtotals, status/refunds if shown, and anything needed for pack splits per the rule.
3. Update `data/amazon-filament-inventory.md`: add missing rows or fix Order IDs / qty / pricing / splits to match what you read. Do not leave real inventory rows on “—” Order ID once the correct order is known.
4. Work in batches (e.g. by month or page of orders) so we don’t lose progress if the session drops.
5. When finished with the session, summarize: orders processed, rows added/changed, and any orders you couldn’t open.

If navigation is slow or paginated, keep going until the 6-month window is covered or I tell you to stop.
```

If you are **already signed in** to Amazon in the browser tab the agent will use, add a line like this (use your regional orders URL if needed):

```text
I’m already signed into Amazon in the browser tab you’ll use—start from https://www.amazon.com/your-orders (or my regional equivalent) and proceed.
```

## CLI

From the repository root (next to `main.js`):

```bash
node main.js --sync
```

That **dry-runs** a sync to **Spoolman** (no backend changes). For real writes, add `--execute` (see [Arguments](#arguments)).

Full usage: `node main.js --help`

### Arguments

| Argument | What it does |
|----------|----------------|
| `--sync` | Builds `data/inventory.json` from the markdown table, then runs a **push** to the backend |
| `--execute` | Performs **real** changes: live push, live cleanup. Without it, runs are a **dry run** / rehearsal. |
| `--system` | Backend: `spoolman` (default) or `bambuddy`. |
| `--clean` | Runs **backend cleanup** for data this tool manages. Respects dry run vs live like push |

## License

Private project; no license declared in-repo.
