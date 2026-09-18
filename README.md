# jev-traversal

Semantic code search dari terminal. Kamu cukup menjelaskan kode yang dicari, lalu [TypeSafe Jev](https://docs.typesafe.ai)
menelusuri repo (folder → file → fungsi) dan menunjukkan lokasinya.

```bash
bun install && cp .env.example .env   # isi TYPESAFE_API_KEY
bun src/cli.ts search path/ke/repo "code responsible for authentication"
# app/api/auth/login/route.ts:36-107  POST  (0.96)
```

Perintah:

```bash
bun src/cli.ts search [repo] "<query>"        # cari kode; indeks (.jev-index.json) dibuat/diperbarui otomatis
bun src/cli.ts index  [repo]                  # buat ulang indeks dari nol (biasanya tidak perlu)
  --json      # keluaran JSON untuk agent: status found/not_found, hits, related
  --verbose   # tampilkan setiap putaran Jev
```

Query ditulis dalam bahasa Inggris. Butuh [Bun](https://bun.sh) ≥ 1.3.
