/** URL / domain normalization helpers shared by L0 (ingest) and L1 (discovery). */

/** Strip scheme, path, query, and a leading www. Lowercased. Returns bare host. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, ''); // strip port
  return s;
}

/** Build a canonical https base URL for a domain. */
export function baseUrl(domain: string): string {
  return `https://${normalizeDomain(domain)}`;
}

/** Resolve a possibly-relative href against a base URL. Returns null if invalid. */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** True when a URL's host is the same registrable site as `domain` (ignores www). */
export function sameSite(url: string, domain: string): boolean {
  try {
    const host = normalizeDomain(new URL(url).host);
    const d = normalizeDomain(domain);
    return host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
