/** Text normalisation for lexical retrieval, in the languages this product is
 * used in.
 *
 * The tokeniser the retrieval used was `[\p{L}\p{N}]+` after NFKC. That splits
 * Hindi at the virama and Arabic at the harakat, because combining marks are
 * neither letters nor numbers: 'सब्र का' became ['सब','र','क'] and 'الصَّبْرُ'
 * became ['الص','ب','ر'], so a vowelled Qur'anic phrase never matched its plain
 * form and a Hindi word never matched itself. Reproduced in node:sqlite, where
 * FTS5's default tokeniser has the same blind spot.
 *
 * One rule, shared by the in-memory retrieval and — in the next migration —
 * the query side of the full-text index, so the two can never disagree about
 * what a word is:
 *
 * - NFKC first, so presentation forms and width variants collapse.
 * - Arabic harakat (U+064B–U+0652), the dagger alif (U+0670) and tatweel
 *   (U+0640) are removed: they are pronunciation and typesetting, not words,
 *   and a query typed without them must find text written with them.
 * - Arabic and Urdu spellings of the same letter are folded so both scripts'
 *   keyboards meet: ك→ک, ي/ى→ی, أ/إ/آ→ا, ة→ه.
 * - A token is a run of letters, *marks* and digits, so the virama and every
 *   other structural mark stays inside the word it belongs to.
 */

const HARAKAT = /[ً-ْٰـ]/g;

const FOLD: Record<string, string> = {
  ك: 'ک', // ك → ک
  ي: 'ی', // ي → ی
  ى: 'ی', // ى → ی
  أ: 'ا', // أ → ا
  إ: 'ا', // إ → ا
  آ: 'ا', // آ → ا
  ة: 'ه', // ة → ه
};
const FOLDABLE = new RegExp('[' + Object.keys(FOLD).join('') + ']', 'g');

/** The comparable form of a text: same letters, whichever keyboard and
 * whichever vowel marks it was written with. */
function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(HARAKAT, '')
    .replace(FOLDABLE, (letter) => FOLD[letter] ?? letter)
    .toLowerCase();
}

/** The words of a text, as a set, for overlap scoring. */
export function terms(text: string): Set<string> {
  return new Set(normaliseText(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? []);
}

/** One line per distinct text: normalised, single-spaced, trimmed. Two memories
 * that differ only in spacing, case or vowel marks are one memory. */
export function contentKey(text: string): string {
  return normaliseText(text).replace(/\s+/g, ' ').trim();
}
