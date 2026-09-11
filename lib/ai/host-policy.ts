/** Host policy shared by the browser transport and the server model registry.
 *
 * Both call providers, so both need the same answer to "may this origin be
 * contacted?". Keeping one implementation means a future fix cannot land in one
 * caller and miss the other.
 */

/** Loopback hosts, which are allowed to use plain HTTP. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Hosts that are not globally routable, and so are rejected by default.
 *
 * On the server this is the SSRF boundary: an operator-supplied base URL must
 * not be able to reach the container's own metadata service, the compose
 * network, or the host's private ranges unless it was explicitly allowed.
 */
export function isNonPublic(host: string): boolean {
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1).toLowerCase();
    // Only globally routed IPv6 unicast (2000::/3); reject private/mapped addresses.
    return !/^[23][0-9a-f]{0,3}:/.test(ip) || ip.startsWith('2001:db8:');
  }
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return !host.includes('.') || /\.(local|localhost|internal|invalid|test)$/.test(host);
}

/** Parse HIKMAH_PROVIDER_ALLOW_PRIVATE.
 *
 * Once the server makes provider calls, a self-hosted Ollama or vLLM reachable
 * only at `ollama:11434` on the compose network is indistinguishable from an
 * SSRF target. Rather than relax isNonPublic, the operator names the exact
 * `host:port` pairs they intend to reach. Format: comma-separated, e.g.
 * "ollama:11434,vllm:8000". A bare host allows any port on that host.
 */
export function parsePrivateAllowList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether an explicitly allow-listed private endpoint matches this URL. */
export function isAllowedPrivateHost(url: URL, allowed: Set<string>): boolean {
  if (!allowed.size) return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allowed.has(host) || allowed.has(`${host}:${port}`);
}
