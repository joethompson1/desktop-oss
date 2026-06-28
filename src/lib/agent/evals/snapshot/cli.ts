// CLI: read a conversation out of the Tauri-managed SQLite file and write
// a TypeScript fixture under `fixtures/snapshots/`.
//
// Usage:
//   npm run capture-eval-snapshot
//   npm run capture-eval-snapshot -- --before 2026-05-18T16:53:00Z
//   npm run capture-eval-snapshot -- --conversation-id orchestrator-main \
//     --out my-repro
//
// Defaults:
//   --db                 Tauri default for io.github.desktop-oss
//   --conversation-id    orchestrator-main (the singleton)
//   --limit              200
//   --before             (none — captures every message)
//   --out                <slug>-<timestamp>
//
// Output file path: src/lib/agent/evals/fixtures/snapshots/<out>.ts
// The fixture is gitignored.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { captureSnapshot, defaultDbPath } from "./capture.js";
import { renderSnapshotFile } from "./serialise.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/lib/agent/evals/snapshot → repo root
const REPO_ROOT = join(__dirname, "../../../../..");
const SNAPSHOTS_DIR = join(
  REPO_ROOT,
  "src/lib/agent/evals/fixtures/snapshots",
);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string" },
      "conversation-id": { type: "string" },
      before: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }
  if (positionals.length > 0) {
    console.error(`Unexpected positional argument: ${positionals[0]}`);
    printUsage();
    process.exit(2);
  }

  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  if (limit !== undefined && Number.isNaN(limit)) {
    console.error(`--limit must be a number; got ${values.limit}`);
    process.exit(2);
  }

  const dbPath = values.db ?? defaultDbPath();
  console.log(`[snapshot] reading from ${dbPath}`);

  const snapshot = await captureSnapshot({
    dbPath,
    conversationId: values["conversation-id"],
    before: values.before,
    limit,
  });

  const slug = sanitiseSlug(
    values.out ??
      `${slugifyTitle(snapshot.conversationTitle ?? snapshot.conversationId)}-${timestampSlug(snapshot.capturedAt)}`,
  );
  const outFile = join(SNAPSHOTS_DIR, `${slug}.ts`);
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const body = renderSnapshotFile(snapshot, { sourceFileName: `${slug}.ts` });
  writeFileSync(outFile, body, "utf-8");

  console.log(`[snapshot] wrote ${outFile}`);
  console.log(
    `[snapshot]   ${snapshot.messages.length} messages, ${snapshot.runs.length} runs, ${countChunks(snapshot.runChunks)} chunks`,
  );
  console.log(`[snapshot]`);
  console.log(`[snapshot] Replay it with:`);
  console.log(`[snapshot]   SNAPSHOT=${slug} \\`);
  console.log(`[snapshot]     EXPECTED_TOOLS=delegate_task \\`);
  console.log(
    `[snapshot]     npm run evals:one src/lib/agent/evals/scenarios/snapshot-replay.eval.ts`,
  );
}

function countChunks(runChunks: Record<string, unknown[]>): number {
  return Object.values(runChunks).reduce((acc, list) => acc + list.length, 0);
}

function timestampSlug(iso: string): string {
  // 2026-05-18T16:53:22Z → 20260518-1653
  return iso.replace(/[-:]/g, "").replace(/\.\d+/, "").replace(/T/, "-").slice(0, 13);
}

function slugifyTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "snapshot";
}

function sanitiseSlug(slug: string): string {
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!/^[a-z0-9-]+$/.test(cleaned)) {
    throw new Error(
      `Invalid output slug "${slug}" — must reduce to /^[a-z0-9-]+$/.`,
    );
  }
  return cleaned;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run capture-eval-snapshot -- [options]",
      "",
      "Options:",
      "  --db <path>              SQLite file (default: Tauri's app-data location)",
      "  --conversation-id <id>   default: orchestrator-main",
      "  --before <iso>           keep messages strictly before this timestamp",
      "  --limit <n>              max recent messages (default 200)",
      "  --out <slug>             override output file slug",
      "  -h, --help               show this help",
      "",
      "Example:",
      "  npm run capture-eval-snapshot -- --before 2026-05-18T16:53:22Z --out lru-repro",
    ].join("\n"),
  );
}

await main();
