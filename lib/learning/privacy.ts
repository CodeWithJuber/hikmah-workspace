/** Best-effort minimisation, before a separate learning copy is made.
 * Not an anonymisation guarantee: people can still identify themselves in
 * prose, so every collected answer remains pending until reviewed. */
export function redactLearningText(text: string, secrets: readonly string[] = []) {
  const redactions = new Set<string>();
  let value = text;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    for (const pattern of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])) {
      if (value.includes(pattern)) {
        value = value.replaceAll(pattern, '[credential redacted]');
        redactions.add('credential');
      }
    }
  }
  const replace = (pattern: RegExp, label: string) => {
    value = value.replace(pattern, () => {
      redactions.add(label);
      return '[' + label + ' redacted]';
    });
  };
  replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    'private key',
  );
  replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g,
    'credential',
  );
  replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi, 'credential');
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'credential');
  replace(
    /(?:["']?\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s,;\n}]+)/gi,
    'credential',
  );
  replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi, 'credential');
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'email');
  // International phone numbers only; plain measurements and years stay useful.
  replace(/\+\d[\d ().-]{7,}\d/g, 'phone');
  return { text: value, redactions: [...redactions] };
}
