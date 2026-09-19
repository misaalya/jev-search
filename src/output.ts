/**
 * OUTPUT — keluaran untuk agent (LLM) dan manusia: Markdown (default, --md) atau JSON (--json).
 *
 * Kode hasil langsung ikut dicetak, supaya agent tidak perlu memanggil tool "read" lagi untuk file yang sama
 * (dua kali membaca = token terbuang). Yang ikut kodenya:
 *   - found:     semua hasil
 *   - partial:   bagian-bagiannya (part >= VERIFY_MIN)
 *   - not_found: tidak ada; kode terdekat hanya petunjuk, jadi cukup lokasinya
 * Lihat docs/01-overview.md.
 */

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { VERIFY_MIN, type SearchResult } from "./core/search.ts";

const MAX_CODE_LINES = 200; // fungsi yang lebih panjang dipotong; agent bisa membaca sisanya sendiri

/** Satu lokasi kode yang akan dicetak kodenya. */
type Shown = { path: string; name: string; startLine: number; endLine: number; scores: string };

/** Kode asli dari disk, persis apa adanya (tanpa nomor baris), supaya agent bisa langsung menyalinnya untuk edit. */
function readCode(root: string, s: Shown): string {
  const lines = readFileSync(join(root, s.path), "utf8").split("\n").slice(s.startLine - 1, s.endLine);
  if (lines.length <= MAX_CODE_LINES) return lines.join("\n");
  const shownEnd = s.startLine + MAX_CODE_LINES - 1;
  return [...lines.slice(0, MAX_CODE_LINES), `… lines ${shownEnd + 1}-${s.endLine} not shown (read the file if needed)`].join("\n");
}

/**
 * Hasil lain yang seluruhnya ada DI DALAM s (misalnya method yang juga jadi hasil, di dalam class s).
 * Kalau ada, kode s tidak dicetak: yang di dalam lebih spesifik, dan kodenya tidak perlu tercetak dua kali.
 */
function innerOf(s: Shown, all: Shown[]): Shown[] {
  return all.filter(
    (o) => o !== s && o.path === s.path && s.startLine <= o.startLine && s.endLine >= o.endLine &&
      (s.startLine < o.startLine || s.endLine > o.endLine),
  );
}

/** Hasil yang kodenya ikut dicetak, sesuai status. */
function shownOf(result: SearchResult): Shown[] {
  if (result.status === "found") {
    return result.hits.map((h) => ({ ...h, scores: `implements ${h.score.toFixed(2)}, main ${h.main.toFixed(2)}` }));
  }
  if (result.status === "partial") {
    return result.related
      .filter((r) => r.name !== undefined && r.part >= VERIFY_MIN)
      .map((r) => ({
        path: r.path,
        name: r.name!,
        startLine: r.startLine!,
        endLine: r.endLine!,
        scores: `part ${r.part.toFixed(2)}, implements ${r.implements.toFixed(2)}, main ${r.main.toFixed(2)}`,
      }));
  }
  return [];
}

/** Keluaran Markdown (default, --md): status, lalu tiap hasil dengan kodenya dalam blok ```. */
export function formatMarkdown(result: SearchResult, root: string): string {
  const out: string[] = [`status: ${result.status}`, result.message, ""];
  const shown = shownOf(result);
  for (const s of shown) {
    out.push(`## ${s.path}:${s.startLine}-${s.endLine}  ${s.name}  (${s.scores})`);
    const inner = innerOf(s, shown);
    if (inner.length) out.push(`(code not repeated: it contains ${inner.map((i) => i.name).join(", ")}, shown separately)`, "");
    else out.push("```" + extname(s.path).slice(1), readCode(root, s), "```", "");
  }
  // Kode terdekat yang tidak ikut dicetak kodenya: cukup lokasi + nilainya.
  const rest = result.related.filter((r) => !shown.some((s) => s.path === r.path && s.name === r.name));
  if (rest.length > 0) {
    out.push(result.status === "partial" ? "Also related (not a part):" : "Closest code (not a match):");
    for (const r of rest) {
      const where = r.name ? `${r.path}:${r.startLine}-${r.endLine}  ${r.name}` : r.path;
      out.push(`- ${where}  (related ${r.related.toFixed(2)}, implements ${r.implements.toFixed(2)})`);
    }
    out.push("");
  }
  if (shown.length > 0) {
    out.push(
      "Scores are 0-1. implements: this code itself does the task. main: the main place that runs it (high) or a " +
        "small helper (low)." + (result.status === "partial" ? " part: it does one piece of the task." : ""),
    );
  }
  return out.join("\n");
}

/** Keluaran JSON: sama dengan SearchResult, tapi hasil yang dicetak kodenya mendapat field `code`. */
export function formatJson(result: SearchResult, root: string, withSteps: boolean): string {
  const shown = shownOf(result);
  const codeFor = (path: string, name?: string) => {
    const s = shown.find((x) => x.path === path && x.name === name);
    if (!s) return {};
    const inner = innerOf(s, shown);
    return inner.length ? { contains: inner.map((i) => i.name) } : { code: readCode(root, s) };
  };
  const { steps, ...rest } = result;
  return JSON.stringify(
    {
      ...rest,
      hits: result.hits.map((h) => ({ ...h, ...codeFor(h.path, h.name) })),
      related: result.related.map((r) => ({ ...r, ...codeFor(r.path, r.name) })),
      ...(withSteps && { steps }), // langkah-langkah Jev hanya untuk debugging (--verbose)
    },
    null,
    2,
  );
}
