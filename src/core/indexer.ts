/**
 * INDEXER — membuat "daftar isi" repo. Tanpa AI, cepat, gratis.
 *
 * Untuk setiap file kode kita catat:
 *   - path file
 *   - komentar pembuka file (kalau ada)
 *   - daftar import (petunjuk bagus: file yang import "jose" kemungkinan urusan token)
 *   - simbol: fungsi, class, method, beserta signature, komentar, dan nomor barisnya
 *
 * Hasilnya disimpan sebagai JSON di dalam repo target (.jev-index.json), lalu dibaca oleh search.ts.
 * File ini: mendaftar file + membuat/memperbarui indeks. Cara mengurai tiap bahasa ada di plugin bahasa
 * (src/languages/), jadi file ini tidak tahu sintaks bahasa apa pun.
 * Lihat docs/02-indexer.md dan docs/15-plugins.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { languages } from "../languages/index.ts";
import type { FileInfo, Index, LanguagePlugin } from "./types.ts";

export const INDEX_FILE = ".jev-index.json";

// Naikkan setiap kali isi indeks berubah (misalnya aturan "uses" di sebuah plugin bahasa), supaya indeks lama
// diurai ulang semua walaupun file-nya tidak berubah. 2 = kata kerja umum dicatat bersama objeknya (comments.delete).
export const INDEX_VERSION = 2;

/** Plugin bahasa untuk sebuah file, atau undefined kalau bahasanya belum didukung. */
function languageOf(path: string): LanguagePlugin | undefined {
  const ext = extname(path);
  return languages.find((lang) => lang.extensions.includes(ext) && !lang.skip?.(path));
}

/** Semua ekstensi yang didukung, untuk pesan error. Contoh: ".ts .tsx .js". */
export const SUPPORTED_EXTENSIONS = languages.flatMap((lang) => lang.extensions).join(" ");

// Dipakai hanya saat menjelajah manual (kalau lewat git, .gitignore sudah menangani).
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);


// ---------- 1. Daftar file ----------

/** Ambil semua file kode di repo. Utamakan `git ls-files` karena otomatis menghormati .gitignore. */
function listFiles(root: string): string[] {
  let paths: string[];
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], // sembunyikan pesan error git kalau folder ini bukan git repo
    });
    // `--cached` juga menyebut file yang sudah dihapus tapi belum di-commit: buang yang tidak ada lagi.
    paths = out.split("\n").filter((p) => p && existsSync(join(root, p)));
  } catch {
    paths = [];
  }
  // Bukan git repo, atau folder ini di-.gitignore oleh repo induknya (git tidak melihat apa pun):
  // jelajahi folder secara manual.
  if (paths.length === 0) paths = walk(root, "");
  return paths.filter((p) => languageOf(p) !== undefined).sort();
}

/** Cadangan kalau git tidak melihat file apa pun: jelajahi folder secara manual. */
function walk(root: string, rel: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) result.push(...walk(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

// ---------- 2. Buat / perbarui indeks ----------

export type IndexChanges = { added: number; updated: number; removed: number };

/**
 * Buat indeks baru, atau perbarui indeks lama dengan mengurai ulang HANYA file yang baru/berubah.
 *
 * - Berubah atau tidak dilihat dari waktu ubah + ukuran file (trik yang sama dengan `git status`).
 *   Mengecek 248 file hanya ±1 ms.
 * - Aman dipakai ulang karena data tiap file berdiri sendiri: nama, komentar, dan `uses` semuanya
 *   diambil dari file itu saja. Perubahan di satu file tidak memengaruhi data file lain.
 * - Pengurai tiap bahasa hanya dimuat kalau ada file bahasa itu yang perlu diurai (lihat LanguagePlugin.load).
 * - Indeks dengan versi berbeda (INDEX_VERSION) otomatis dibuat ulang semua.
 */
export async function updateIndex(root: string, old?: Index): Promise<{ index: Index; changes: IndexChanges }> {
  if (old && old.version !== INDEX_VERSION) old = undefined; // format lama → buat ulang semuanya
  const previous = new Map((old?.files ?? []).map((f) => [f.path, f]));
  const current = listFiles(root).map((path) => {
    const stat = statSync(join(root, path));
    return { path, mtimeMs: stat.mtimeMs, size: stat.size };
  });
  const changed = current.filter((f) => {
    const known = previous.get(f.path);
    return !known || known.mtimeMs !== f.mtimeMs || known.size !== f.size;
  });
  const stillThere = new Set(current.map((f) => f.path));
  const removed = [...previous.keys()].filter((path) => !stillThere.has(path)).length;
  const added = changed.filter((f) => !previous.has(f.path)).length;
  const changes = { added, updated: changed.length - added, removed };

  // Tidak ada yang berubah: pakai indeks lama apa adanya, tanpa memuat parser dan tanpa menulis file.
  if (old && changed.length === 0 && removed === 0) return { index: { ...old, root }, changes };

  const fresh = new Map<string, FileInfo>();
  const parsers = new Map<LanguagePlugin, Awaited<ReturnType<LanguagePlugin["load"]>>>();
  for (const f of changed) {
    const lang = languageOf(f.path)!; // listFiles hanya mengembalikan file yang punya plugin
    if (!parsers.has(lang)) parsers.set(lang, await lang.load());
    const parsed = parsers.get(lang)!.parseFile(f.path, readFileSync(join(root, f.path), "utf8"));
    fresh.set(f.path, { ...parsed, mtimeMs: f.mtimeMs, size: f.size });
  }
  const files = current.map((f) => fresh.get(f.path) ?? previous.get(f.path)!);
  const index: Index = { version: INDEX_VERSION, root, createdAt: new Date().toISOString(), files };
  writeFileSync(join(root, INDEX_FILE), JSON.stringify(index));
  return { index, changes };
}
