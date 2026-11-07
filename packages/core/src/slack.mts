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

/**
 * Alert layout: one line with the proposal, the alert type and a dashboard link, nothing else.
 *   🔥 *proposal-name* · read to the end and clicked → https://dashboard/#site=host
 * Who opened it, where from, and the reading details stay in the dashboard, so they're covered
 * by its access control and the RETENTION_DAYS purge instead of being copied into Slack.
 */
function alertText(s: Session, emoji: string, what: string, dashboardUrl: string) {
  const dash = stripSlash(dashboardUrl);
  const url = dash ? `${dash}/#site=${encodeURIComponent(s.host)}` : `https://${s.host}`;
  return `${emoji} *${siteLabel(s.host)}* · ${what} → ${url}`;
}

type Part = { emoji: string; what: string; plainOpen?: boolean };

function part(s: Session, type: AlertType): Part {
  if (type === "hot") return { emoji: ":fire:", what: "read to the end and clicked" };
  if (type === "deep") return { emoji: ":book:", what: "deep read" };
  if (s.newVisitor && s.visitorCount > 1) return { emoji: ":busts_in_silhouette:", what: "new person opened it (possible forward)" };
  if (!s.newVisitor && s.visitNo > 1) return { emoji: ":repeat:", what: "came back" };
  return { emoji: ":eyes:", what: "opened", plainOpen: true };
}

/**
 * One message for every alert a visit earned at the same moment, led by the strongest
 * (🔥, then deep read, then open). A plain first-visit "opened" is dropped when combined,
 * since the stronger alert implies it; "came back" and "new person" are kept.
 */
export function composeAlert(s: Session, types: AlertType[], dashboardUrl: string) {
  const order: AlertType[] = ["hot", "deep", "open"];
  let parts = order.filter((t) => types.includes(t)).map((t) => part(s, t));
  if (parts.length > 1) parts = parts.filter((p) => !p.plainOpen);
  return alertText(s, parts[0].emoji, parts.map((p) => p.what).join(" · "), dashboardUrl);
}

export const openAlert = (s: Session, dashboardUrl: string) => composeAlert(s, ["open"], dashboardUrl);
export const hotAlert = (s: Session, dashboardUrl: string) => composeAlert(s, ["hot"], dashboardUrl);
export const deepAlert = (s: Session, dashboardUrl: string) => composeAlert(s, ["deep"], dashboardUrl);

export function testAlert(dashboardUrl: string) {
  return `:white_check_mark: *Proposal Pulse is connected*\nAlerts for tracked projects land here: opens, return visits, forwards and deep reads.\n<${stripSlash(dashboardUrl)}|Open the dashboard>`;
}
