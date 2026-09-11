import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type AyahNote = Record<string, unknown> & {
  ayah_key: string;
  observation: string;
  application_note: string;
};
let ledger: Promise<AyahNote[]> | undefined;
export async function researchQuran(args: { verse?: unknown; query?: unknown }) {
  const verse = typeof args.verse === 'string' ? args.verse.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (verse && !/^\d{1,3}:\d{1,3}$/.test(verse)) throw Error('Use a verse key such as 49:6.');
  if (!verse && (!query || query.length > 300))
    throw Error('Supply a verse key or a query up to 300 characters.');
  ledger ??= readFile(join(process.cwd(), 'public/research/v6/original/ayah-ledger.jsonl'), 'utf8')
    .then((raw) =>
      raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AyahNote),
    )
    .catch((error) => {
      ledger = undefined;
      throw error;
    });
  const rows = await ledger;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const results = verse
    ? rows.filter((row) => row.ayah_key === verse)
    : rows
        .map((row) => ({
          row,
          score: terms.filter((term) =>
            [row.observation, row.application_note, row.surah_name]
              .join(' ')
              .toLocaleLowerCase()
              .includes(term),
          ).length,
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((item) => item.row);
  return {
    source: 'Hikmah retained ayah research index',
    recordType: 'AI-authored research notes, not scripture or tafsir text',
    scholarlyVerification: 'not_independently_verified',
    totalIndexed: rows.length,
    results,
    note: 'Read verse_url and tafsir_url for the actual text, edition and surrounding context. Coverage and file integrity do not validate an interpretation. No match is not evidence that the Quran lacks a concept.',
  };
}
