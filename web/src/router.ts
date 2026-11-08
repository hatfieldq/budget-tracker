// Minimal hash router: "#/transactions?accountId=3" -> { path, params }.
import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function href(path: string, params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return `#/${path}${q ? `?${q}` : ''}`;
}
