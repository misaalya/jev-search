/**
 * Daftar plugin bahasa yang aktif. Menambah bahasa baru = buat folder languages/<bahasa>/ lalu daftarkan di sini.
 * Lihat docs/15-plugins.md.
 */

import type { LanguagePlugin } from "../core/types.ts";
import { typescript } from "./typescript/index.ts";

export const languages: LanguagePlugin[] = [typescript];
