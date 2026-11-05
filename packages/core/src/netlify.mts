import { env } from "./env.mts";

const API = "https://api.netlify.com/api/v1";

export class NetlifyApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Call the Netlify API with the token in the named env var (default NETLIFY_TOKEN). */
export async function netlifyApi<T = any>(path: string, init: RequestInit = {}, tokenVar = "NETLIFY_TOKEN"): Promise<T> {
  const token = env(tokenVar);
  if (!token) throw new NetlifyApiError(`${tokenVar} is not set`, 0);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "proposal-pulse", ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new NetlifyApiError(`Netlify API ${init.method || "GET"} ${path} returned ${res.status} ${text}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type NetlifySite = {
  id: string;
  name: string;
  url: string;
  host: string;
  /** Every hostname the project answers on: primary, *.netlify.app, custom domain, aliases. */
  hosts: string[];
  team: string;
  teamName: string;
  createdAt: string;
  /** Last production publish (falls back to the last settings change). */
  publishedAt: string;
};

export function toNetlifySite(s: any): NetlifySite {
  const url: string = s.ssl_url || s.url || "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  const hosts = [host, s.name && `${s.name}.netlify.app`, s.custom_domain, ...(s.domain_aliases || [])].filter(Boolean) as string[];
  return {
    id: s.id,
    name: s.name || "",
    url,
    host,
    hosts: [...new Set(hosts)],
    team: s.account_slug || "",
    teamName: s.account_name || "",
    createdAt: s.created_at || "",
    publishedAt: s.published_deploy?.published_at || s.published_deploy?.created_at || s.updated_at || "",
  };
}

export const getMe = () => netlifyApi<{ id: string; email: string; full_name: string }>("/user");

export const getSite = async (id: string) => toNetlifySite(await netlifyApi(`/sites/${encodeURIComponent(id)}`));

/** Find a project by ID, name ("acme-proposal"), hostname or URL. The API accepts IDs and domains. */
export function resolveSite(ref: string) {
  const r = ref.trim();
  if (/^[0-9a-f-]{36}$/i.test(r)) return getSite(r);
  let host = r;
  try {
    if (/^https?:\/\//i.test(r)) host = new URL(r).hostname;
  } catch {}
  return getSite(host.includes(".") ? host : `${host}.netlify.app`);
}

/** Every project in a team, 10 pages of 100 at a time. */
export async function listTeamSites(team: string): Promise<NetlifySite[]> {
  const out: NetlifySite[] = [];
  for (let page = 1, done = false; !done && page < 200; page += 10) {
    const batch = await Promise.all(
      Array.from({ length: 10 }, (_, i) => netlifyApi<any[]>(`/${encodeURIComponent(team)}/sites?per_page=100&page=${page + i}`).catch(() => [] as any[])),
    );
    for (const sites of batch) {
      out.push(...sites.map(toNetlifySite));
      if (sites.length < 100) done = true;
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && !!seen.add(s.id));
}

// ---------- Snippet Injection ----------

export const SNIPPET_TITLE = "Proposal Pulse tracker";

export const snippetHtml = (collectorUrl: string) => `<script async src="${collectorUrl}/t.js"></script>`;

/** Add or update the tracker snippet on a project. Live immediately, no redeploy. */
export async function ensureSnippet(siteId: string, collectorUrl: string): Promise<string | undefined> {
  const list = await netlifyApi<any[]>(`/sites/${siteId}/snippets`);
  const existing = list.find((x) => x.title === SNIPPET_TITLE);
  const body = JSON.stringify({ title: SNIPPET_TITLE, general: snippetHtml(collectorUrl), general_position: "footer" });
  if (existing) {
    await netlifyApi(`/sites/${siteId}/snippets/${existing.id}`, { method: "PUT", body });
    return String(existing.id);
  }
  const created = await netlifyApi<any>(`/sites/${siteId}/snippets`, { method: "POST", body });
  return created?.id != null ? String(created.id) : undefined;
}

export async function removeSnippet(siteId: string): Promise<void> {
  const list = await netlifyApi<any[]>(`/sites/${siteId}/snippets`);
  for (const x of list.filter((x) => x.title === SNIPPET_TITLE)) {
    await netlifyApi(`/sites/${siteId}/snippets/${x.id}`, { method: "DELETE" });
  }
}
