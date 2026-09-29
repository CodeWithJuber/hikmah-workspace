// Verifiable answers (PR-17): a deterministic check over a settled answer,
// so every factual claim links to its source, the exact data behind each
// claim is shown, disagreements surface explicitly, and unsupported answers
// say so plainly.
//
// Pure: it reads the message's own parts — text, source-url/source-document
// parts, research tool outputs, data-disagreement parts — and nothing else.
// No model calls, no network, no invented quotes. When the run did not read
// a source, the evidence says so instead of pretending otherwise.
//
// A message with no research intent (no sources, no research tools, no
// disagreement record) yields null: an ordinary chat answer gets no
// verifiability surface, because a claim detector firing on greetings and
// opinions would be noise, not honesty.

import { dedupeSources, type CitedSource } from './citations.ts';
import type { TranscriptPart } from './working.ts';

/** Server-published record of sources that disagree; see lib/ai/tools/deep-research.ts. */
export const DISAGREEMENT_PART_ID = 'disagreement';
export const DISAGREEMENT_PART_TYPE = 'data-' + DISAGREEMENT_PART_ID;

/** Where the exact data behind a claim came from, in the run's own words. */
export type EvidenceProvenance = 'search-snippet' | 'page-read' | 'unfetched' | 'fetch-failed';

export type SourceEvidence = {
  /** Index into the message's deduped source list. */
  index: number;
  url?: string;
  title?: string;
  /** The exact text the run read: a search snippet or a page window. */
  quote?: string;
  provenance: EvidenceProvenance;
};

export type ClaimStatus = 'cited' | 'orphan' | 'dangling';

export type ClaimCheck = {
  text: string;
  /** Citation numbers the claim carries, in order. */
  markers: number[];
  status: ClaimStatus;
};

export type DisagreementParty = {
  /** URL (or title) of the disagreeing source, as the lane reported it. */
  source: string;
  /** What that source says, in the lane's words, bounded. */
  says: string;
  /** The source list's title for this URL, when the message cites it. */
  title?: string;
};

export type SourceDisagreement = {
  /** What the sources disagree about. */
  claim: string;
  parties: DisagreementParty[];
};

export type VerifiabilityVerdict =
  'supported' | 'partial' | 'disputed' | 'unsupported' | 'source-error';

export type VerifiabilityReport = {
  verdict: VerifiabilityVerdict;
  claims: ClaimCheck[];
  cited: number;
  orphans: number;
  dangling: number;
  /** One entry per deduped source, in source order. */
  evidence: SourceEvidence[];
  disagreements: SourceDisagreement[];
  /** Labels of cited sources whose fetch failed. */
  fetchFailures: string[];
  /** A search ran and returned nothing at all. */
  searchedButEmpty: boolean;
};

/** Tools whose presence means the turn was trying to answer from evidence. */
const RESEARCH_TOOL_NAMES = new Set([
  'search_web',
  'search_reference',
  'read_webpage',
  'research_quran',
  'deep_research',
]);

const toolNameOf = (part: TranscriptPart): string => {
  if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') return part.toolName;
  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : '';
};

const isSourcePart = (part: TranscriptPart): part is TranscriptPart & CitedSource =>
  part.type === 'source-url' || part.type === 'source-document';

/** Normalise for matching: same page under http/https, www, or a trailing
 *  slash is the same source. The query string is kept — it can change the page. */
function normalizeEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(String(raw).trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return host + path + url.search;
  } catch {
    return null;
  }
}

const MARKER_PATTERN = /\[(\d+)\](?![\(\[])/g;

function markerNumbers(text: string): number[] {
  MARKER_PATTERN.lastIndex = 0;
  const numbers: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = MARKER_PATTERN.exec(text)) !== null) numbers.push(Number(match[1]));
  return numbers;
}

/** A marker resolves only to a source that can actually be shown or followed —
 *  the same rule the citation pills use, so a claim and its pill never disagree. */
function resolvable(sources: CitedSource[], n: number): boolean {
  if (n < 1 || n > sources.length) return false;
  const source = sources[n - 1];
  return !!(source.url || source.title);
}

/** Split answer text into claim candidates. Fenced code, headings and
 *  questions are not claims — a citation never lives inside them, and a
 *  question asserts nothing. Sentence splitting is heuristic; the report
 *  counts what it checked, so the heuristic stays inspectable.
 *
 *  Citation markers glue to the sentence they follow ("…7500.[1]"): a
 *  sentence that *starts* with markers lends them to the claim before it,
 *  which is the Perplexity-style convention the pills already assume. */
export function extractClaims(text: string, sources: CitedSource[]): ClaimCheck[] {
  const withoutCode = String(text ?? '').replace(/```[\s\S]*?```/g, ' ');
  // Separate a marker glued to sentence-ending punctuation so the split sees
  // the boundary: "7500.[1] It" -> "7500. [1] It".
  const spaced = withoutCode.replace(/([.!?])(\[\d+\])/g, '$1 $2');
  const claims: ClaimCheck[] = [];
  const push = (sentence: string, markers: number[]) => {
    const cited = markers.some((n) => resolvable(sources, n));
    claims.push({
      text: sentence,
      markers,
      status: markers.length === 0 ? 'orphan' : cited ? 'cited' : 'dangling',
    });
  };
  for (const line of spaced.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
    for (const raw of sentences) {
      let sentence = raw.trim();
      if (!sentence || sentence.endsWith('?')) continue;
      // Leading markers belong to the previous claim ("…7500. [1] It …").
      const leading = sentence.match(/^(\[\d+\](?![\(\[])\s*)+/);
      if (leading && claims.length > 0) {
        const prev = claims[claims.length - 1];
        const moved = markerNumbers(leading[0]);
        prev.markers.push(...moved);
        const cited = prev.markers.some((n) => resolvable(sources, n));
        prev.status = prev.markers.length === 0 ? 'orphan' : cited ? 'cited' : 'dangling';
        sentence = sentence.slice(leading[0].length).trim();
        if (!sentence) continue;
      }
      // Fragments ("Ji.", "OK") assert too little to check.
      if (sentence.split(/\s+/).filter(Boolean).length < 3) continue;
      push(sentence, markerNumbers(sentence));
    }
  }
  return claims;
}

type FoundQuote = { quote: string; provenance: 'search-snippet' | 'page-read' };

const QUOTE_CHARS = 280;

/** The exact data the run read, keyed by normalised URL: search snippets and
 *  read page windows from the message's own tool outputs. */
function quotesByUrl(parts: readonly TranscriptPart[]): Map<string, FoundQuote> {
  const found = new Map<string, FoundQuote>();
  for (const part of parts) {
    const name = toolNameOf(part);
    if (part.state !== 'output-available') continue;
    const output = part.output as
      | { results?: { title?: unknown; url?: unknown; snippet?: unknown }[] }
      | { source?: unknown; content?: unknown }
      | undefined;
    if ((name === 'search_web' || name === 'search_reference') && output && 'results' in output) {
      for (const result of output.results ?? []) {
        const key = result?.url === undefined ? null : normalizeEvidenceUrl(String(result.url));
        const snippet = String(result?.snippet ?? '').trim();
        if (key && snippet && !found.has(key))
          found.set(key, {
            quote: snippet.slice(0, QUOTE_CHARS).trim(),
            provenance: 'search-snippet',
          });
      }
    } else if (name === 'read_webpage' && output && 'source' in output) {
      const key = output.source === undefined ? null : normalizeEvidenceUrl(String(output.source));
      const content = String((output as { content?: unknown }).content ?? '').trim();
      if (key && content && !found.has(key))
        found.set(key, { quote: content.slice(0, QUOTE_CHARS).trim(), provenance: 'page-read' });
    }
  }
  return found;
}

/** URLs the run tried to read but could not, from failed read_webpage calls. */
function failedUrls(parts: readonly TranscriptPart[]): Set<string> {
  const failed = new Set<string>();
  for (const part of parts) {
    if (toolNameOf(part) !== 'read_webpage') continue;
    if (part.state !== 'output-error' && part.state !== 'output-denied') continue;
    const input = part.input as { url?: unknown } | undefined;
    const key = input?.url === undefined ? null : normalizeEvidenceUrl(String(input.url));
    if (key) failed.add(key);
  }
  return failed;
}

/** One evidence entry per deduped source: the exact quote when the run read
 *  it, an honest label when it did not. */
export function collectEvidence(
  parts: readonly TranscriptPart[],
  sources: CitedSource[],
): SourceEvidence[] {
  const quotes = quotesByUrl(parts);
  const failed = failedUrls(parts);
  return sources.map((source, index) => {
    const key = source.url ? normalizeEvidenceUrl(source.url) : null;
    if (key && failed.has(key))
      return { index, url: source.url, title: source.title, provenance: 'fetch-failed' as const };
    const found = key ? quotes.get(key) : undefined;
    if (found)
      return {
        index,
        url: source.url,
        title: source.title,
        quote: found.quote,
        provenance: found.provenance,
      };
    return { index, url: source.url, title: source.title, provenance: 'unfetched' as const };
  });
}

const MAX_DISAGREEMENTS = 5;
const MAX_DISAGREEMENT_CHARS = 500;

type RawParty = { source?: unknown; says?: unknown };
type RawDisagreement = { claim?: unknown; parties?: unknown };

function validParty(raw: RawParty): DisagreementParty | null {
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const says = typeof raw.says === 'string' ? raw.says.trim() : '';
  if (!source || !says) return null;
  return { source, says: says.slice(0, MAX_DISAGREEMENT_CHARS) };
}

/**
 * Admit a server-published disagreement record. Disagreement parts are
 * written by the run's own tools through the data channel — a model cannot
 * forge one — so admission is structural: a real claim, at least two sides,
 * each side saying something. Malformed records are dropped, never rendered
 * half-parsed.
 */
export function readDisagreements(
  parts: readonly TranscriptPart[],
  sources: CitedSource[],
): SourceDisagreement[] {
  const admitted: SourceDisagreement[] = [];
  // Match a reported URL to the message's own source list, so the banner can
  // name the source the way the answer's citations do.
  const titles = new Map<string, string>();
  for (const source of sources) {
    if (!source.url) continue;
    const key = normalizeEvidenceUrl(source.url);
    if (key && source.title && !titles.has(key)) titles.set(key, source.title);
  }
  for (const part of parts) {
    if (part.type !== DISAGREEMENT_PART_TYPE) continue;
    const data = part.data as { disagreements?: unknown } | undefined;
    const records = Array.isArray(data?.disagreements) ? data.disagreements : [];
    for (const raw of records as RawDisagreement[]) {
      if (admitted.length >= MAX_DISAGREEMENTS) break;
      const claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
      const parties = (Array.isArray(raw.parties) ? raw.parties : [])
        .map((party) => validParty(party as RawParty))
        .filter((party): party is DisagreementParty => party !== null)
        .map((party) => {
          const key = normalizeEvidenceUrl(party.source);
          const title = key ? titles.get(key) : undefined;
          return title ? { ...party, title } : party;
        });
      if (!claim || parties.length < 2) continue;
      admitted.push({ claim: claim.slice(0, MAX_DISAGREEMENT_CHARS), parties });
    }
  }
  return admitted;
}

/** The whole check for one settled message, or null when the message shows
 *  no research intent and therefore earns no verifiability surface. */
export function verifyMessage(parts: readonly TranscriptPart[]): VerifiabilityReport | null {
  const list = [...parts];
  const sources = dedupeSources(list.filter(isSourcePart));
  const hasResearchTool = list.some((part) => RESEARCH_TOOL_NAMES.has(toolNameOf(part)));
  const hasDisagreement = list.some((part) => part.type === DISAGREEMENT_PART_TYPE);
  if (sources.length === 0 && !hasResearchTool && !hasDisagreement) return null;

  const text = list
    .filter((part) => part.type === 'text')
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('\n\n');
  const claims = extractClaims(text, sources);
  const evidence = collectEvidence(list, sources);
  const disagreements = readDisagreements(list, sources);

  let cited = 0;
  let orphans = 0;
  let dangling = 0;
  const citedIndexes = new Set<number>();
  for (const claim of claims) {
    if (claim.status === 'cited') {
      cited++;
      for (const n of claim.markers) if (resolvable(sources, n)) citedIndexes.add(n - 1);
    } else if (claim.status === 'orphan') orphans++;
    else dangling++;
  }

  const fetchFailures = evidence
    .filter((entry) => entry.provenance === 'fetch-failed' && citedIndexes.has(entry.index))
    .map((entry) => entry.title ?? entry.url ?? `Source ${entry.index + 1}`);

  const searchedButEmpty =
    sources.length === 0 &&
    list.some((part) => {
      const name = toolNameOf(part);
      if (name !== 'search_web' && name !== 'search_reference') return false;
      if (part.state !== 'output-available') return false;
      const output = part.output as { results?: unknown[] } | undefined;
      return Array.isArray(output?.results) && output.results.length === 0;
    });

  // Precedence is deliberate: a disagreement or a failed fetch outweighs
  // claim counts, and "no sources at all" outweighs partial citation.
  let verdict: VerifiabilityVerdict = 'supported';
  if (disagreements.length > 0) verdict = 'disputed';
  else if (fetchFailures.length > 0) verdict = 'source-error';
  else if (sources.length === 0) verdict = 'unsupported';
  else if (orphans > 0 || dangling > 0) verdict = 'partial';

  return {
    verdict,
    claims,
    cited,
    orphans,
    dangling,
    evidence,
    disagreements,
    fetchFailures,
    searchedButEmpty,
  };
}

const claimWord = (n: number) => (n === 1 ? 'claim' : 'claims');

/** One plain line for the receipt: what was checked and what it found. */
export function verdictLine(report: VerifiabilityReport): string {
  const total = report.claims.length;
  const citedShare = `${report.cited} of ${total} ${claimWord(total)} ${total === 1 ? 'cites' : 'cite'} a source`;
  switch (report.verdict) {
    case 'disputed':
      return 'Sources disagree — see below';
    case 'source-error':
      return `${report.fetchFailures.length} cited ${report.fetchFailures.length === 1 ? 'source' : 'sources'} could not be fetched`;
    case 'unsupported':
      return report.searchedButEmpty
        ? 'No sources found for this question'
        : 'Unsupported by evidence';
    case 'partial': {
      const missing = report.orphans + report.dangling;
      return `${citedShare} — ${missing} ${claimWord(missing)} ${missing === 1 ? 'has' : 'have'} no source`;
    }
    case 'supported':
      return total === 0 ? 'No factual claims to check' : citedShare;
  }
}

/** Human label for an evidence entry's provenance, for the source cards. */
export function provenanceLabel(provenance: EvidenceProvenance): string {
  switch (provenance) {
    case 'search-snippet':
      return 'Search snippet';
    case 'page-read':
      return 'From the page';
    case 'fetch-failed':
      return 'Could not be fetched';
    case 'unfetched':
      return 'Not read in this run';
  }
}
