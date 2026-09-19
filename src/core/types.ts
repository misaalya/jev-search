/**
 * TIPE DATA — bentuk indeks yang sama untuk SEMUA bahasa, plus kontrak plugin bahasa.
 *
 * Bagian inti (core/) hanya mengenal tipe-tipe ini. Ia tidak tahu sintaks bahasa apa pun.
 * Plugin bahasa (languages/) yang memutuskan, untuk bahasanya, apa yang masuk simbol, import, komentar,
 * dan jejak "uses". Lihat docs/15-plugins.md.
 */

// ---------- Bentuk data indeks ----------

export type SymbolInfo = {
  name: string; // contoh: "verifyToken" atau "AuthService.login"
  kind: "function" | "class" | "method" | "module"; // module = seluruh file (file tanpa fungsi)
  signature: string; // baris deklarasinya, dipendekkan
  doc: string; // komentar di atasnya, dipendekkan ("" kalau tidak ada)
  startLine: number; // 1-based, untuk ditampilkan: file.ts:12
  endLine: number;
  uses?: Uses; // jejak yang dipakai di dalamnya (lihat docs/08-uses.md)
};

export type Uses = {
  calls?: string[]; // fungsi/class yang dipanggil: createHmac, verifySessionToken, new Headers, <LoginForm>
  properties?: string[]; // properti yang dibaca: headers.authorization, env.APP_SECRET
  strings?: string[]; // teks pendek: "Bearer ", "Unauthorized"
  numbers?: string[]; // angka ≥ 100: 401, 4096, 0o444
  other?: string[]; // nama dari LUAR fungsi yang bukan panggilan/properti: SECRET, TTL_MS, regex
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
  version: number; // lihat INDEX_VERSION di core/indexer.ts
  root: string; // path absolut repo saat diindeks
  createdAt: string;
  files: FileInfo[];
};

// ---------- Kontrak plugin bahasa ----------

/** Hasil mengurai satu file. mtimeMs & size diisi oleh indexer, bukan plugin. */
export type ParsedFile = Omit<FileInfo, "mtimeMs" | "size">;

export type LanguagePlugin = {
  name: string; // contoh: "typescript"
  extensions: string[]; // file yang ditangani plugin ini, contoh: [".ts", ".tsx"]
  skip?: (path: string) => boolean; // file berekstensi cocok yang tetap dilewati, contoh: *.d.ts
  /**
   * Muat pengurai. Dipisah (dan dimuat belakangan) karena pengurai biasanya berat: paket `typescript`
   * butuh ±250–400 ms. Indexer hanya memanggil ini kalau memang ada file bahasa ini yang perlu diurai.
   */
  load: () => Promise<{ parseFile: (path: string, code: string) => ParsedFile }>;
};
