# Filament inventory

Small Node.js tooling that keeps a **human-editable Amazon filament purchase log** in sync with **[Spoolman](https://github.com/Donkie/Spoolman)** (3D printing filament and spool inventory).

**What you get:** You keep one place—a table in this repo—with **what you bought**, **how much**, **temps**, and **order info**. The tool **turns that table into data Spoolman understands** and **updates your Spoolman catalog** so what you see in the app matches what’s on your shelf (without re-entering every spool by hand).

## Prerequisites

- **[Node.js](https://nodejs.org/) 20+** — the **`node`** command available in your terminal (`PATH`).
- **Once per copy of this project:** open a terminal in the project folder and run **`npm install`** so dependencies (for example **`dotenv`**) are available. After that you normally only run **`node cli.js …`**.

## Get started

Open a terminal **in this project’s folder** (where **`cli.js`** lives—the top level of the repo after you clone or copy it). If you haven’t already, complete **Prerequisites** above.

1. **Rebuild your inventory file from the purchase table.** Whenever you’ve updated **`data/amazon-filament-inventory.md`**, run **`node cli.js migrate`**. That step only reads your table and writes the structured file Spoolman will use—**no Spoolman, no network**.
2. **Tell the tool how to reach Spoolman.** Copy **`.env.example`** to **`.env`** in the same folder and set **`SPOOLMAN_URL`** to your server (for example **`http://192.168.1.10:7912`**). Add **user** and **password** there only if your Spoolman install uses HTTP Basic auth. You can skip **`.env`** until you’re ready to sync; **migrate** does not need it.
3. **Sync into Spoolman.** Run **`node cli.js push`**. That sends your inventory into Spoolman—creating what’s new and updating what changed—**without deleting** stuff that exists in Spoolman but isn’t in your table.

**Want Spoolman to match your table exactly—even if that means removing things that are only in Spoolman?** See **`reload`** below; it **empties the catalog** and **fills it again** from your inventory file. Day-to-day updates usually use **`push`** instead.

**Need a command list?** Run **`node cli.js --help`**.

**Optional — [Cursor](https://cursor.com/):** **`.cursor/rules/filament-inventory.mdc`** describes the markdown table columns. Any editor works.

## Commands and parameters

All invocations use:

```text
node cli.js <command> [options...]
```

Input and output files live under **`data/`** in this project (see each command). **`.env`** must sit next to **`cli.js`**; the tool loads it even if your terminal’s current folder is somewhere else.

### `migrate`

Reads **`data/amazon-filament-inventory.md`**, writes **`data/inventory.json`**.

No parameters.

```bash
node cli.js migrate
```

### `push`

Creates/updates Spoolman vendors, filaments, and spools from **`data/inventory.json`**. Needs **`.env`** with **`SPOOLMAN_URL`** (and optional Basic-auth vars).

No parameters.

```bash
node cli.js push
```

### `cleanup`

Always targets the **entire** Spoolman instance (all spools, filaments, vendors): **dry-run** by default (counts only), **`--apply`** performs the delete.

| Argument | Meaning |
|----------|---------|
| `--dry-run` | Preview only (**default** if you pass neither flag, or use this explicitly) |
| `--apply` | Delete everything listed in the preview |

**Examples**

```bash
node cli.js cleanup
node cli.js cleanup --dry-run
node cli.js cleanup --apply
```

### `reload`

**Use this when you want a clean slate:** Spoolman should show **only** what’s in your inventory file—no leftover vendors, filaments, or spools from earlier imports or manual edits.

**What happens, in order**

1. **Everything in Spoolman is removed** (all spools, then filaments, then vendors).
2. **Everything from your file is added again**, the same way **`push`** would—so the catalog mirrors **`data/inventory.json`** after you’ve run **`migrate`**.

**Trade-off:** Anything that existed only inside Spoolman (extra tweaks, history, or items you never put in your table) **is lost**. For normal “I bought more filament” updates, **`push`** is enough and safer.

```bash
node cli.js reload
```

## Environment variables (`.env`)

Used for **`push`**, **`cleanup`**, and **`reload`** only. File must sit next to **`cli.js`**.

| Variable | Required | Meaning |
|----------|----------|---------|
| `SPOOLMAN_URL` | Yes (for those commands) | Spoolman base URL, e.g. `http://host:7912` |
| `SPOOLMAN_BASIC_USER` | No | HTTP Basic user |
| `SPOOLMAN_BASIC_PASS` | No | HTTP Basic password |

## License

Private project; no license declared in-repo.
