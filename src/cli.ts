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
 *   --md        keluaran Markdown (default): status, lalu tiap hasil dengan kodenya
 *   --json      keluaran JSON (untuk agent yang lebih suka JSON)
 *   --verbose   tampilkan setiap putaran Jev (untuk belajar / debugging), ke stderr; dengan --json: field "steps"
 *
 * Kedua format dibuat untuk agent: kode hasil langsung ikut dicetak (lihat output.ts).
 *
 * Lihat docs/01-overview.md untuk cara pakai.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { INDEX_FILE, SUPPORTED_EXTENSIONS, updateIndex } from "./core/indexer.ts";
import { search } from "./core/search.ts";
import type { Index } from "./core/types.ts";
import { formatJson, formatMarkdown } from "./output.ts";
import { startSpinner } from "./spinner.ts";

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
const json = flags.has("--json"); // tanpa --json = Markdown (--md boleh ditulis, tapi sudah default)

/**
 * Pesan informasi (bukan error) ke stderr, supaya stdout hanya berisi hasil. Tidak memakai console.error karena
 * Bun mewarnainya merah di terminal, jadi terlihat seperti error.
 */
const info = (message: string) => process.stderr.write(message + "\n");

function usage(): never {
  console.error(
    'Usage:\n  jev-search index [repo]\n  jev-search search [repo] "<query in English>" [--md | --json] [--verbose]',
  );
  process.exit(1);
}

/**
 * Muat indeks, lalu perbarui bagian yang berubah sejak terakhir (file baru/berubah/terhapus).
 * Jadi user/agent tidak perlu menjalankan `index` lagi setelah mengubah kode.
 * note: ringkasan perubahan indeks ("" kalau tidak ada), dicetak setelah animasi loading berhenti.
 */
async function loadIndex(root: string): Promise<{ index: Index; note: string }> {
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
  if (!(added || updated || removed)) return { index, note: "" };
  const what = old ? `${updated} changed, ${added} new, ${removed} removed` : `built, ${index.files.length} files`;
  return { index, note: `Index ${what} (${Math.round(performance.now() - started)} ms)` };
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
  if (!query || (json && flags.has("--md"))) usage();

  // Animasi loading: hanya untuk manusia di terminal (lihat spinner.ts). Agent tidak pernah melihatnya.
  const spinner = startSpinner(!json);
  spinner.update("checking the index");
  const { index, note } = await loadIndex(root);
  if (index.files.length === 0) {
    spinner.stop();
    console.error(`No code files found in ${root}. Supported: ${SUPPORTED_EXTENSIONS}`);
    process.exit(1);
  }
  // finally: kalau request Jev gagal, baris animasi tetap dihapus sebelum pesan error tercetak.
  const result = await search(query, index, spinner.update).finally(spinner.stop);
  if (note && !json) info(note);

  // Langkah-langkah Jev (--verbose) dan ringkasan waktu ke stderr, supaya stdout hanya berisi hasil
  // (yang dibaca agent).
  const verbose = flags.has("--verbose");
  if (verbose && !json) {
    for (const s of result.steps) {
      info(`#${s.round} ${s.type.padEnd(6)} ${String(s.options).padStart(3)} options  ${String(s.tokens).padStart(5)} tok  ${String(s.ms).padStart(4)} ms  ${s.note}`);
      if (s.decision) info(`     → ${s.decision}`);
    }
  }
  console.log(json ? formatJson(result, root, verbose) : formatMarkdown(result, root));
  if (!json) info(`(${result.steps.length} Jev requests, ${result.totalMs} ms)`);
} else {
  usage();
}
