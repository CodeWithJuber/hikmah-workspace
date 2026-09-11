/** Redact string values after parsing so short values and quotes cannot corrupt
 * JSON framing or identifiers. No attempt is made to block deliberate encoding. */
export function redactJson(text: string, secrets: string[]): string {
  const patterns = [...new Set(secrets.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') { for (const pattern of patterns) value = (value as string).replaceAll(pattern, '[credential redacted]'); return value; }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    return value;
  };
  return JSON.stringify(visit(JSON.parse(text)));
}
export function redactRpc(text: string, secrets: string[], eventStream: boolean) {
  if (!eventStream) return redactJson(text, secrets);
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(event=>{
    const data = event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    return data ? 'data: '+redactJson(data,secrets)+'\n\n' : '';
  }).join('');
}
