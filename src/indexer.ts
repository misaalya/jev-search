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
 * File ini: mendaftar file + membuat/memperbarui indeks. Pengurainya ada di parser.ts.
 * Lihat docs/02-indexer.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

// ---------- Bentuk data indeks ----------

export type SymbolInfo = {
  name: string; // contoh: "verifyToken" atau "AuthService.login"
  kind: "function" | "class" | "method" | "module"; // module = seluruh file (file tanpa fungsi)
  signature: string; // baris deklarasinya, dipendekkan
  doc: string; // komentar di atasnya, dipendekkan ("" kalau tidak ada)
  startLine: number; // 1-based, untuk ditampilkan: file.ts:12
  endLine: number;
  uses?: Uses; // jejak yang dipakai di dalamnya (lihat usesOf)
};

export type FileInfo = {
  path: string; // relatif terhadap root repo, pakai "/"
  mtimeMs: number; // waktu terakhir diubah, untuk mendeteksi perubahan (lihat updateIndex)
  size: number; // ukuran dalam byte, juga untuk mendeteksi perubahan
  doc: string; // komentar pembuka file
  imports: string[]; // modul yang di-import, contoh: ["jose", "./session"]
  symbols: SymbolInfo[];
};

export type Index = {
  version: number; // lihat INDEX_VERSION
  root: string; // path absolut repo saat diindeks
  createdAt: string;
  files: FileInfo[];
};

export type Uses = {
  calls?: string[]; // fungsi/class yang dipanggil: createHmac, verifySessionToken, new Headers, <LoginForm>
  properties?: string[]; // properti yang dibaca: headers.authorization, env.APP_SECRET
  strings?: string[]; // teks pendek: "Bearer ", "Unauthorized"
  numbers?: string[]; // angka ≥ 100: 401, 4096, 0o444
  other?: string[]; // nama dari LUAR fungsi yang bukan panggilan/properti: SECRET, TTL_MS, regex
};

export const INDEX_FILE = ".jev-index.json";

// Naikkan setiap kali isi indeks berubah (misalnya aturan "uses"), supaya indeks lama diurai ulang semua
// walaupun file-nya tidak berubah. 2 = kata kerja umum dicatat bersama objeknya (comments.delete).
export const INDEX_VERSION = 2;

// Untuk prototype ini: hanya TypeScript/JavaScript (bahasa repo uji).
// Bahasa lain nanti bisa ditambah dengan parser lain (misalnya tree-sitter).
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

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
  return paths.filter((p) => CODE_EXTENSIONS.has(extname(p)) && !p.endsWith(".d.ts")).sort();
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
 * - Parser (paket `typescript`) hanya dimuat kalau ada yang perlu diurai.
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
  if (changed.length > 0) {
    const { parseFile } = await import("./parser.ts");
    for (const f of changed) {
      fresh.set(f.path, { ...parseFile(f.path, readFileSync(join(root, f.path), "utf8")), mtimeMs: f.mtimeMs, size: f.size });
    }
  }
  const files = current.map((f) => fresh.get(f.path) ?? previous.get(f.path)!);
  const index: Index = { version: INDEX_VERSION, root, createdAt: new Date().toISOString(), files };
  writeFileSync(join(root, INDEX_FILE), JSON.stringify(index));
  return { index, changes };
}
