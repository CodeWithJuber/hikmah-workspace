/** CoNLL-U in, reviewed sentences out.
 *
 * The training screen took one thing: a JSON array typed into a textarea. That
 * is fine for correcting three sentences and useless for teaching a language,
 * which is what the owner asked for — "bulk me model ko train kar sake".
 *
 * CoNLL-U is the format the corpus already arrives in. UD PUD, the licensed
 * data this model is fitted on, is distributed as CoNLL-U, and every annotation
 * tool exports it. Our own `Sentence` shape is literally its columns, so the
 * parser is a tab split plus two comment fields.
 *
 * On not using a package, since ready-made is the standing preference: checked
 * against npm on 2026-09-13, `conllu@0.1.2`, `conllujs@3.0.0` and
 * `conllu-stream@0.0.1` were all last published in 2022, and two of the three
 * are CC-BY-SA-4.0 — a content licence, wrong for code in a product meant to be
 * sold. Seventy lines with its own tests is the better trade here.
 *
 * Nothing is validated for correctness here beyond the format: `validateTeaching`
 * in ./training.ts remains the single gate on what may be trained, and this
 * feeds it rather than bypassing it.
 */

/** One token, in the shape the trainer wants. */
export type ParsedToken = {
  id: number;
  form: string;
  lemma: string;
  upos: string;
  head: number;
  deprel: string;
  feats: Record<string, string>;
};

export type ParsedSentence = {
  id: string;
  groupId: string;
  split: 'train';
  fold: -1;
  text: string;
  tokens: ParsedToken[];
};

/** A sentence that could not be read, and where. */
export type ParseProblem = { line: number; sentence: string; reason: string };

export type ParseResult = { rows: ParsedSentence[]; problems: ParseProblem[] };

/** `Case=Nom|Number=Sing` → an object. `_` means none. */
function features(field: string): Record<string, string> {
  if (!field || field === '_') return {};
  const feats: Record<string, string> = {};
  for (const pair of field.split('|')) {
    const at = pair.indexOf('=');
    if (at > 0) feats[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return feats;
}

/**
 * Read a CoNLL-U document.
 *
 * Reports rather than throws. One malformed token in a 300-sentence file used
 * to lose the whole upload, which is the difference between a bulk upload and a
 * bulk rejection: the caller gets the sentences that parsed and a list of the
 * ones that did not, with their line numbers.
 *
 * `groupId` is where these sentences come from, and it must start `owner/` —
 * the evaluation corpus is excluded by group, so training data that borrowed a
 * corpus group id would be marking its own homework.
 */
export function parseConllu(text: string, groupId: string): ParseResult {
  const rows: ParsedSentence[] = [];
  const problems: ParseProblem[] = [];
  const lines = text.split(/\r?\n/);

  let tokens: ParsedToken[] = [];
  let sentenceId = '';
  let sentenceText = '';
  let startedAt = 1;
  let broken = '';

  const flush = (endedAt: number) => {
    if (!tokens.length && !sentenceId && !sentenceText) return;
    const id = sentenceId || groupId + '#' + (rows.length + problems.length + 1);
    if (broken) problems.push({ line: startedAt, sentence: id, reason: broken });
    else if (!tokens.length) problems.push({ line: startedAt, sentence: id, reason: 'No tokens.' });
    else
      rows.push({
        id,
        groupId,
        split: 'train',
        fold: -1,
        // The `# text =` comment when the file carries one, and otherwise the
        // forms joined, which is what a reader needs to recognise the sentence.
        text: sentenceText || tokens.map((token) => token.form).join(' '),
        tokens,
      });
    tokens = [];
    sentenceId = '';
    sentenceText = '';
    broken = '';
    startedAt = endedAt + 1;
  };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    const number = index + 1;
    if (!line) {
      flush(number);
      return;
    }
    if (line.startsWith('#')) {
      const [key, ...rest] = line.slice(1).split('=');
      const value = rest.join('=').trim();
      if (key.trim() === 'sent_id') sentenceId = value;
      if (key.trim() === 'text') sentenceText = value;
      return;
    }
    const columns = raw.split('\t');
    if (columns.length < 8) {
      broken ||= `Line ${number} has ${columns.length} columns; CoNLL-U needs 10.`;
      return;
    }
    // Multiword ranges (1-2) and empty nodes (1.1) carry no dependency of their
    // own; the tokens they expand to follow and are read normally.
    if (/[-.]/.test(columns[0])) return;
    const id = Number(columns[0]);
    const head = Number(columns[6]);
    if (!Number.isInteger(id) || !Number.isInteger(head)) {
      broken ||= `Line ${number} has a non-numeric id or head.`;
      return;
    }
    if (id !== tokens.length + 1) {
      broken ||= `Line ${number}: token ids must run 1, 2, 3 — found ${columns[0]}.`;
      return;
    }
    tokens.push({
      id,
      form: columns[1],
      // `_` is CoNLL-U for "not annotated"; the trainer wants a string, and the
      // form is the honest stand-in for a lemma nobody supplied.
      lemma: columns[2] === '_' ? columns[1] : columns[2],
      upos: columns[3],
      head,
      deprel: columns[7],
      feats: features(columns[5]),
    });
  });
  flush(lines.length);

  return { rows, problems };
}
