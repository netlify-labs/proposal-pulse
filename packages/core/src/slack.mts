import { env, stripSlash } from "./env.mts";
import type { AlertType, Session } from "./types.mts";

/**
 * Optional Slack alerts. Messages are written in Slack mrkdwn with <url|label> links.
 * - Incoming Webhook (hooks.slack.com/services/...) gets mrkdwn as is.
 * - Workflow Builder webhook (hooks.slack.com/triggers/...) gets one plain `text` variable,
 *   so links are flattened to "label: url" and *bold* markers are dropped.
 * Set SLACK_ALERTS=off to pause every post without removing the webhook.
 */
export const slackPaused = () => env("SLACK_ALERTS").toLowerCase() === "off";

export function slackMode(url = env("SLACK_WEBHOOK_URL")): "none" | "paused" | "workflow" | "webhook" {
  if (!url) return "none";
  if (slackPaused()) return "paused";
  return /\/triggers\//.test(url) ? "workflow" : "webhook";
}

const toPlain = (s: string) => s.replace(/<([^|>]+)\|([^>]+)>/g, "$2: $1").replace(/\*([^*\n]+)\*/g, "$1");

export async function postSlack(text: string) {
  const mode = slackMode();
  if (mode === "none") return { ok: false, error: "SLACK_WEBHOOK_URL is not set" };
  if (mode === "paused") return { ok: false, error: "Slack alerts are paused (SLACK_ALERTS=off)" };
  const body = mode === "workflow" ? { text: toPlain(text) } : { text, unfurl_links: false, unfurl_media: false };
  const res = await fetch(env("SLACK_WEBHOOK_URL"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.text();
  if (!res.ok) console.error("slack error", res.status, out.slice(0, 200));
  return { ok: res.ok, status: res.status, body: out.slice(0, 200) };
}

export const siteLabel = (host: string) => host.replace(/\.netlify\.app$/, "");

export function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Alert layout (two lines, dashboard link only, so Slack doesn't expand proposal previews):
 *   🔥 *proposal-name* · by Creator · what happened
 *   recipient · place · details → https://dashboard/#site=host
 */
export type AlertSite = { createdByName?: string | null };

function alertText(s: Session, emoji: string, what: string, details: string[], dashboardUrl: string, site?: AlertSite) {
  const dash = stripSlash(dashboardUrl);
  const url = dash ? `${dash}/#site=${encodeURIComponent(s.host)}` : `https://${s.host}`;
  const by = site?.createdByName ? ` · by ${site.createdByName}` : "";
  const place = [s.city, s.cc].filter(Boolean).join(", ") || "Unknown location";
  const line2 = [s.r ? `*${s.r}*` : "", place, ...details].filter(Boolean).join(" · ");
  return `${emoji} *${siteLabel(s.host)}*${by} · ${what}\n${line2} → ${url}`;
}

type Part = { emoji: string; what: string; details: string[]; plainOpen?: boolean };

function part(s: Session, type: AlertType): Part {
  if (type === "hot") {
    const n = s.clicks.length;
    return { emoji: ":fire:", what: "read to the end and clicked", details: [fmtDur(s.engagedMs), `${n} click${n === 1 ? "" : "s"}`] };
  }
  if (type === "deep") return { emoji: ":book:", what: `deep read (${fmtDur(s.engagedMs)})`, details: [`${s.maxScroll}% scrolled`] };
  if (s.newVisitor && s.visitorCount > 1)
    return { emoji: ":busts_in_silhouette:", what: `new person opened it (${s.visitorCount} people so far, possible forward)`, details: [] };
  if (!s.newVisitor && s.visitNo > 1) return { emoji: ":repeat:", what: `came back (visit #${s.visitNo})`, details: [] };
  return { emoji: ":eyes:", what: "opened (first visit)", details: s.ref ? [`via ${s.ref}`] : [], plainOpen: true };
}

/**
 * One message for every alert a visit earned at the same moment, led by the strongest
 * (🔥, then deep read, then open). A plain first-visit "opened" is dropped when combined,
 * since the stronger alert implies it; "came back" and "new person" are kept.
 */
export function composeAlert(s: Session, types: AlertType[], dashboardUrl: string, site?: AlertSite) {
  const order: AlertType[] = ["hot", "deep", "open"];
  let parts = order.filter((t) => types.includes(t)).map((t) => part(s, t));
  if (parts.length > 1) parts = parts.filter((p) => !p.plainOpen);
  const details = [...new Set(parts.flatMap((p) => p.details))];
  return alertText(s, parts[0].emoji, parts.map((p) => p.what).join(" · "), details, dashboardUrl, site);
}

export const openAlert = (s: Session, dashboardUrl: string, site?: AlertSite) => composeAlert(s, ["open"], dashboardUrl, site);
export const hotAlert = (s: Session, dashboardUrl: string, site?: AlertSite) => composeAlert(s, ["hot"], dashboardUrl, site);
export const deepAlert = (s: Session, dashboardUrl: string, site?: AlertSite) => composeAlert(s, ["deep"], dashboardUrl, site);

export function testAlert(dashboardUrl: string) {
  return `:white_check_mark: *Proposal Pulse is connected*\nAlerts for tracked projects land here: opens, return visits, forwards and deep reads.\n<${stripSlash(dashboardUrl)}|Open the dashboard>`;
}
