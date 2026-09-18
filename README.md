# jev-traversal

Semantic code search dari terminal. Kamu cukup menjelaskan kode yang dicari, lalu [TypeSafe Jev](https://docs.typesafe.ai)
menelusuri repo (folder → file → fungsi) dan menunjukkan lokasinya.

```bash
npm install && cp .env.example .env   # isi TYPESAFE_API_KEY
node src/cli.ts search path/ke/repo "code responsible for authentication"
# app/api/auth/login/route.ts:36-107  POST  (0.96)
```

Perintah:

```bash
node src/cli.ts index  [repo]                  # buat/perbarui indeks repo (.jev-index.json)
node src/cli.ts search [repo] "<query>"        # cari kode; indeks dibuat otomatis kalau belum ada
  --json      # keluaran JSON, untuk dipakai agent seperti opencode
  --verbose   # tampilkan setiap putaran Jev
```

Query ditulis dalam bahasa Inggris. Butuh Node.js ≥ 22.18.
