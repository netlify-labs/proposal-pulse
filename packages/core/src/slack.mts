import { env, stripSlash } from "./env.mts";
import type { Session } from "./types.mts";

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

const who = (s: Session) => (s.r ? `*${s.r}*` : "unknown (no personal link)");
const where = (s: Session) => [s.city, s.cc].filter(Boolean).join(", ") || "unknown location";
const device = (s: Session) => `${s.device} · ${s.browser}/${s.os}`;

function links(s: Session, dashboardUrl: string) {
  const dash = stripSlash(dashboardUrl);
  return {
    site: `<https://${s.host}|${siteLabel(s.host)}>`,
    dash: dash ? `\n<${dash}/#site=${encodeURIComponent(s.host)}|Open in Proposal Pulse>` : "",
  };
}

export function openAlert(s: Session, dashboardUrl: string) {
  const { site, dash } = links(s, dashboardUrl);
  let headline = `:eyes: *Opened*: ${site}`;
  let context = "First visit";
  if (s.newVisitor && s.visitorCount > 1) {
    headline = `:busts_in_silhouette: *New person opened*: ${site}`;
    context = `Possibly forwarded: ${s.visitorCount} different people have opened it`;
  } else if (!s.newVisitor && s.visitNo > 1) {
    headline = `:repeat: *Back again*: ${site}`;
    context = `Visit #${s.visitNo} from this person`;
  }
  const ref = s.ref ? ` · via ${s.ref}` : "";
  return `${headline}\nWho: ${who(s)} · ${where(s)} · ${device(s)}\n${context}${ref}${dash}`;
}

export function deepAlert(s: Session, dashboardUrl: string) {
  const { site, dash } = links(s, dashboardUrl);
  const secs = s.sections.length ? `\nRead: ${s.sections.slice(0, 8).join(" → ")}` : "";
  return `:book: *Deep read*: ${site}\nWho: ${who(s)} · ${where(s)}\n${fmtDur(s.engagedMs)} so far · ${s.maxScroll}% scrolled${secs}${dash}`;
}

export function testAlert(dashboardUrl: string) {
  return `:white_check_mark: *Proposal Pulse is connected*\nAlerts for tracked projects land here: opens, return visits, forwards and deep reads.\n<${stripSlash(dashboardUrl)}|Open the dashboard>`;
}
