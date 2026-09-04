import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RedirectHop } from './types';

const isPrivateIp = (ip: string) => {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || normalized;
  if (ipv4 === '0.0.0.0' || ipv4.startsWith('0.') || ipv4.startsWith('127.') || ipv4.startsWith('10.') || ipv4.startsWith('192.168.') || ipv4.startsWith('169.254.')) return true;
  if (/^(?:192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.18\.|198\.19\.)/.test(ipv4)) return true;
  const first = Number(ipv4.split('.')[0]);
  if (first >= 224) return true;
  const carrier = ipv4.match(/^100\.(\d+)\./);
  if (carrier && Number(carrier[1]) >= 64 && Number(carrier[1]) <= 127) return true;
  const match = ipv4.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
};

export async function validatePublicUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw new Error('Введите корректный адрес сайта, например https://example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Поддерживаются только HTTP и HTTPS адреса');
  if (url.username || url.password) throw new Error('Адреса с логином и паролем не поддерживаются');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('Локальные адреса нельзя сканировать');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('Приватные и служебные IP-адреса нельзя сканировать');
  url.hash = '';
  return url;
}

export async function safeFetchDetailed(input: string | URL, init: RequestInit = {}, redirects = 0, chain: RedirectHop[] = []): Promise<{ response: Response; chain: RedirectHop[] }> {
  const url = await validatePublicUrl(String(input));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': 'SiteScan SEO Auditor/1.0 (+local audit tool)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.6',
        ...init.headers,
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 5) throw new Error('Слишком много перенаправлений');
      const location = response.headers.get('location');
      if (!location) return { response, chain };
      const target = new URL(location, url);
      await response.body?.cancel().catch(() => undefined);
      return safeFetchDetailed(target, init, redirects + 1, [...chain, { from: url.toString(), to: target.toString(), status: response.status }]);
    }
    return { response, chain };
  } finally {
    clearTimeout(timeout);
  }
}

export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return (await safeFetchDetailed(input, init)).response;
}
