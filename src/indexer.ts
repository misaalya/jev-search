/**
 * INDEXER — membuat "daftar isi" repo. Tanpa AI, cepat, gratis.
 *
 * Untuk setiap file kode kita catat:
 *   - path file
 *   - komentar pembuka file (kalau ada)
 *   - daftar import (petunjuk bagus: file yang import "jose" kemungkinan urusan token)
 *   - simbol: fungsi, class, method, beserta signature, komentar, dan nomor barisnya
 *
 * Hasilnya disimpan sebagai JSON di dalam repo target (.jev-index.json),
 * lalu dibaca oleh search.ts. Lihat docs/02-indexer.md.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

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
  doc: string; // komentar pembuka file
  imports: string[]; // modul yang di-import, contoh: ["jose", "./session"]
  symbols: SymbolInfo[];
};

export type Index = {
  root: string; // path absolut repo saat diindeks
  createdAt: string;
  files: FileInfo[];
};

export const INDEX_FILE = ".jev-index.json";

// Untuk prototype ini: hanya TypeScript/JavaScript (bahasa repo uji).
// Bahasa lain nanti bisa ditambah dengan parser lain (misalnya tree-sitter).
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Dipakai hanya kalau repo bukan git repo (kalau git, .gitignore sudah menangani).
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

// Batas panjang teks supaya ringkasan tetap kecil (Jev lebih akurat dengan state yang ringkas).
const MAX_SIGNATURE = 140;
const MAX_DOC = 160;

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
    paths = out.split("\n").filter(Boolean);
  } catch {
    paths = walk(root, "");
  }
  return paths.filter((p) => CODE_EXTENSIONS.has(extname(p)) && !p.endsWith(".d.ts")).sort();
}

/** Cadangan kalau bukan git repo: jelajahi folder secara manual. */
function walk(root: string, rel: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) result.push(...walk(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

// ---------- 2. Baca struktur satu file ----------

/** Potong teks ke satu baris pendek. */
function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Ambil komentar tepat di atas sebuah node, lalu pendekkan.
 * Komentar `//` beberapa baris dianggap TS sebagai beberapa komentar terpisah, jadi semuanya digabung.
 */
function leadingComment(node: ts.Node, source: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const raw = ranges.map((range) => source.text.slice(range.pos, range.end)).join("\n");
  const text = raw
    .replace(/\/\*\*?|\*\//g, "") // buang /** dan */
    .replace(/^\s*\*\s?/gm, "") // buang * di awal baris
    .replace(/^\s*\/\/\s?/gm, "") // buang //
    .replace(/@\w+.*$/gms, ""); // buang tag seperti @param dan setelahnya
  return shorten(text, MAX_DOC);
}

/** Signature = teks deklarasi sampai sebelum badan fungsi `{ ... }`. */
function signatureOf(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source);
  const body = (node as { body?: ts.Node }).body;
  const cut = body ? body.getStart(source) - node.getStart(source) : text.indexOf("{");
  return shorten(cut > 0 ? text.slice(0, cut) : text, MAX_SIGNATURE);
}

function lineOf(pos: number, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

/**
 * Apakah nilai sebuah variabel berupa fungsi? Dua pola yang dikenali:
 *   const login = async () => {...}
 *   const POST = withSession(async (request) => {...})   ← fungsi yang dibungkus
 */
function isFunctionValue(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  return ts.isCallExpression(node) && node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
}

// ---------- Jejak "uses": apa saja yang dipakai di dalam sebuah fungsi ----------
// Nama fungsi bisa menipu, tapi jejak ini sulit dipalsukan (lihat docs/08-uses.md).

/** Maks. jejak per kategori, supaya request ke Jev tetap kecil. */
const MAX_USES_PER_KIND = 6;
const MAX_USE_TEXT = 40;

// Panggilan & properti yang muncul di hampir semua kode, jadi tidak membedakan apa pun.
const NOISE_CALLS = new Set([
  "map", "filter", "forEach", "reduce", "find", "some", "every", "push", "pop", "shift", "slice", "splice",
  "concat", "join", "split", "trim", "includes", "indexOf", "startsWith", "endsWith", "replace", "toString",
  "toFixed", "toLowerCase", "toUpperCase", "then", "catch", "finally", "keys", "values", "entries", "has",
  "get", "set", "add", "delete", "log", "end", "Error", "String", "Number", "Boolean", "Array", "Object",
  "from", "at", "now", "parse", "stringify", "Date",
]);
const NOISE_PROPS = new Set(["length"]);
const NOISE_GLOBALS = new Set([
  "undefined", "console", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Promise", "NaN",
  "Infinity", "Date", "Error", "Buffer",
]);

export type Uses = {
  calls?: string[]; // fungsi/class yang dipanggil: createHmac, verifySessionToken, new Headers, <LoginForm>
  properties?: string[]; // properti yang dibaca: headers.authorization, env.APP_SECRET
  strings?: string[]; // teks pendek: "Bearer ", "Unauthorized"
  numbers?: string[]; // angka ≥ 100: 401, 4096, 0o444
  other?: string[]; // nama dari LUAR fungsi yang bukan panggilan/properti: SECRET, TTL_MS, regex
};

/**
 * Kumpulkan jejak dari isi sebuah node (fungsi, method, class, atau seluruh file).
 * Dua langkah: (1) catat nama-nama lokal (parameter & variabel di dalamnya) supaya bisa dibuang,
 * (2) telusuri semua bagian kode dan kelompokkan per kategori.
 */
function usesOf(node: ts.Node): Uses | undefined {
  const lists: Required<Uses> = { calls: [], properties: [], strings: [], numbers: [], other: [] };
  const put = (kind: keyof Uses, value: string) => {
    const list = lists[kind];
    if (value && list.length < MAX_USES_PER_KIND && !list.includes(value)) list.push(value);
  };

  // (1) Nama lokal: parameter, variabel, fungsi dalam, dll. Buatan programmer, jadi bukan jejak.
  const locals = new Set<string>();
  const collectLocals = (n: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n)) &&
      n.name && ts.isIdentifier(n.name)
    ) {
      locals.add(n.name.text);
    }
    ts.forEachChild(n, collectLocals);
  };
  collectLocals(node);

  /** Nama yang dipanggil: `foo()` → foo, `res.writeHead()` → writeHead. */
  const calleeName = (expr: ts.Expression): string =>
    ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : "";

  // (2) Telusuri semua bagian kode.
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return; // tipe TS bukan perilaku

    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const name = calleeName(n.expression);
      if (!NOISE_CALLS.has(name)) put("calls", name);
      // Objek di depan pemanggilan tetap ditelusuri: req.headers.get() → properti "req.headers".
      if (ts.isPropertyAccessExpression(n.expression)) visit(n.expression.expression);
      n.arguments?.forEach(visit);
      return;
    }
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[A-Z]/.test(n.tagName.getText())) {
      put("calls", n.tagName.getText()); // komponen React buatan sendiri
    }
    if (ts.isPropertyAccessExpression(n)) {
      // Ambil seluruh rantai sekaligus: req.headers.authorization → ["req", "headers", "authorization"].
      const parts: string[] = [];
      let base: ts.Expression = n;
      while (ts.isPropertyAccessExpression(base)) {
        parts.unshift(base.name.text);
        base = base.expression;
      }
      if (ts.isIdentifier(base)) parts.unshift(base.text);
      else if (base.kind === ts.SyntaxKind.ThisKeyword) parts.unshift("this");
      else visit(base); // misalnya getUser().name → telusuri getUser()
      if (!NOISE_PROPS.has(parts.at(-1)!)) put("properties", parts.slice(-2).join("."));
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const text = n.text.trim();
      if (text.length > 1 && text.length <= MAX_USE_TEXT) put("strings", text);
    } else if (ts.isTemplateExpression(n)) {
      for (const part of [n.head.text, ...n.templateSpans.map((s) => s.literal.text)]) {
        const text = part.trim();
        if (text.length > 1 && text.length <= MAX_USE_TEXT) put("strings", text);
      }
    } else if (ts.isNumericLiteral(n) && Math.abs(Number(n.text)) >= 100) {
      put("numbers", n.getText());
    } else if (ts.isRegularExpressionLiteral(n) && n.text.length <= MAX_USE_TEXT) {
      put("other", n.text);
    } else if (ts.isIdentifier(n)) {
      // Nama dari luar fungsi (konstanta modul, import) yang dipakai sebagai nilai.
      const parent = n.parent;
      const isName = (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === n;
      if (!isName && !locals.has(n.text) && !NOISE_GLOBALS.has(n.text)) put("other", n.text);
    }
    ts.forEachChild(n, visit);
  };
  // Untuk fungsi/method, telusuri badannya saja (nama & parameternya sudah ada di signature).
  const body = (node as { body?: ts.Node }).body;
  const initializer = ts.isVariableDeclaration(node) ? node.initializer : undefined;
  visit(body ?? initializer ?? node);

  // Kategori kosong tidak ditulis, supaya request tetap kecil.
  const result: Uses = {};
  for (const kind of Object.keys(lists) as (keyof Uses)[]) if (lists[kind].length) result[kind] = lists[kind];
  return Object.keys(result).length ? result : undefined;
}

export function parseFile(path: string, code: string): FileInfo {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const symbols: SymbolInfo[] = [];
  const imports: string[] = [];

  const add = (name: string, kind: SymbolInfo["kind"], node: ts.Node, docNode: ts.Node = node) => {
    symbols.push({
      name,
      kind,
      signature: signatureOf(node, source),
      doc: leadingComment(docNode, source),
      startLine: lineOf(node.getStart(source), source),
      endLine: lineOf(node.getEnd(), source),
      uses: usesOf(node),
    });
  };

  // Hanya level teratas file + method di dalam class. Fungsi di dalam fungsi diabaikan
  // supaya daftar tetap ringkas; fungsi luarnya sudah mewakili.
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, "function", statement);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      add(className, "class", statement);
      for (const member of statement.members) {
        if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
          const methodName = ts.isConstructorDeclaration(member) ? "constructor" : member.name.getText(source);
          add(`${className}.${methodName}`, "method", member);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionValue(declaration.initializer)) {
          // Komentar biasanya menempel di statement `const ...`, bukan di declaration-nya.
          add(declaration.name.text, "function", declaration, statement);
        }
      }
    } else if (ts.isExportAssignment(statement) && isFunctionValue(statement.expression)) {
      add("default", "function", statement); // export default () => {...}
    }
  }

  // File tanpa fungsi/class (misalnya config) tetap perlu bisa ditemukan dan diverifikasi,
  // jadi seluruh isinya diwakili satu simbol "(top-level code)".
  if (symbols.length === 0 && code.trim()) {
    symbols.push({
      name: "(top-level code)",
      kind: "module",
      signature: "",
      doc: "",
      startLine: 1,
      endLine: lineOf(code.length, source),
      uses: usesOf(source),
    });
  }

  const firstStatement = source.statements[0];
  return {
    path,
    doc: firstStatement ? leadingComment(firstStatement, source) : "",
    imports,
    symbols,
  };
}

// ---------- 3. Gabungkan semuanya ----------

export function buildIndex(root: string): Index {
  const files = listFiles(root).map((path) => parseFile(path, readFileSync(join(root, path), "utf8")));
  const index: Index = { root, createdAt: new Date().toISOString(), files };
  writeFileSync(join(root, INDEX_FILE), JSON.stringify(index));
  return index;
}
