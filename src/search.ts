/**
 * SEARCH — loop penelusuran: folder → file → fungsi, dipandu Jev.
 *
 * Ringkasan alur (penjelasan lengkap + diagram: docs/03-search-loop.md):
 *
 *   daftar kandidat (campuran folder / file / fungsi)
 *     → Jev: Choice "where" (mana paling cocok?) + Noul "exists" (ada yang relevan?)
 *     → CEK 1: tidak ada yang relevan?     → ambil dari antrean cadangan
 *     → CEK 2: Jev ragu?                   → beam lebih lebar
 *     → CEK 3: beam sudah fungsi semua?    → verifikasi (baca kode asli)
 *              belum?                      → buka folder/file di beam, ulangi
 *     → verifikasi gagal?                  → ambil dari antrean cadangan, ulangi
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInfo, Index, SymbolInfo } from "./indexer.ts";
import { askJev, type ChoiceAnswer, type NoulAnswer } from "./jev.ts";

// ---------- Angka-angka yang bisa diatur ----------
// Semua ini tebakan awal. Nilai terbaik harus dicari dengan uji coba di repo sungguhan.

const MAX_OPTIONS = 100; // maks. opsi per Choice (batas keras Jev 255; lebih sedikit = lebih akurat)
const MAX_STATE_CHARS = 24_000; // ±6.000 token; batas Jev 32k token, tapi state kecil lebih akurat
const BEAM = 2; // berapa kandidat teratas yang dibawa ke putaran berikutnya
const WIDE_BEAM = 4; // ...kalau Jev sedang ragu
const LOW_CONFIDENCE = 0.5; // di bawah ini = Jev ragu
const EXISTS_MIN = 0.3; // Noul "exists" di bawah ini = tidak ada yang relevan
const VERIFY_MIN = 0.7; // Noul verifikasi minimal agar fungsi dianggap hasil
const VERIFY_COUNT = 6; // berapa simbol teratas yang diverifikasi (lebih banyak = hasil lebih lengkap)
const MAX_ROUNDS = 8; // pengaman: jumlah request Jev maksimal
const MAX_SNIPPET_LINES = 80; // potongan kode yang dikirim saat verifikasi
const RELATED_POOL = 6; // kalau tidak ketemu: berapa kandidat "terdekat" yang dinilai di request terakhir
const RELATED_COUNT = 3; // ...dan berapa yang dikembalikan

// ---------- Kandidat ----------

/** Satu hal yang bisa dipilih Jev: folder, file, atau simbol (fungsi/class/method). */
type Candidate =
  | { kind: "dir"; path: string } // path "" = root repo
  | { kind: "file"; file: FileInfo }
  | { kind: "symbol"; file: FileInfo; symbol: SymbolInfo };

export type Hit = {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  score: number; // Noul verifikasi: 0..1
};

/**
 * Kode terdekat, dikembalikan HANYA kalau tidak ada hasil yang yakin. Bukan jawaban, hanya petunjuk.
 * name/startLine/endLine kosong kalau kandidatnya file atau folder.
 */
export type Related = {
  path: string;
  name?: string;
  startLine?: number;
  endLine?: number;
  related: number; // Noul 0..1: seberapa berkaitan dengan query
  implements: number; // Noul 0..1: apakah kode ini sendiri yang mengerjakan query (rendah = bukan jawabannya)
};

/** Catatan tiap request, supaya kita bisa melihat apa yang terjadi (--verbose). */
export type Step = {
  round: number;
  type: "search" | "verify" | "related";
  options: number;
  ms: number;
  tokens: number;
  note: string;
  decision: string; // apa yang diputuskan kode setelah jawaban ini (untuk --verbose)
};

/** status: "found" = hits berisi jawaban; "not_found" = hits kosong, lihat related untuk kode terdekat. */
export type SearchResult = {
  status: "found" | "not_found";
  hits: Hit[];
  related: Related[];
  steps: Step[];
  totalMs: number;
};

// ---------- Pohon folder dari indeks ----------

/** Isi langsung setiap folder: subfolder + file di dalamnya (satu tingkat saja). */
type Tree = Map<string, { dirs: Set<string>; files: FileInfo[] }>;

function buildTree(index: Index): Tree {
  const tree: Tree = new Map();
  const node = (path: string) => {
    if (!tree.has(path)) tree.set(path, { dirs: new Set(), files: [] });
    return tree.get(path)!;
  };
  for (const file of index.files) {
    const parts = file.path.split("/");
    const dir = parts.slice(0, -1).join("/");
    node(dir).files.push(file);
    // Daftarkan setiap folder ke folder induknya: "lib/server/auth" → "lib/server" → "lib" → "".
    for (let i = parts.length - 1; i > 0; i--) {
      const child = parts.slice(0, i).join("/");
      node(parts.slice(0, i - 1).join("/")).dirs.add(child);
    }
  }
  return tree;
}

/** "Membuka" kandidat: folder → isinya, file → simbolnya, simbol → dirinya sendiri (dibawa). */
function open(candidate: Candidate, tree: Tree): Candidate[] {
  if (candidate.kind === "dir") {
    const entry = tree.get(candidate.path)!;
    return [
      ...[...entry.dirs].sort().map((path): Candidate => ({ kind: "dir", path })),
      ...entry.files.map((file): Candidate => ({ kind: "file", file })),
    ];
  }
  if (candidate.kind === "file") {
    return candidate.file.symbols.map((symbol): Candidate => ({ kind: "symbol", file: candidate.file, symbol }));
  }
  return [candidate];
}

// ---------- Keterangan untuk Jev (isi "state") ----------

const basename = (path: string) => path.split("/").at(-1)!;

/**
 * Keterangan ringkas satu kandidat. Ini yang Jev "baca" untuk menilai.
 * Folder: nama isinya. File: komentar, import, signature fungsinya. Simbol: signature + komentar.
 */
function describe(candidate: Candidate, tree: Tree): object {
  if (candidate.kind === "dir") {
    const entry = tree.get(candidate.path)!;
    const names = [...[...entry.dirs].sort().map((d) => basename(d) + "/"), ...entry.files.map((f) => basename(f.path))];
    return {
      type: "folder",
      path: candidate.path + "/",
      contains: names.length > 25 ? [...names.slice(0, 25), `…and ${names.length - 25} more`] : names,
    };
  }
  const file = candidate.file;
  if (candidate.kind === "file") {
    const signatures = file.symbols.map((s) => s.signature || s.name);
    return {
      type: "file",
      path: file.path,
      ...(file.doc && { comment: file.doc }),
      imports: file.imports.slice(0, 10),
      defines: signatures.length > 15 ? [...signatures.slice(0, 15), `…and ${signatures.length - 15} more`] : signatures,
    };
  }
  const symbol = candidate.symbol;
  return {
    type: symbol.kind,
    file: file.path,
    name: symbol.name,
    ...(symbol.signature && { signature: symbol.signature }),
    ...(symbol.doc && { comment: symbol.doc }),
    ...(symbol.uses && { uses: symbol.uses }), // jejak perilaku: tahan terhadap nama yang menipu
  };
}

/** Nama yang mudah dibaca, untuk --verbose: "lib/server/", "lib/x.ts", "lib/x.ts › login". */
function label(candidate: Candidate): string {
  if (candidate.kind === "dir") return (candidate.path || ".") + "/";
  if (candidate.kind === "file") return candidate.file.path;
  return `${candidate.file.path} › ${candidate.symbol.name}`;
}

/** Komposisi daftar, contoh: "5 folders, 40 files, 55 symbols". */
function mix(list: Candidate[]): string {
  const count = (kind: Candidate["kind"]) => list.filter((c) => c.kind === kind).length;
  return `${count("dir")} folders, ${count("file")} files, ${count("symbol")} symbols`;
}

/** Kunci unik untuk tiap kandidat, supaya tidak ada duplikat dan tidak diverifikasi dua kali. */
function keyOf(candidate: Candidate): string {
  if (candidate.kind === "dir") return "D:" + candidate.path;
  if (candidate.kind === "file") return "F:" + candidate.file.path;
  return `S:${candidate.file.path}:${candidate.symbol.startLine}:${candidate.symbol.name}`;
}

// ---------- Meratakan (flatten) ----------

/**
 * Buka folder/file sebanyak mungkin selama daftar masih muat (≤ MAX_OPTIONS dan ≤ MAX_STATE_CHARS).
 * Semakin rata, semakin sedikit putaran. Dikerjakan tingkat demi tingkat (seperti membuka satu lapis
 * kulit bawang sekaligus), dari atas ke bawah daftar.
 */
function flatten(list: Candidate[], tree: Tree): Candidate[] {
  const size = (items: Candidate[]) => JSON.stringify(items.map((c) => describe(c, tree))).length;
  let changed = true;
  while (changed) {
    changed = false;
    const next: Candidate[] = [];
    for (let i = 0; i < list.length; i++) {
      const candidate = list[i]!;
      const children = candidate.kind === "symbol" ? [] : open(candidate, tree);
      const attempt = [...next, ...children, ...list.slice(i + 1)];
      if (children.length > 0 && attempt.length <= MAX_OPTIONS && size(attempt) <= MAX_STATE_CHARS) {
        next.push(...children);
        changed = true;
      } else {
        next.push(candidate);
      }
    }
    list = next;
  }
  return list;
}

/** Siapkan daftar putaran berikutnya: buka semua yang bukan simbol, bawa simbol apa adanya, lalu ratakan. */
function nextList(beam: Candidate[], tree: Tree): Candidate[] {
  const seen = new Set<string>();
  const opened = beam.flatMap((c) => open(c, tree)).filter((c) => !seen.has(keyOf(c)) && seen.add(keyOf(c)));
  return flatten(opened, tree);
}

// ---------- Satu putaran penelusuran ----------

/** ID pendek per kandidat: D = folder, F = file, S = simbol. Contoh: D1, F2, S3. */
function idsFor(list: Candidate[]): string[] {
  return list.map((c, i) => (c.kind === "dir" ? "D" : c.kind === "file" ? "F" : "S") + (i + 1));
}

async function searchRound(query: string, list: Candidate[], tree: Tree) {
  const ids = idsFor(list);
  const state = { candidates: Object.fromEntries(ids.map((id, i) => [id, describe(list[i]!, tree)])) };
  const result = await askJev(state, {
    where: {
      type: "choice",
      instructions:
        `Which candidate in \`candidates\` most likely contains the code responsible for: "${query}"? ` +
        "A folder or file counts if that code is somewhere inside it.",
      criteria: { ...Object.fromEntries(ids.map((id) => [id, null])), NONE: "No candidate is related to the query" },
    },
    exists: {
      type: "noul",
      instructions: `Does any candidate in \`candidates\` contain code responsible for: "${query}"?`,
    },
    // Tanpa NONE, jadi selalu ada yang terdekat. Dipakai hanya kalau akhirnya tidak ketemu (lihat related()).
    closest: {
      type: "choice",
      instructions:
        `Which candidate in \`candidates\` is most closely related to: "${query}"? ` +
        "Pick the closest one even if none of them implements it.",
      criteria: Object.fromEntries(ids.map((id) => [id, null])),
    },
  });
  const where = result.answers.where as ChoiceAnswer;
  const exists = (result.answers.exists as NoulAnswer).noul;
  const closestAnswer = result.answers.closest as ChoiceAnswer;
  const closest = ids
    .map((id, i) => ({ candidate: list[i]!, p: closestAnswer.probabilities[id] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, RELATED_POOL) // sebanyak yang bisa dinilai di request "kode terdekat"
    .map((c) => c.candidate);
  // Urutkan kandidat dari peluang tertinggi. NONE tidak ikut, ia hanya sinyal "tidak ada".
  const ranked = ids
    .map((id, i) => ({ candidate: list[i]!, id, p: where.probabilities[id] ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return { result, where, exists, ranked, closest };
}

// ---------- Verifikasi ----------

/** Baca potongan kode asli sebuah simbol dari disk. */
function snippet(root: string, candidate: Extract<Candidate, { kind: "symbol" }>): string {
  const lines = readFileSync(join(root, candidate.file.path), "utf8").split("\n");
  const { startLine, endLine } = candidate.symbol;
  const end = Math.min(endLine, startLine + MAX_SNIPPET_LINES - 1);
  const code = lines.slice(startLine - 1, end).join("\n");
  return end < endLine ? code + `\n// … (${endLine - end} more lines)` : code;
}

/** Satu request: satu Noul per kandidat, semua dijawab paralel oleh Jev. */
async function verify(query: string, symbols: Extract<Candidate, { kind: "symbol" }>[], root: string) {
  const ids = symbols.map((_, i) => "C" + (i + 1));
  const state = {
    candidates: Object.fromEntries(
      ids.map((id, i) => {
        const { file, symbol } = symbols[i]!;
        return [id, { file: file.path, name: symbol.name, lines: `${symbol.startLine}-${symbol.endLine}`, code: snippet(root, symbols[i]!) }];
      }),
    ),
  };
  const questions = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        type: "noul" as const,
        instructions: `Is the code in \`candidates.${id}\` responsible for: "${query}"?`,
        criteria: {
          true: "This code itself implements that behavior",
          false: "This code is unrelated, or only calls, mentions, or tests it",
        },
      },
    ]),
  );
  const result = await askJev(state, questions);
  const scores = ids.map((id) => (result.answers[id] as NoulAnswer).noul);
  return { result, scores };
}

// ---------- Kode terdekat (kalau tidak ketemu) ----------

/**
 * Satu request: untuk tiap kandidat terdekat, dua Noul dijawab paralel:
 *   related    = seberapa berkaitan dengan query
 *   implements = apakah kode ini sendiri yang mengerjakannya (sama dengan verifikasi)
 * Simbol dikirim bersama kode aslinya; file/folder dikirim keterangannya saja.
 */
async function related(query: string, candidates: Candidate[], tree: Tree, root: string) {
  const ids = candidates.map((_, i) => "C" + (i + 1));
  const state = {
    candidates: Object.fromEntries(
      ids.map((id, i) => {
        const c = candidates[i]!;
        if (c.kind !== "symbol") return [id, describe(c, tree)];
        return [id, { file: c.file.path, name: c.symbol.name, lines: `${c.symbol.startLine}-${c.symbol.endLine}`, code: snippet(root, c) }];
      }),
    ),
  };
  const questions = Object.fromEntries(
    ids.flatMap((id) => [
      [
        `${id}_related`,
        {
          type: "noul" as const,
          instructions: `Is the code in \`candidates.${id}\` related to: "${query}"?`,
          criteria: {
            true: "It handles the same kind of data or a part of that task, or is where that task would naturally be added",
            false: "It is about something else",
          },
        },
      ],
      [
        `${id}_implements`,
        {
          type: "noul" as const,
          instructions: `Is the code in \`candidates.${id}\` responsible for: "${query}"?`,
          criteria: {
            true: "This code itself implements that behavior",
            false: "This code is unrelated, or only calls, mentions, or tests it",
          },
        },
      ],
    ]),
  );
  const result = await askJev(state, questions);
  const items: Related[] = candidates.map((c, i) => {
    const scores = {
      related: (result.answers[`${ids[i]}_related`] as NoulAnswer).noul,
      implements: (result.answers[`${ids[i]}_implements`] as NoulAnswer).noul,
    };
    if (c.kind === "symbol") {
      return { path: c.file.path, name: c.symbol.name, startLine: c.symbol.startLine, endLine: c.symbol.endLine, ...scores };
    }
    return { path: c.kind === "file" ? c.file.path : c.path || ".", ...scores };
  });
  return { result, items: items.sort((a, b) => b.related - a.related) };
}

// ---------- Loop utama ----------

export async function search(query: string, index: Index): Promise<SearchResult> {
  const started = performance.now();
  const tree = buildTree(index);
  const steps: Step[] = [];
  const backup: { candidate: Candidate; p: number }[] = []; // antrean cadangan
  const verified = new Set<string>(); // simbol yang sudah pernah diverifikasi
  // Bahan "kode terdekat" kalau akhirnya tidak ketemu:
  const nearMisses: { candidate: Candidate; score: number }[] = []; // simbol yang gagal verifikasi
  const closestSeen: Candidate[] = []; // pilihan "closest" tiap putaran, urut ditemukan
  let lastSearchList: Candidate[] = []; // daftar kandidat putaran penelusuran terakhir
  let askedAgain = false; // "tanya ulang tanpa yang ditolak" hanya sekali per pencarian
  const finish = (hits: Hit[], relatedItems: Related[] = []): SearchResult => ({
    status: hits.length > 0 ? "found" : "not_found",
    hits,
    related: relatedItems,
    steps,
    totalMs: Math.round(performance.now() - started),
  });

  /** Ambil cadangan terbaik untuk dicoba. Kosong = tidak ada jalan lain lagi. */
  const fromBackup = (): Candidate[] => {
    backup.sort((a, b) => b.p - a.p);
    return backup.splice(0, BEAM).map((b) => b.candidate);
  };

  // Mulai dari root repo, langsung diratakan sejauh muat.
  let list = flatten([{ kind: "dir", path: "" }], tree);

  for (let round = 1; round <= MAX_ROUNDS && list.length > 0; round++) {
    // ---- Tahap VERIFIKASI: semua kandidat sudah berupa simbol & sedikit → langsung baca kode aslinya.
    // (Terjadi setelah CEK 3 di putaran sebelumnya.)
    if (list.every((c) => c.kind === "symbol") && list.length <= VERIFY_COUNT) {
      const symbols = list.filter((c) => !verified.has(keyOf(c))) as Extract<Candidate, { kind: "symbol" }>[];
      symbols.forEach((c) => verified.add(keyOf(c)));
      if (symbols.length > 0) {
        const { result, scores } = await verify(query, symbols, index.root);
        steps.push({
          round,
          type: "verify",
          options: symbols.length,
          ms: result.ms,
          tokens: result.inputTokens,
          note: symbols.map((c, i) => `${label(c)}=${scores[i]!.toFixed(2)}`).join("  "),
          decision: "",
        });
        const hits = symbols
          .map((c, i) => ({ c, score: scores[i]! }))
          .filter((h) => h.score >= VERIFY_MIN)
          .map(({ c, score }) => ({ path: c.file.path, name: c.symbol.name, startLine: c.symbol.startLine, endLine: c.symbol.endLine, score }))
          .sort((a, b) => b.score - a.score);
        if (hits.length > 0) {
          steps.at(-1)!.decision = `${hits.length} passed (>= ${VERIFY_MIN}) → DONE`;
          return finish(hits);
        }
        symbols.forEach((c, i) => nearMisses.push({ candidate: c, score: scores[i]! }));
        steps.at(-1)!.decision = `none passed (>= ${VERIFY_MIN}) → backtrack to backup queue`;
      }
      // Verifikasi gagal → mundur, coba cadangan (backtracking).
      list = nextList(fromBackup(), tree);
      // Cadangan habis: bisa jadi Jev tertipu nama di putaran sebelumnya dan terlalu yakin, sehingga kandidat
      // lain peluangnya ±0 dan tidak masuk cadangan. Tanya sekali lagi dengan daftar yang sama, tanpa yang sudah
      // ditolak verifikasi. (Contoh: "delete a comment" → deleteComment ditolak → createComment.)
      if (list.length === 0 && !askedAgain) {
        askedAgain = true;
        list = lastSearchList.filter((c) => !verified.has(keyOf(c)));
        if (steps.at(-1)?.type === "verify") steps.at(-1)!.decision += " | backup empty → ask again without the rejected candidates";
      }
      continue;
    }

    // ---- Tahap PENELUSURAN: tanya Jev mana yang paling cocok.
    lastSearchList = list;
    const { result, where, exists, ranked, closest } = await searchRound(query, list, tree);
    closestSeen.push(...closest);
    const top = ranked.slice(0, 3).map((r) => `${label(r.candidate)}=${r.p.toFixed(2)}`).join("  ");
    const step: Step = {
      round,
      type: "search",
      options: list.length,
      ms: result.ms,
      tokens: result.inputTokens,
      note: `[${mix(list)}] exists=${exists.toFixed(2)} conf=${where.confidence.toFixed(2)} top: ${top}`,
      decision: "",
    };
    steps.push(step);

    // CEK 1: tidak ada yang relevan → coba cadangan (atau berhenti kalau cadangan habis).
    // Tapi selama daftar masih berisi folder, Jev baru melihat nama folder, jadi "exists" belum bisa
    // dipercaya. Dalam kasus itu kita tetap turun satu tingkat dan bertanya lagi.
    const hasFolders = list.some((c) => c.kind === "dir");
    if ((exists < EXISTS_MIN || where.choice === "NONE") && !hasFolders) {
      step.decision = `CHECK 1: nothing relevant (exists < ${EXISTS_MIN} or NONE) → backtrack to backup queue`;
      list = nextList(fromBackup(), tree);
      continue;
    }

    // CEK 2: Jev ragu → bawa lebih banyak kandidat.
    const width = where.confidence < LOW_CONFIDENCE ? WIDE_BEAM : BEAM;
    const beam = ranked.slice(0, width).map((r) => r.candidate);
    // Sisanya masuk antrean cadangan (yang peluangnya hampir nol tidak perlu disimpan).
    for (const r of ranked.slice(width)) if (r.p >= 0.02) backup.push({ candidate: r.candidate, p: r.p });

    // CEK 3: semua sudah simbol → putaran berikutnya adalah verifikasi. Yang diverifikasi bukan hanya
    //        isi beam, tapi sampai VERIFY_COUNT simbol teratas, supaya hasilnya lebih lengkap.
    //        Belum → buka folder/file di beam, bawa simbolnya, lalu ulangi.
    const allSymbols = beam.every((c) => c.kind === "symbol");
    const toVerify = ranked
      .filter((r) => r.candidate.kind === "symbol" && (r.p >= 0.02 || beam.includes(r.candidate)))
      .slice(0, VERIFY_COUNT)
      .map((r) => r.candidate);
    list = allSymbols ? toVerify : nextList(beam, tree);
    step.decision =
      (hasFolders && (exists < EXISTS_MIN || where.choice === "NONE") ? "CHECK 1: low exists but list still has folders → go one level deeper anyway | " : "") +
      `CHECK 2: conf ${where.confidence < LOW_CONFIDENCE ? "< " + LOW_CONFIDENCE + " (unsure) → wide" : ">= " + LOW_CONFIDENCE + " → normal"} beam of ${width}: ` +
      beam.map(label).join(", ") +
      ` | CHECK 3: ${allSymbols ? `all symbols → verify top ${toVerify.length}` : "open beam + flatten → next round"}`;
  }

  // Tidak ketemu / kehabisan putaran: jangan kembalikan kosong, beri kode terdekat beserta nilainya,
  // supaya agent tahu seberapa dekat (dan bahwa itu BUKAN jawabannya).
  // Urutan prioritas: simbol yang hampir lolos verifikasi (nilai tertinggi dulu), lalu pilihan "closest":
  // simbol dulu, lalu file, lalu folder (makin spesifik makin berguna). Duplikat dibuang.
  const rank = { symbol: 0, file: 1, dir: 2 };
  const ordered = [
    ...nearMisses.sort((a, b) => b.score - a.score).map((n) => n.candidate),
    ...closestSeen.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.kind] - rank[b.c.kind] || a.i - b.i).map((x) => x.c),
  ];
  const pool = ordered.filter((c, i) => ordered.findIndex((o) => keyOf(o) === keyOf(c)) === i).slice(0, RELATED_POOL);
  if (pool.length === 0) return finish([]);
  const { result, items } = await related(query, pool, tree, index.root);
  // Pertanyaan "implements" di sini sama dengan verifikasi (kode asli dibaca). Jadi simbol yang lolos batas
  // tetap dijadikan hasil. Terjadi kalau pencarian berhenti tanpa verifikasi (misalnya CEK 1 karena nama
  // yang jelek membuat "exists" rendah).
  const passed: Hit[] = items
    .filter((r) => r.name !== undefined && r.implements >= VERIFY_MIN)
    .map((r) => ({ path: r.path, name: r.name!, startLine: r.startLine!, endLine: r.endLine!, score: r.implements }))
    .sort((a, b) => b.score - a.score);
  const top = items.slice(0, RELATED_COUNT);
  steps.push({
    round: steps.length + 1,
    type: "related",
    options: pool.length,
    ms: result.ms,
    tokens: result.inputTokens,
    note: items.map((r) => `${r.path}${r.name ? " › " + r.name : ""}=${r.related.toFixed(2)}/${r.implements.toFixed(2)}`).join("  "),
    decision: passed.length
      ? `${passed.length} passed implements (>= ${VERIFY_MIN}) → DONE`
      : `no confident match → return the ${top.length} closest as "related" (related/implements scores)`,
  });
  return passed.length ? finish(passed) : finish([], top);
}
