import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Netlify webhook `x-webhook-signature` header: a JWS (HS256) over "header.claims",
 * where claims.iss === "netlify" and claims.sha256 is the hex SHA-256 of the raw body.
 */
export function verifyNetlifySignature(token: string, body: string, secret: string): boolean {
  if (!secret) return false;
  const [header, claims, sig] = (token || "").split(".");
  if (!header || !claims || !sig) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url"));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  try {
    const c = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    return c.iss === "netlify" && c.sha256 === createHash("sha256").update(body).digest("hex");
  } catch {
    return false;
  }
}

/** Build a valid signature. Used by tests and the setup check, never by the receiver. */
export function signNetlifyWebhook(body: string, secret: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const claims = enc({ iss: "netlify", sha256: createHash("sha256").update(body).digest("hex") });
  const sig = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${sig}`;
}

export type OrgHookPayload = { siteId: string; name: string; team: string };

/**
 * Pull the project out of an org webhook body. `site_created` sends the project object
 * (id = project id); `site_published` sends a deploy (id = deploy id, site_id = project id)
 * and carries no team slug.
 */
export function readOrgHook(p: any): OrgHookPayload {
  const siteId = String(p?.site_id || p?.id || "");
  return { siteId, name: String(p?.name || ""), team: String(p?.account_slug || "") };
}

export const isSiteId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

// ---------- Signed admin requests (dashboard -> collector) ----------

/** How long a signed admin request stays valid. */
export const MANAGE_MAX_AGE_MS = 5 * 60_000;

/** `ids` are project IDs; `refs` (track only) may be project names, URLs or IDs. */
export type ManageRequest = { op: "status" | "candidates" | "track" | "untrack" | "forget"; ids?: string[]; refs?: string[]; ts: number };

/** Body + signature header for a dashboard -> collector admin call, signed with HOOK_SECRET. */
export function signManageRequest(req: Omit<ManageRequest, "ts">, secret: string, now = Date.now()) {
  const body = JSON.stringify({ ...req, ts: now });
  return { body, signature: signNetlifyWebhook(body, secret) };
}

/** Parse and check a signed admin call: valid signature and a timestamp within MANAGE_MAX_AGE_MS. */
export function readManageRequest(body: string, signature: string, secret: string, now = Date.now()): ManageRequest | null {
  if (!verifyNetlifySignature(signature, body, secret)) return null;
  try {
    const r = JSON.parse(body) as ManageRequest;
    if (typeof r.ts !== "number" || Math.abs(now - r.ts) > MANAGE_MAX_AGE_MS) return null;
    if (!["status", "candidates", "track", "untrack", "forget"].includes(r.op)) return null;
    return r;
  } catch {
    return null;
  }
}
