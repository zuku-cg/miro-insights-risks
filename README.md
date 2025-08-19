# Miro Insights & Risks — PoC (MCP/REST)

Extract **Insights** and **Risks** from a meeting transcript using Claude (or a local heuristic fallback) and populate a Miro board with two frames: **Insights** and **Risks**. Runs as a small Node.js CLI and supports both **REST** and **MCP** transports.

> **Status:** PoC-quality but hardened (idempotent, batched, de-duped). Dry-run by default.

---

## Features

* 🔎 **Extraction** via Claude (`claude-3-5-sonnet-latest`) or `--local-extract` fallback
* 🧩 **Idempotency & de-dupe** using a `runId` hash appended to sticky content
* 🧱 **Frames ensured**: creates “Insights” and “Risks” if missing
* 🧮 **Grid layout**: neat coordinates, stable order
* 🚦 **DRY\_RUN by default**; `--execute` to write
* 🔁 **Batching & backoff**; sensible error handling
* 🔌 **Transports**: REST (built-in) and MCP (uses a running MCP server, e.g. `mcp-miro`)

---

## Prerequisites

* **Node.js 18+** (uses built‑in `fetch`)
* **Miro access token** (Bearer) — via your dev app and OAuth flow
* **Anthropic API key** *(optional if using `--local-extract`)*

### Getting a Miro token quickly (local OAuth helper)

This repo includes `miro-oauth-helper.cjs`:

1. In your Miro Dev App, set redirect URI to: `http://localhost:4357/callback`
2. In a terminal:

   ```bash
   npm i express
   export MIRO_CLIENT_ID="..."
   export MIRO_CLIENT_SECRET="..."
   # Optional safety: don’t print full tokens unless you opt in
   export PRINT_TOKEN=0
   node miro-oauth-helper.cjs
   # open the printed URL -> approve -> follow terminal instructions
   ```
3. Export the token in your shell:

   ```bash
   export MIRO_TOKEN="<paste access token>"
   ```

> The helper masks tokens in the browser. Set `PRINT_TOKEN=1` if you want it to print full `export` lines in the terminal.

---

## Install

```bash
npm i
npm i -D tsx dotenvx
```

Create `.env` (not committed):

```
MIRO_TOKEN=
ANTHROPIC_API_KEY=
BOARD_ID=
PRINT_TOKEN=0
```

Add handy npm scripts:

```bash
npm pkg set scripts.dry="dotenvx run -- tsx miro-poc.ts --transport mcp --mcp-cmd node --mcp-args \"../mcp-miro/build/index.js --token \$MIRO_TOKEN\" --board \$BOARD_ID --transcript ./meeting.txt"
npm pkg set scripts.exec="dotenvx run -- tsx miro-poc.ts --transport mcp --mcp-cmd node --mcp-args \"../mcp-miro/build/index.js --token \$MIRO_TOKEN\" --board \$BOARD_ID --transcript ./meeting.txt --execute"
```

> If you don’t want MCP, you can use `--transport rest` and skip the MCP server entirely.

---

## Running with MCP (recommended)

The CLI connects to a **running MCP server** that exposes Miro tools (e.g., `bulk_create_items`, `create_sticky_note`, `create_frame`, list/read tools). The example below uses `mcp-miro`.

1. Start the server in one tab:

```bash
# example using a local clone of mcp-miro
git clone https://github.com/evalstate/mcp-miro.git
cd mcp-miro && npm i && npm run build
node build/index.js --token "$MIRO_TOKEN"
```

2. In another tab, run the PoC (DRY\_RUN):

```bash
npx dotenvx run -- tsx miro-poc.ts \
  --transport mcp \
  --mcp-cmd node \
  --mcp-args "../mcp-miro/build/index.js --token $MIRO_TOKEN" \
  --board "$BOARD_ID" \
  --transcript ./meeting.txt
```

3. Execute for real:

```bash
npx dotenvx run -- tsx miro-poc.ts ... --execute
```

> Output shows a preview (counts, sample note, coordinates) in DRY\_RUN, and a summary with created/failed counts after EXECUTE.

---

## Running with REST (no MCP)

```bash
npx dotenvx run -- tsx miro-poc.ts \
  --transport rest \
  --board "$BOARD_ID" \
  --transcript ./meeting.txt
```

---

## Flags & Options

| Flag              | Type            | Default                    | Purpose                                                  |
| ----------------- | --------------- | -------------------------- | -------------------------------------------------------- |
| `--transport`     | `mcp` \| `rest` | `rest`                     | Choose call path to Miro                                 |
| `--mcp-cmd`       | string          | `node`                     | Executable to spawn MCP server                           |
| `--mcp-args`      | string          | `""`                       | Args for MCP server (e.g., path & `--token $MIRO_TOKEN`) |
| `--board`         | string          | —                          | Miro board ID (required)                                 |
| `--transcript`    | path            | —                          | Plaintext transcript file (required)                     |
| `--execute`       | boolean         | `false`                    | Actually create items (defaults to DRY\_RUN)             |
| `--model`         | string          | `claude-3-5-sonnet-latest` | Anthropic model                                          |
| `--anthropic-key` | string          | —                          | Provide key via flag instead of env                      |
| `--local-extract` | boolean         | `false`                    | Skip Claude; use heuristic extractor                     |

**Environment variables**

* `MIRO_TOKEN` (required for MCP and REST)
* `ANTHROPIC_API_KEY` (required unless `--local-extract`)
* `BOARD_ID` (board to target)
* `PRINT_TOKEN` (OAuth helper: `0` mask, `1` print full token)

---

## How it works

1. **Ingest** transcript from file
2. **Extract** `insights[]` and `risks[]` via Claude (or heuristic fallback)
3. **Ensure frames**: “Insights” and “Risks” (creates if missing)
4. **De‑dupe** using `runId = sha256(transcript).slice(0,10)` in sticky content
5. **Layout** grid notes within frames (stable coordinates)
6. **Write**: REST or MCP, batched with backoff
7. **Verify** by reading back notes and counting those with the current `runId`

> For scale, consider adding per-item `iid` hashes and frame auto‑pagination (see repo issues for guidance).

---

## Example output

**Dry run preview**

```json
{
  "boardId": "b...",
  "runId": "e3b0c44298",
  "frames": [
    { "id": "307...", "title": "Insights" },
    { "id": "308...", "title": "Risks" }
  ],
  "toCreate": { "insights": 3, "risks": 3, "total": 6 },
  "sample": {
    "insight": { "content": "...\n[runId:e3b0c44298]", "x": -620, "y": -260 },
    "risk": { "content": "...\n[runId:e3b0c44298]", "x": 1180, "y": -260 }
  }
}
```

---

## Security notes

* **Secrets** live in your shell or `.env` (not in code). Never commit tokens.
* OAuth helper prints full tokens **only** if `PRINT_TOKEN=1`.
* No secrets are written to disk by the CLI; logs are concise.
* Auth errors (`401/403`) fail fast; `429` uses exponential backoff.

---

## Troubleshooting

* `Claude API error: 401 invalid x-api-key` → export a real key in the **same tab**:

  ```bash
  export ANTHROPIC_API_KEY="sk-ant-..."
  ```

  Optional: smoke test with `curl` as shown in issues.
* `MCP server not found` → run it in another tab and pass `--mcp-args` correctly.
* No notes created → you’re in DRY\_RUN; add `--execute`.
* Duplicates → expected if transcript changed (new `runId`). For cross-run de‑dupe, see “Scale” notes.

---

## Project layout

```
miro-poc.ts             # main CLI (REST + MCP)
transport-mcp.ts        # MCP transport (client adapter)
miro-oauth-helper.cjs   # local OAuth helper for tokens
meeting.txt             # example transcript (you can replace)
```

> You may add `transport-mcp-sdk.ts` later for the official SDK-based transport (see roadmap).

---

## Roadmap

* SDK-based MCP transport (discovery + Ajv validation)
* Per-item `iid` hashes for cross-run de‑dupe
* Frame pagination when items exceed capacity
* Optional categories: Actions, Decisions, Dependencies

---

## License

MIT © Your Organisation
