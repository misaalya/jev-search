/**
 * SPINNER — animasi loading satu baris, HANYA untuk manusia di terminal.
 *
 * Ditulis ke stderr, dan hanya kalau stderr adalah terminal sungguhan (TTY). Agent menjalankan perintah tanpa
 * TTY dan menerima rekaman teks mentah; kalau animasi ditulis juga, semua bingkainya ("⠋ …\r⠙ …\r") ikut
 * terekam dan membuang token. Jadi untuk agent, animasi ini tidak pernah ditulis. Juga mati di CI.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K"; // kembali ke awal baris + hapus isinya

export function startSpinner(enabled: boolean) {
  let text = "";
  let frame = 0;
  const on = enabled && process.stderr.isTTY === true && !process.env.CI;
  const draw = () => process.stderr.write(`${CLEAR_LINE}${FRAMES[frame++ % FRAMES.length]} ${text}`);
  const timer = on ? setInterval(draw, 80) : undefined;
  return {
    /** Ganti keterangan yang sedang ditampilkan. */
    update(next: string) {
      text = next;
      if (on) draw();
    },
    /** Hentikan dan hapus barisnya, supaya hasil dicetak di layar yang bersih. */
    stop() {
      if (!on) return;
      clearInterval(timer);
      process.stderr.write(CLEAR_LINE);
    },
  };
}
