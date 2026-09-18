#!/usr/bin/env node
/**
 * CLI — pintu masuk dari terminal.
 *
 *   jev-search index  [repo]                 buat/perbarui indeks repo
 *   jev-search search [repo] "<query>"       cari kode (indeks dibuat otomatis kalau belum ada)
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
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { dirname, join, resolve } from "node:path";
import { buildIndex, INDEX_FILE, type Index } from "./indexer.ts";
import { search } from "./search.ts";

// .env diambil dari folder proyek jev-traversal ini (bukan dari repo yang dicari).
const envFile = join(dirname(import.meta.dirname), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Saat membuka koneksi, Node mencoba alamat IPv6/IPv4 bergantian dan hanya memberi 250 ms per alamat.
// Server TypeSafe jauh (membuka koneksi ±270 ms), jadi batas bawaan itu sering habis → ETIMEDOUT.
// Lihat docs/09-false-flag-benchmark.md, bagian "Masalah jaringan".
setDefaultAutoSelectFamilyAttemptTimeout(1000);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [command, ...rest] = args.filter((a) => !a.startsWith("--"));

function usage(): never {
  console.error(
    'Usage:\n  jev-search index [repo]\n  jev-search search [repo] "<query in English>" [--json] [--verbose]',
  );
  process.exit(1);
}

/** Muat indeks dari disk, atau buat baru kalau belum ada. */
function loadIndex(root: string): Index {
  const path = join(root, INDEX_FILE);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Index;
  if (!flags.has("--json")) console.error(`No index yet, building ${path} …`);
  return buildIndex(root);
}

if (command === "index") {
  const root = resolve(rest[0] ?? ".");
  const started = performance.now();
  const index = buildIndex(root);
  const symbols = index.files.reduce((n, f) => n + f.symbols.length, 0);
  console.log(`Indexed ${index.files.length} files, ${symbols} symbols in ${Math.round(performance.now() - started)} ms`);
} else if (command === "search") {
  // Satu argumen = query (repo = folder saat ini). Dua argumen = repo + query.
  const [root, query] = rest.length >= 2 ? [resolve(rest[0]!), rest[1]!] : [resolve("."), rest[0]];
  if (!query) usage();

  const index = loadIndex(root);
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
    if (result.hits.length === 0) console.log("No confident match found.");
    for (const hit of result.hits) {
      console.log(`${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.name}  (${hit.score.toFixed(2)})`);
    }
    const requests = result.steps.length;
    console.log(`\n${requests} Jev requests, ${result.totalMs} ms`);
  }
} else {
  usage();
}
