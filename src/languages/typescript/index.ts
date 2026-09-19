/**
 * Plugin bahasa TypeScript / JavaScript (termasuk JSX/TSX).
 * Pengurainya ada di parser.ts dan baru dimuat kalau ada file TS/JS yang perlu diurai.
 */

import type { LanguagePlugin } from "../../core/types.ts";

export const typescript: LanguagePlugin = {
  name: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  skip: (path) => path.endsWith(".d.ts"), // file deklarasi tipe: tidak ada perilaku
  load: () => import("./parser.ts"),
};
