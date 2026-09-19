#!/usr/bin/env bun
/**
 * CLI — pintu masuk dari terminal.
 *
 *   jev-search index  [repo]                 buat ulang indeks dari nol
 *   jev-search search [repo] "<query>"       cari kode (indeks dibuat/diperbarui otomatis)
 *
 * Query WAJIB bahasa Inggris. Query dikirim apa adanya ke Jev, dan semua request ke Jev
 * sengaja 100% bahasa Inggris (bahasa yang paling akurat untuk Jev).
 *
 * Opsi:
 *   --json      keluaran JSON (untuk dipakai agent seperti opencode)
 *   --verbose   tampilkan setiap putaran Jev (untuk belajar / debugging)
 *
 * Lihat docs/01-overview.md untuk cara pakai.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { INDEX_FILE, updateIndex, type Index } from "./indexer.ts";
import { search } from "./search.ts";

// .env diambil dari folder proyek jev-search ini (bukan dari repo yang dicari).
// Bun hanya otomatis membaca .env di folder saat ini, jadi kita baca sendiri.
// Nilai yang sudah ada di environment tidak ditimpa.
const envFile = join(dirname(import.meta.dirname), ".env");
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) process.env[key] ??= value;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [command, ...rest] = args.filter((a) => !a.startsWith("--"));

function usage(): never {
  console.error(
    'Usage:\n  jev-search index [repo]\n  jev-search search [repo] "<query in English>" [--json] [--verbose]',
  );
  process.exit(1);
}

/**
 * Muat indeks, lalu perbarui bagian yang berubah sejak terakhir (file baru/berubah/terhapus).
 * Jadi user/agent tidak perlu menjalankan `index` lagi setelah mengubah kode.
 */
async function loadIndex(root: string): Promise<Index> {
  const path = join(root, INDEX_FILE);
  let old: Index | undefined;
  try {
    old = JSON.parse(readFileSync(path, "utf8")) as Index;
  } catch {
    old = undefined; // belum ada atau rusak → buat dari nol
  }
  const started = performance.now();
  const { index, changes } = await updateIndex(root, old);
  const { added, updated, removed } = changes;
  if ((added || updated || removed) && !flags.has("--json")) {
    const what = old ? `${updated} changed, ${added} new, ${removed} removed` : `built, ${index.files.length} files`;
    console.error(`Index ${what} (${Math.round(performance.now() - started)} ms)`);
  }
  return index;
}

if (command === "index") {
  const root = resolve(rest[0] ?? ".");
  const started = performance.now();
  const { index } = await updateIndex(root); // tanpa indeks lama = buat ulang semuanya
  const symbols = index.files.reduce((n, f) => n + f.symbols.length, 0);
  console.log(`Indexed ${index.files.length} files, ${symbols} symbols in ${Math.round(performance.now() - started)} ms`);
} else if (command === "search") {
  // Satu argumen = query (repo = folder saat ini). Dua argumen = repo + query.
  const [root, query] = rest.length >= 2 ? [resolve(rest[0]!), rest[1]!] : [resolve("."), rest[0]];
  if (!query) usage();

  const index = await loadIndex(root);
  if (index.files.length === 0) {
    console.error(`No code files found in ${root}. Supported: .ts .tsx .js .jsx .mjs .cjs`);
    process.exit(1);
  }
  const result = await search(query, index);

  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (flags.has("--verbose")) {
      for (const s of result.steps) {
        console.log(`#${s.round} ${s.type.padEnd(6)} ${String(s.options).padStart(3)} options  ${String(s.tokens).padStart(5)} tok  ${String(s.ms).padStart(4)} ms  ${s.note}`);
        if (s.decision) console.log(`     → ${s.decision}`);
      }
      console.log();
    }
    if (result.status === "not_found") {
      console.log("No confident match (nothing scored >= 0.70 for implementing this).");
      if (result.related.length > 0) console.log("Closest related code (not a match):");
      for (const r of result.related) {
        const where = r.name ? `${r.path}:${r.startLine}-${r.endLine}  ${r.name}` : r.path;
        console.log(`  ${where}  (related ${r.related.toFixed(2)}, implements ${r.implements.toFixed(2)}, main ${r.main.toFixed(2)})`);
      }
    }
    for (const hit of result.hits) {
      console.log(`${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.name}  (${hit.score.toFixed(2)}, main ${hit.main.toFixed(2)})`);
    }
    const requests = result.steps.length;
    console.log(`\n${requests} Jev requests, ${result.totalMs} ms`);
  }
} else {
  usage();
}
