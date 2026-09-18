/**
 * JEV — pembungkus kecil untuk memanggil TypeSafe System One API.
 *
 * Satu request = satu "state" (bahan bacaan) + beberapa "questions" yang dijawab paralel.
 * Kita memakai fetch biasa (bawaan Node) supaya base URL persis mengikuti .env:
 *   POST {TYPESAFE_BASE_URL}/systemone
 * Lihat docs/04-jev-request.md.
 */

// ---------- Bentuk pertanyaan & jawaban (sesuai https://docs.typesafe.ai/api) ----------

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>; // opsi → deskripsi (null = cukup lihat state)
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string; // opsi dengan peluang tertinggi
  probabilities: Record<string, number>; // peluang tiap opsi, totalnya 1
  confidence: number; // 0..1, seberapa terpusat peluangnya
};

export type NoulAnswer = {
  type: "noul";
  noul: number; // 0..1, peluang jawabannya "ya"
};

export type JevResult = {
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
  inputTokens: number;
  ms: number; // lama request, untuk laporan kecepatan
};

// ---------- Konfigurasi dari .env ----------

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
}

// ---------- Panggilan API ----------

/**
 * Kirim satu request ke Jev.
 * Coba lagi maksimal 2 kali (dengan jeda yang makin lama) kalau:
 *   - koneksi gagal (misalnya ETIMEDOUT), atau
 *   - server sibuk (429 = terlalu banyak request, 529 = overload).
 * Mengulang aman karena kita hanya bertanya, tidak mengubah data apa pun. Error lain langsung dilempar.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, ChoiceQuestion | NoulQuestion>,
): Promise<JevResult> {
  const url = env("TYPESAFE_BASE_URL").replace(/\/+$/, "") + "/systemone";
  const body = JSON.stringify({ model: env("TYPESAFE_MODEL"), state, questions });
  const started = performance.now();

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < 2;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      // Koneksi gagal sebelum ada jawaban dari server.
      if (!canRetry) throw error;
      await wait(attempt);
      continue;
    }
    if ((response.status === 429 || response.status === 529) && canRetry) {
      await wait(attempt);
      continue;
    }
    if (!response.ok) {
      throw new Error(`TypeSafe returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const data = (await response.json()) as { answers: JevResult["answers"]; usage?: { input_tokens?: number } };
    return {
      answers: data.answers,
      inputTokens: data.usage?.input_tokens ?? 0,
      ms: Math.round(performance.now() - started),
    };
  }
}

/** Jeda sebelum mencoba lagi: 0,5 s, lalu 1 s. */
function wait(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
}
