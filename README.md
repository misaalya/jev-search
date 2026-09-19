# jev-search

Semantic code search dari terminal. Kamu cukup menjelaskan kode yang dicari, lalu [TypeSafe Jev](https://docs.typesafe.ai)
menelusuri repo (folder → file → fungsi) dan menunjukkan lokasinya.

```bash
bun install && cp .env.example .env   # isi TYPESAFE_API_KEY
bun src/cli.ts search path/ke/repo "code responsible for authentication"
# status: found
# ## lib/server/auth/session.ts:116-136  verifySessionToken  (implements 0.93, main 0.36)
# ```ts
# ...kode aslinya...
```

Keluarannya dibuat untuk agent (LLM): kode hasilnya langsung ikut dicetak, jadi agent tidak perlu membaca file
yang sama lagi.

Perintah:

```bash
bun src/cli.ts search [repo] "<query>"        # cari kode; indeks (.jev-index.json) dibuat/diperbarui otomatis
bun src/cli.ts index  [repo]                  # buat ulang indeks dari nol (biasanya tidak perlu)
  --md        # keluaran Markdown (default): status, lalu tiap hasil dengan kodenya
  --json      # keluaran JSON: status, message, hits, related (+ code)
  --verbose   # tampilkan setiap putaran Jev (ke stderr)
```

Urutannya selalu: perintah (`search`/`index`) dulu, lalu path repo, lalu query.

Supaya bisa dipanggil sebagai `jev-search` dari mana saja, jalankan sekali `bun link` di folder ini:

```bash
jev-search search path/ke/repo "code responsible for authentication"
```

Query ditulis dalam bahasa Inggris. Butuh [Bun](https://bun.sh) ≥ 1.3.

Bahasa yang didukung: TypeScript/JavaScript (termasuk JSX/TSX). Setiap bahasa adalah plugin di `src/languages/`;
bagian inti (`src/core/`) tidak bergantung pada bahasa apa pun.
