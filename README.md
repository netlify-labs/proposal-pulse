# Proposal Pulse

**TL;DR:** See who opens the sites you share (proposals, pitch pages, previews), what they read, and when to follow up. Every new project in the Netlify teams you choose gets a small tracker automatically, through Netlify organization webhooks and Snippet Injection. Visits land in Netlify Database and show up in a dashboard protected by Netlify team login, with optional Slack alerts.

To install it into your Netlify account with an AI coding agent, jump to [Set up with an AI agent](#set-up-with-an-ai-agent).

## What it does

- **Opens, read time, scroll depth, sections read and clicks** for every tracked project.
- **Personal links:** add `?r=jane` to a link and every visit from that browser is labelled "jane", even if she comes back without the parameter.
- **Forward detection:** a new browser opening the same project shows up as "new person opened".
- **Password-protected projects:** visits to the Netlify password page are recorded separately, including wrong attempts.
- **Slack alerts (optional):** first open, return visit, possible forward, booking-link click (Calendly, Google Calendar, Zoom, HubSpot meetings and more), and reads over 2 minutes.
- **Hands-off enrollment:** a new project in your teams gets the tracker within seconds of being created. Existing projects get it on their next production deploy. Untrack a project once and it stays untracked.

## How it works

```
 Netlify organization                     Collector project (public)                  Dashboard project (team login)
 ────────────────────                     ──────────────────────────                  ──────────────────────────────
 site_created / site_published ──signed──▶ /hooks/netlify-site                         /api/data, /api/admin
                                           │ verify signature, check team,             │ reads Netlify Database
                                           │ inject <script src=".../t.js"> via         │ directly (PULSE_DATABASE_URL)
                                           │ Snippet Injection                          │
 Visitor's browser on a tracked project    │                                            │
 t.js ──────────── beacons ───────────────▶ /api/t ──▶ Netlify Database ◀───────────────┘
                                                  └──▶ Slack alerts (optional)
```

- **`apps/collector`** must stay public: visitors' browsers load `t.js` and send beacons to it, and Netlify delivers org webhooks to it, and none of those can pass site protection. It owns the Netlify Database (provisioned for this project; migrations in `apps/collector/netlify/database/migrations`) and has no endpoint that returns visit data. It can live in any team in the organization.
- **`apps/dashboard`** sits behind Netlify team login or Netlify password protection. It reads the collector's database directly with a **read-only** role. To track, untrack or forget a project it sends a request to the collector's `/api/manage`, signed with `HOOK_SECRET`. The collector is the only writer and the only project that holds a Netlify token.
- **`packages/core`** is shared, dependency-free code: the Netlify API client, webhook signature check, session logic, Slack formatting and `sites` queries.

### Data and privacy

The tracker sets no cookies and the collector stores no IP addresses. It keeps a random browser ID in `localStorage` and a tab session ID in `sessionStorage`. Location (city, country, timezone) comes from Netlify's edge geolocation. Visits older than `RETENTION_DAYS` (default 180) are deleted daily. Check whether your consent requirements apply to this kind of analytics before you track projects shared with people in regulated regions.

## Requirements

- A **Netlify organization** (Enterprise). Organization webhooks only fire for teams inside an organization.
- An **Organization Owner** for one step: subscribing the two org webhooks. Owning a team is not enough.
- **Netlify Database** available on the team that hosts the collector.
- A **Netlify personal access token** for the app, from a user who can edit projects in every team you want to track. Proposal Pulse uses it to add and remove the tracker snippet.
- Node.js 20.12.2 or later and Netlify CLI 26 or later (`npm install -g netlify-cli`).

## Set up with an AI agent

Paste this into your coding agent from a clone of this repository:

> Set up Proposal Pulse in my Netlify account by following the "Agent setup steps" section of README.md exactly, one step at a time.

### Agent setup steps

**Working rules for the agent**

- Collect every value in the inputs table from the user before step 1. Team slugs come from `app.netlify.com/teams/<slug>`; ask rather than guess.
- Treat `NETLIFY_TOKEN`, `HOOK_SECRET`, `PULSE_DATABASE_URL` and `SLACK_WEBHOOK_URL` as secrets: pass them through shell variables or files with mode 600 outside the repository, keep them out of output, logs and commits, and let the user type the token commands that contain their personal access token.
- Shell variables may not survive between your commands. Re-derive values from the inputs, or read them from the files you created.
- Run each command from the directory shown. If a command fails, stop and show the user the exact error and the project it affected.
- Every step ends with a **Done when** check. Run the check and confirm it passes before starting the next step.

**Inputs**

| Input | Example | Meaning |
|---|---|---|
| `HOME_TEAM` | `acme-web` | Team slug that will own the two Proposal Pulse projects. |
| `PULSE_TEAMS` | `acme-sales,acme-cs` | Comma-separated team slugs whose projects get the tracker. |
| `PREFIX` | `acme-pulse` | Project name prefix. Creates `<PREFIX>-collector` and `<PREFIX>-dashboard`. |
| Netlify token | (user provides) | Personal access token with edit access to every team in `PULSE_TEAMS`. |
| Slack webhook | (optional) | Incoming Webhook or Workflow Builder webhook URL for alerts. |
| Organization Owner | (a person) | Someone who can run step 8. |

**Step 1. Check prerequisites**

```bash
node --version
netlify --version
netlify status
netlify api listAccountsForUser | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s))console.log(a.slug, a.organization_id||"(no organization)")})'
```

Record `ORG_ID`: the `organization_id` of `HOME_TEAM`.

Done when: Node is 20.12.2 or later, the CLI is 26 or later, `netlify status` shows a logged-in user, and `HOME_TEAM` plus every team in `PULSE_TEAMS` is listed with the same `organization_id`. A team with no organization means org webhooks are unavailable: stop and tell the user.

**Step 2. Install and test** (repository root)

```bash
npm install
npm test
```

Done when: `npm test` reports all tests passed. One skipped test is expected; it needs a separate Postgres.

**Step 3. Create the two projects**

```bash
cd apps/collector && netlify sites:create --name "$PREFIX-collector" --account-slug "$HOME_TEAM" && cd ../..
cd apps/dashboard && netlify sites:create --name "$PREFIX-dashboard" --account-slug "$HOME_TEAM" && cd ../..
```

If a name is taken, choose another with the user and use it everywhere below. Record:

- `COLLECTOR_URL` = `https://<collector project name>.netlify.app`
- `DASHBOARD_URL` = `https://<dashboard project name>.netlify.app`
- `DASHBOARD_SITE_ID` = `siteId` in `apps/dashboard/.netlify/state.json`

Done when: `apps/collector/.netlify/state.json` and `apps/dashboard/.netlify/state.json` each contain a `siteId`, and the two IDs differ.

**Step 4. Protect the dashboard with team login**

```bash
netlify api updateSite --data "{\"site_id\":\"$DASHBOARD_SITE_ID\",\"body\":{\"sso_login\":true,\"sso_login_context\":\"all\"}}"
```

Done when: `netlify api getSite --data "{\"site_id\":\"$DASHBOARD_SITE_ID\"}"` shows `"sso_login": true`. If the API rejects it, ask the user to turn on team login under the dashboard project's **Project configuration > Access & security > Site protection**, then re-run the check.

**Step 5. Configure the collector** (`apps/collector`)

Create the webhook signing secret once and keep it in a private file outside the repository:

```bash
umask 077 && openssl rand -hex 32 > ~/.proposal-pulse-hook-secret
```

```bash
cd apps/collector
netlify env:set HOOK_SECRET "$(cat ~/.proposal-pulse-hook-secret)" --secret --context production deploy-preview branch-deploy
netlify env:set PULSE_TEAMS "$PULSE_TEAMS"
netlify env:set DASHBOARD_URL "$DASHBOARD_URL"
```

Ask the user to run this themselves in `apps/collector`, with their token in place of `<token>`:

```bash
netlify env:set NETLIFY_TOKEN <token> --secret --context production deploy-preview branch-deploy
```

Optional Slack alerts (user runs it, same folder):

```bash
netlify env:set SLACK_WEBHOOK_URL <slack-webhook-url> --secret --context production deploy-preview branch-deploy
```

Done when: `netlify env:list --json` in `apps/collector` lists `HOOK_SECRET`, `NETLIFY_TOKEN`, `PULSE_TEAMS` and `DASHBOARD_URL` (plus `SLACK_WEBHOOK_URL` if the user chose alerts).

**Step 6. Deploy the collector** (`apps/collector`)

```bash
netlify deploy --prod --message "Proposal Pulse collector"
```

The first production deploy provisions the Netlify Database and applies the migrations. If it fails with `401` on database creation, run `netlify deploy` (a preview deploy, no `--prod`) once, then retry the production deploy. If the preview deploy fails too, stop and report the error. If the CLI asks which app to use, add `--filter @proposal-pulse/collector`.

Done when all three pass:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$COLLECTOR_URL/t.js"                          # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$COLLECTOR_URL/hooks/netlify-site"    # 401 (bad signature: receiver is live)
netlify database status --branch production --json                                      # initial_schema under "applied"
```

**Step 7. Configure and deploy the dashboard** (`apps/dashboard`)

Copy the collector's production connection string to the dashboard without printing it. `production` is the database branch behind production deploys:

```bash
cd apps/collector
netlify database status --branch production --show-credentials --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).database?.connectionString;if(!u){console.error("no connection string found");process.exit(1)}require("fs").writeFileSync(require("os").homedir()+"/.proposal-pulse-db-url",u,{mode:0o600})})'
cd ../dashboard
netlify env:set PULSE_DATABASE_URL "$(cat ~/.proposal-pulse-db-url)" --secret --context production deploy-preview branch-deploy
rm ~/.proposal-pulse-db-url
```

Then, still in `apps/dashboard`:

```bash
netlify env:set HOOK_SECRET "$(cat ~/.proposal-pulse-hook-secret)" --secret --context production deploy-preview branch-deploy
netlify env:set COLLECTOR_URL "$COLLECTOR_URL"
```

The connection string is a read-only role (`netlifydb_readonly`). That is intended: the dashboard only reads, and asks the collector for every change.

Then deploy:

```bash
netlify deploy --prod --message "Proposal Pulse dashboard"
```

Done when: `curl -s -o /dev/null -w "%{http_code}\n" "$DASHBOARD_URL/"` returns `401` (team login is on), and the user opens `DASHBOARD_URL`, signs in, and confirms the **Setup** tab shows Database, Collector and Netlify token as connected.

**Step 8. Subscribe the organization webhooks** (Organization Owner)

The Organization Owner runs this with their own personal access token in `ORG_OWNER_TOKEN`, plus `ORG_ID`, `COLLECTOR_URL` and the contents of `~/.proposal-pulse-hook-secret` as `HOOK_SECRET`. Give them those three values; never ask for their token.

```bash
for EVENT in site_created site_published; do
  curl -sS -X POST "https://api.netlify.com/api/v1/organizations/$ORG_ID/hooks" \
    -H "Authorization: Bearer $ORG_OWNER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"event\":\"$EVENT\",\"data\":{\"url\":\"$COLLECTOR_URL/hooks/netlify-site\",\"signature_secret\":\"$HOOK_SECRET\"}}"
  echo
done
```

Done when: both calls return JSON with an `id`. A `404` means the token does not belong to an Organization Owner of `ORG_ID`.

**Step 9. Prove it end to end**

Create a throwaway project in one of the `PULSE_TEAMS` teams and record its `id`:

```bash
netlify sites:create --name "$PREFIX-e2e-$(date +%s)" --account-slug <one of PULSE_TEAMS> --disable-linking --json
```

Within 60 seconds the tracker snippet should be on it:

```bash
netlify api listSiteSnippets --data '{"site_id":"<test project id>"}'
```

Then delete the test project, and in the dashboard's **Setup** tab select it and click **Forget**:

```bash
netlify api deleteSite --data '{"site_id":"<test project id>"}'
```

Done when: the snippet list showed `"title": "Proposal Pulse tracker"` with `<script async src="<COLLECTOR_URL>/t.js">`, and the test project is deleted. If no snippet appears, open **Setup > Org webhook > Recent deliveries** in the dashboard: the `outcome` and `detail` columns say what happened.

**Step 10. Finish**

```bash
rm ~/.proposal-pulse-hook-secret
```

Done when: the user has `DASHBOARD_URL`, knows that new projects in `PULSE_TEAMS` are tracked on creation and existing ones on their next production deploy, and knows how to untrack a project (**Setup > Projects > Untrack**).

## Configuration reference

Netlify sets each project's own production URL as `URL`, so neither project needs its own address configured.

**Collector**

| Variable | | Purpose |
|---|---|---|
| `NETLIFY_TOKEN` | required, secret | Personal access token used to add the tracker snippet. Needs edit access to every team in `PULSE_TEAMS`. |
| `HOOK_SECRET` | required, secret | Signing secret shared with the org webhooks. |
| `PULSE_TEAMS` | required | Comma-separated team slugs to track. Empty means nothing is tracked. |
| `DASHBOARD_URL` | required | Dashboard's URL: linked from Slack alerts, and never tracked. |
| `SLACK_WEBHOOK_URL` | optional, secret | Slack Incoming Webhook or Workflow Builder webhook. |
| `SLACK_ALERTS` | optional | Set to `off` to pause alerts without removing the webhook. |
| `RETENTION_DAYS` | optional | Days of visit data to keep. Default 180. |

**Dashboard**

| Variable | | Purpose |
|---|---|---|
| `PULSE_DATABASE_URL` | required, secret | The collector's read-only production database connection string (step 7). |
| `HOOK_SECRET` | required, secret | Same value as the collector; signs the dashboard's requests to the collector. |
| `COLLECTOR_URL` | required | Collector's URL, for those requests. |
| `DASHBOARD_PASSWORD` | optional, secret | Extra in-app password on top of team login. |

Netlify Functions read environment variables at deploy time: redeploy a project after changing its variables.

## Deploy from Git

After setup you can link each project to your fork, so a merge to `main` deploys both. In each project's **Build & deploy** settings, connect the repository and set:

| | Collector | Dashboard |
|---|---|---|
| Base directory | `apps/collector` | `apps/dashboard` |
| Build command | (empty) | (empty) |
| Branch | `main` | `main` |

Set the base directory, not the package directory: each app's `netlify.toml` resolves `public` and `netlify/functions` relative to the base directory. The rest of the repository is still checked out, so the shared `packages/core` code resolves.

## Operating it

- **Pause Slack alerts:** set `SLACK_ALERTS=off` on the collector and redeploy. Alerts that would have fired meanwhile are marked as sent, so turning alerts back on does not flood the channel.
- **Track a project now:** dashboard **Setup > Projects**, enter its name or URL and click **Track**. Use it for an existing project you are about to share, or to turn tracking back on after an untrack.
- **Stop tracking a project:** dashboard **Setup > Projects > Untrack**. The snippet is removed and later deploys leave it alone.
- **A tracked project was deleted:** select it and click **Forget**.
- **Rotate the database credentials:** repeat the connection-string part of step 7 and redeploy the dashboard.
- **Schema changes:** add a new timestamped `.sql` file under `apps/collector/netlify/database/migrations` and deploy the collector. Keep migrations additive (new tables, nullable columns), since the dashboard reads the same database and may deploy separately. Never edit or delete an applied migration.
- **Webhook health:** the dashboard's **Setup > Org webhook** shows the last delivery and per-outcome counts for the last 24 hours. Every org event is logged, including events for teams you don't track (`ignored`).
- **Deploy previews of the collector** get their own database branch copied from production, which includes visitor data. Keep preview links private.

## Development

```bash
npm install
npm run typecheck
npm test                                       # unit tests + schema tests on a local Postgres emulator
TEST_DATABASE_URL=postgres://... npm test      # also runs the concurrency test against a real, empty Postgres
```

```
apps/
  collector/   public project: t.js, /api/t beacons, /hooks/netlify-site, daily cleanup, database migrations
  dashboard/   team-login project: dashboard UI, /api/data, /api/admin
packages/
  core/        shared code used by both apps
test/          unit and schema tests
```
