-- Audit log: every change Proposal Pulse makes to a live project through Snippet Injection
-- (which has no deploy to record it) and every deletion of visit data. Append-only; the
-- retention job never deletes from it.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  -- snippet_added | snippet_updated | snippet_removed | site_forgotten | visits_deleted | visitor_opted_out
  action     text NOT NULL,
  site_id    text,
  site_name  text,
  host       text,
  -- where the change came from: webhook | dashboard | visitor
  via        text NOT NULL,
  detail     jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_site_idx ON audit_log (site_id, at DESC);
