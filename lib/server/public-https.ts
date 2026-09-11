import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';

export function publicIPv4(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a,b,c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
/** Pin a validated public IPv4 result for this connection; TLS still verifies the
 * original hostname. No redirects, private DNS destinations, or pooled sockets. */
export async function publicHttpsRequest(target: URL, headers: Record<string,string>, body: string, signal: AbortSignal): Promise<Response> {
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search || (target.port && target.port !== '443')) throw Error('Invalid MCP destination.');
  const records = await lookup(target.hostname, {all: true, family: 4});
  signal.throwIfAborted();
  if (!records.length || records.some(r => !publicIPv4(r.address))) throw Error('This MCP endpoint must resolve to public IPv4 addresses.');
  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, {method: 'POST', headers, signal, agent: false,
      lookup: (_hostname, options, callback) => {
        const address = records[0].address;
        if (options.all) callback(null, [{address, family: 4}]);
        else callback(null, address, 4);
      },
    }, incoming => {
      const parts: Buffer[] = []; let size = 0;
      let settled = false, events = ''; const decoder = new TextDecoder();
      const rpcId = JSON.parse(body).id;
      const finish = () => {
        if (settled) return; settled = true;
        const status = incoming.statusCode ?? 502;
        const resultHeaders = new Headers();
        for (const name of ['content-type','mcp-session-id']) { const value = incoming.headers[name]; if (typeof value === 'string') resultHeaders.set(name, value); }
        resolve(new Response([204,304].includes(status) ? null : Buffer.concat(parts), {status, headers: resultHeaders}));
      };
      incoming.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 2_000_000) { req.destroy(Error('Connector response exceeded its limit.')); return; }
        parts.push(part);
        if (incoming.headers['content-type']?.includes('text/event-stream') && rpcId !== undefined) {
          events += decoder.decode(part, {stream:true});
          const complete = events.split(/\r?\n\r?\n/); events = complete.pop() ?? '';
          for (const event of complete) {
            const data = event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
            try {
              if (data && JSON.parse(data).id === rpcId) {
                // Return just this completed RPC event; discard any following partial event.
                parts.splice(0, parts.length, Buffer.from('data: '+data+'\n\n')); finish(); req.destroy(); return;
              }
            } catch { req.destroy(Error('Invalid MCP event.')); return; }
          }
        }
      });
      incoming.on('error', reject);
      incoming.on('end', finish);
    });
    req.setTimeout(120000, () => req.destroy(Error('Connector timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}
