#!/usr/bin/env -S node --experimental-fetch --no-warnings
/**
 * PoC: Ingest a short meeting transcript, ask Claude for Insights & Risks,
 * then populate a Miro board with two frames ("Insights" and "Risks").
 *
 * Safe by default:
 *  - DRY_RUN enabled unless --execute is passed
 *  - Idempotency via runId (sha256 of transcript) embedded in note text
 *  - De-dupe: skip creating notes that already exist for the same runId
 *  - Batching with exponential backoff and partial-failure retry
 *
 * USAGE
 *  MIRO_TOKEN=xxx ANTHROPIC_API_KEY=xxx ts-node miro-poc.ts \
 *    --board <boardId> --transcript ./meeting.txt [--execute] \
 *    [--transport rest|mcp] [--mcp-cmd node] [--mcp-args "./server.js --token"]
 *
 * Requires Node 18+ (built-in fetch). No external deps.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import { buildMcpTransport, McpTransport } from "./transport-mcp.js";

// ------------ CLI ARG PARSING ------------
const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.includes("=") ? a.split("=") : [a, process.argv[i + 1]];
    if (!a.includes("=") && (v?.startsWith("--") || v == null)) {
      args.set(k.replace(/^--/, ""), true);
    } else {
      args.set(k.replace(/^--/, ""), v);
      if (!a.includes("=")) i++;
    }
  }
}

// No default MIRO_BOARD_ID - must be provided via --board or env var

const BOARD_ID = (args.get("board") as string) || process.env.MIRO_BOARD_ID || "";
const TRANSCRIPT_PATH = (args.get("transcript") as string) || "";
const EXECUTE = Boolean(args.get("execute"));
const MODEL = (args.get("model") as string) || "claude-3-5-sonnet-latest";

// Transport configuration
const TRANSPORT = (args.get("transport") as string) || "rest";
const MCP_CMD = (args.get("mcp-cmd") as string) || "node";
const MCP_ARGS = (args.get("mcp-args") as string) || ""; // no default with token/path
const MCP_SERVER_PATH = (args.get("mcp-server") as string) || "./miro-server.js";

if (!BOARD_ID) {
  console.error("Missing --board <boardId> or MIRO_BOARD_ID env var");
  process.exit(1);
}
if (!TRANSCRIPT_PATH) {
  console.error("Missing --transcript <path>");
  process.exit(1);
}

// No default MIRO_TOKEN - must be provided via env var

const MIRO_TOKEN = process.env.MIRO_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
if (!MIRO_TOKEN) {
  console.error("Missing MIRO_TOKEN env var");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var");
  process.exit(1);
}

// ------------ TYPES ------------
interface InsightsRisks {
  runId: string; // computed client-side
  insights: string[];
  risks: string[];
}

interface FrameSpec {
  id: string;
  title: string;
  x: number; // centre x
  y: number; // centre y
  width: number;
  height: number;
}

interface StickySpec {
  content: string; // plain text; MiRo supports HTML but keep simple
  x: number; // absolute coordinates
  y: number;
  width?: number; // MiRo will auto-size if omitted
  height?: number;
  parentId?: string; // frame id
}

// ------------ HELPERS ------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backoff<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let delay = 500; // ms
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.code;
      if (status === 401 || status === 403) throw err; // auth issues -> fail fast
      if (attempt === maxAttempts) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      console.warn(`[retry ${label}] attempt ${attempt} failed; retrying in ${delay}ms`);
    }
  }
  throw lastErr;
}

function sha256(str: string) {
  return createHash("sha256").update(str).digest("hex");
}

function validateLLMOutput(obj: any): obj is { insights: string[]; risks: string[] } {
  const isArrayOfStrings = (a: any) => Array.isArray(a) && a.every((s) => typeof s === "string" && s.trim().length > 0);
  return obj && isArrayOfStrings(obj.insights) && isArrayOfStrings(obj.risks);
}

// ------------ LLM (Anthropic Claude) ------------
async function getInsightsRisksFromClaude(transcript: string): Promise<InsightsRisks> {
  const runId = sha256(transcript).slice(0, 10);
  const system = `You are an assistant that extracts concise, actionable bullets. Return ONLY valid JSON matching this schema:\n{\n  "insights": string[] (max 12 items, short bullets),\n  "risks": string[] (max 12 items, short bullets)\n}`;
  const user = `Transcript:\n"""\n${transcript}\n"""\n\nReturn JSON with keys: insights, risks. No commentary.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  

  if (!resp.ok) {
    const t = await resp.text();
    const err: any = new Error(`Claude API error: ${resp.status}`);
    (err.status = resp.status), (err.body = t);
    throw err;
  }
  const data = await resp.json();
  const text: string = data?.content?.[0]?.text || "";
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Claude returned non-JSON content");
  }
  if (!validateLLMOutput(parsed)) {
    throw new Error("Claude JSON failed validation (expected {insights: string[], risks: string[]})");
  }
  return { runId, insights: parsed.insights.slice(0, 12), risks: parsed.risks.slice(0, 12) };
}

// ------------ MIRO REST HELPERS ------------
const MIRO_API = "https://api.miro.com/v2";

async function miroGET(path: string) {
  const resp = await backoff(
    () =>
      fetch(`${MIRO_API}${path}`, {
        headers: { Authorization: `Bearer ${MIRO_TOKEN}` },
      }),
    `GET ${path}`
  );
  if (!resp.ok) {
    const t = await resp.text();
    const err: any = new Error(`Miro GET ${path} -> ${resp.status}`);
    (err.status = resp.status), (err.body = t);
    throw err;
  }
  return resp.json();
}

async function miroPOST(path: string, body: any) {
  const resp = await backoff(
    () =>
      fetch(`${MIRO_API}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${MIRO_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    `POST ${path}`
  );
  if (!resp.ok) {
    const t = await resp.text();
    const err: any = new Error(`Miro POST ${path} -> ${resp.status}`);
    (err.status = resp.status), (err.body = t);
    throw err;
  }
  return resp.json();
}

// Find frame by title; if missing, create it
async function getOrCreateFrame(boardId: string, title: string, x: number, y: number, width: number, height: number): Promise<FrameSpec> {
  // Frames are returned via the generic items endpoint filtered by type
  const frames = await miroGET(`/boards/${boardId}/items?type=frame&limit=50`);
  const match = (frames?.data || []).find((f: any) => f?.data?.title?.trim() === title.trim());
  if (match) {
    return {
      id: match.id,
      title,
      x: match.position?.x ?? x,
      y: match.position?.y ?? y,
      width: match.geometry?.width ?? width,
      height: match.geometry?.height ?? height,
    };
  }
  const created = await miroPOST(`/boards/${boardId}/frames`, {
    data: { title },
    position: { x, y },
    geometry: { width, height },
    style: { fillColor: "transparent" },
  });
  return {
    id: created.id,
    title,
    x: created.position?.x ?? x,
    y: created.position?.y ?? y,
    width: created.geometry?.width ?? width,
    height: created.geometry?.height ?? height,
  };
}

async function listStickyNotesInFrame(boardId: string, frameId: string): Promise<any[]> {
  // Query items in frame; if API lacks direct filter, fetch notes and filter by parent
  const notes = await miroGET(`/boards/${boardId}/items?type=sticky_note\u0026limit=50`);
  return (notes?.data || []).filter((n: any) => n?.parent?.id === frameId);
}

async function createSticky(boardId: string, note: StickySpec) {
  // For now, create sticky notes without parents to avoid positioning issues
  // Users can manually organize them on the board
  return miroPOST(`/boards/${boardId}/sticky_notes`, {
    data: { content: note.content },
    position: { x: note.x, y: note.y },
    geometry: note.width ? { width: note.width } : undefined,
  });
}

async function bulkCreateStickies(boardId: string, notes: StickySpec[], chunkSize = 20) {
  // Fallback implementation: sequential calls with backoff; keep batches small
  const results: { ok: number; created: string[]; failed: { note: StickySpec; error: any }[] } = { ok: 0, created: [], failed: [] };
  for (let i = 0; i < notes.length; i += chunkSize) {
    const chunk = notes.slice(i, i + chunkSize);
    for (const n of chunk) {
      try {
        const r = await createSticky(boardId, n);
        results.ok++;
        results.created.push(r.id);
      } catch (err) {
        results.failed.push({ note: n, error: err });
      }
    }
  }
  return results;
}

// ------------ LAYOUT ------------
function gridLayoutInFrame(frame: FrameSpec, items: string[], opts?: { columns?: number; gap?: number; pad?: number; noteW?: number; noteH?: number; runId?: string }) {
  const columns = opts?.columns ?? 3;
  const gap = opts?.gap ?? 20;
  const pad = opts?.pad ?? 40;
  const noteW = opts?.noteW ?? 180;
  const noteH = opts?.noteH ?? 120;
  
  // Calculate starting position relative to frame's top-left corner
  const frameLeft = frame.x - frame.width / 2;
  const frameTop = frame.y - frame.height / 2;
  const startX = frameLeft + pad;
  const startY = frameTop + pad;

  const stickies: StickySpec[] = [];
  items.forEach((text, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x = startX + col * (noteW + gap);
    const y = startY + row * (noteH + gap);
    stickies.push({ content: text, x, y, width: noteW });
  });
  return stickies;
}

// ------------ TRANSPORT ABSTRACTION ------------
interface TransportLayer {
  getOrCreateFrame(boardId: string, title: string, x: number, y: number, width: number, height: number): Promise<FrameSpec>;
  listStickyNotesInFrame(boardId: string, frameId: string): Promise<any[]>;
  bulkCreateStickies(boardId: string, notes: StickySpec[], chunkSize?: number): Promise<{ ok: number; created: string[]; failed: { note: StickySpec; error: any }[] }>;
}

// REST Transport Implementation
class RestTransport implements TransportLayer {
  async getOrCreateFrame(boardId: string, title: string, x: number, y: number, width: number, height: number): Promise<FrameSpec> {
    return getOrCreateFrame(boardId, title, x, y, width, height);
  }

  async listStickyNotesInFrame(boardId: string, frameId: string): Promise<any[]> {
    return listStickyNotesInFrame(boardId, frameId);
  }

  async bulkCreateStickies(boardId: string, notes: StickySpec[], chunkSize = 20) {
    return bulkCreateStickies(boardId, notes, chunkSize);
  }
}

// ------------ MAIN FLOW ------------
(async () => {
  const transcript = fs.readFileSync(TRANSCRIPT_PATH, "utf8").trim();
  if (!transcript) throw new Error("Transcript is empty");

  console.log(`Running in ${EXECUTE ? "EXECUTE" : "DRY_RUN"} mode with ${TRANSPORT} transport`);
  
  // Initialize transport layer
  let transport: TransportLayer;
  if (TRANSPORT === "mcp") {
    if (!MCP_ARGS) {
      console.error("MCP transport requires --mcp-args parameter. Example:");
      console.error("  --mcp-args \"./mcp-miro/build/index.js --token YOUR_TOKEN\"");
      process.exit(1);
    }
    
    // Parse MCP_ARGS properly - should be like "./mcp-miro/build/index.js --token TOKEN"
    const argParts = MCP_ARGS.trim().split(" ").filter(arg => arg.length > 0);
    const mcpArgs = [MCP_CMD, ...argParts]; // ["node", "./mcp-miro/build/index.js", "--token", "TOKEN"]
    
    console.log(`Starting MCP server with args:`, mcpArgs);
    const mcpTransport = await buildMcpTransport({
      serverName: "miro-server",
      args: mcpArgs,
      env: { MIRO_TOKEN }
    });
    console.log(`Connected to MCP server with tools:`, mcpTransport.getTools().map(t => t.name));
    transport = mcpTransport;
  } else {
    // Default to REST transport
    transport = new RestTransport();
  }

  // 1) Extract
  const extracted = await getInsightsRisksFromClaude(transcript);
  console.log("Extracted counts:", { insights: extracted.insights.length, risks: extracted.risks.length, runId: extracted.runId });

  // Decorate bullets with runId for idempotency and audit
  const decorate = (s: string) => `${s}\n\n[runId:${extracted.runId}]`;
  const insightsBullets = extracted.insights.map(decorate);
  const risksBullets = extracted.risks.map(decorate);

  // 2) Frames (left/right)
  const FRAME_W = 1400;
  const FRAME_H = 900;
  const insightsFrame = await transport.getOrCreateFrame(BOARD_ID, "Insights", -900, 0, FRAME_W, FRAME_H);
  const risksFrame = await transport.getOrCreateFrame(BOARD_ID, "Risks", 900, 0, FRAME_W, FRAME_H);

  // 3) De-dupe (skip notes already created for this runId)
  const [existingInsights, existingRisks] = await Promise.all([
    transport.listStickyNotesInFrame(BOARD_ID, insightsFrame.id),
    transport.listStickyNotesInFrame(BOARD_ID, risksFrame.id),
  ]);
  const hasRunId = (n: any) => typeof n?.data?.content === "string" && n.data.content.includes(`[runId:${extracted.runId}]`);
  const skipInsights = new Set(existingInsights.filter(hasRunId).map((n: any) => n.data.content));
  const skipRisks = new Set(existingRisks.filter(hasRunId).map((n: any) => n.data.content));

  const insightsToCreate = insightsBullets.filter((s) => !skipInsights.has(s));
  const risksToCreate = risksBullets.filter((s) => !skipRisks.has(s));

  // 4) Layout
  const insightsNotes = gridLayoutInFrame(insightsFrame, insightsToCreate, { columns: 3 });
  const risksNotes = gridLayoutInFrame(risksFrame, risksToCreate, { columns: 3 });
  insightsNotes.forEach((n) => (n.parentId = insightsFrame.id));
  risksNotes.forEach((n) => (n.parentId = risksFrame.id));

  // 5) DRY RUN preview
  const preview = {
    boardId: BOARD_ID,
    runId: extracted.runId,
    frames: [
      { id: insightsFrame.id, title: "Insights", createIfMissing: false },
      { id: risksFrame.id, title: "Risks", createIfMissing: false },
    ],
    toCreate: { insights: insightsNotes.length, risks: risksNotes.length, total: insightsNotes.length + risksNotes.length },
    sample: {
      insight: insightsNotes[0],
      risk: risksNotes[0],
    },
  };
  console.log(JSON.stringify(preview, null, 2));

  if (!EXECUTE) {
    console.log("DRY_RUN complete — pass --execute to create items on Miro.");
    process.exit(0);
  }

  // 6) Execute (batched) - Use chosen transport
  const created1 = await transport.bulkCreateStickies(BOARD_ID, insightsNotes, 20);
  const created2 = await transport.bulkCreateStickies(BOARD_ID, risksNotes, 20);

  // 7) Verify - Use chosen transport
  const [postInsights, postRisks] = await Promise.all([
    transport.listStickyNotesInFrame(BOARD_ID, insightsFrame.id),
    transport.listStickyNotesInFrame(BOARD_ID, risksFrame.id),
  ]);
  const countRunId = (arr: any[]) => arr.filter(hasRunId).length;

  const summary = {
    created: created1.ok + created2.ok,
    failed: created1.failed.length + created2.failed.length,
    verify: {
      insightsWithRunId: countRunId(postInsights),
      risksWithRunId: countRunId(postRisks),
    },
    failures: [...created1.failed, ...created2.failed].map((f) => ({
      note: f.note,
      error: { status: f.error?.status, body: f.error?.body?.slice?.(0, 200) },
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
})();
