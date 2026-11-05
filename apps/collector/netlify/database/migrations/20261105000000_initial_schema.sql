-- Proposal Pulse schema. Applied automatically on the collector's deploys.
-- Keep later migrations additive (new tables, nullable columns): the dashboard reads
-- this database directly and may be one deploy behind the collector.

-- Netlify projects Proposal Pulse knows about.
--   tracked:  tracker snippet injected; beacons accepted
--   excluded: untracked by a person; webhooks never re-add it
--   ignored:  outside PULSE_TEAMS or not reachable with the token; cached so
--             org-wide site_published events skip the API lookup
CREATE TABLE sites (
  id          text PRIMARY KEY,
  name        text NOT NULL DEFAULT '',
  team        text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '',
  host        text NOT NULL DEFAULT '',
  hosts       text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL CHECK (status IN ('tracked', 'excluded', 'ignored')),
  snippet_id  text,
  via         text,
  tracked_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_status_idx ON sites (status);
CREATE INDEX sites_hosts_idx ON sites USING gin (hosts);

-- One row per browser (localStorage id) per site. Drives "back again" and "possibly forwarded".
CREATE TABLE visitors (
  host       text NOT NULL,
  vid        text NOT NULL,
  first_at   timestamptz NOT NULL DEFAULT now(),
  visits     integer NOT NULL DEFAULT 0,
  recipient  text,
  PRIMARY KEY (host, vid)
);

-- One row per visit. `data` holds the full session object the dashboard renders.
CREATE TABLE sessions (
  sid         text PRIMARY KEY,
  vid         text NOT NULL,
  host        text NOT NULL,
  started_at  timestamptz NOT NULL,
  last_at     timestamptz NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX sessions_last_at_idx ON sessions (last_at DESC);
CREATE INDEX sessions_host_last_at_idx ON sessions (host, last_at DESC);

-- Slack alerts already sent. The primary key makes each alert fire once per visit.
CREATE TABLE alerts (
  sid      text NOT NULL,
  type     text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sid, type)
);

-- Org webhook deliveries and what the collector did with each.
CREATE TABLE hook_events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL,
  site_id      text,
  site_name    text,
  team         text,
  outcome      text NOT NULL,
  detail       text
);
CREATE INDEX hook_events_received_at_idx ON hook_events (received_at DESC);

-- Small key/value settings (e.g. the org webhook subscription record).
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
