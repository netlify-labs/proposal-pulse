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

-- One-time cleanup of visits recorded before the tracker collected less:
--   * click labels came from the element's visible text: drop them
--   * click links kept query strings and fragments: keep origin + path; mailto:/tel: keep the scheme
--   * wrong password attempts were counted: drop the count
--   * link IDs that are email addresses: drop them
UPDATE sessions
SET data = jsonb_set(
  data - 'wrongPw',
  '{clicks}',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          't', c->'t',
          'label', '',
          'href', CASE
            WHEN c->>'href' ~* '^mailto:' THEN 'mailto:'
            WHEN c->>'href' ~* '^tel:' THEN 'tel:'
            WHEN c->>'href' ~* '^https?://' THEN regexp_replace(c->>'href', '[?#].*$', '')
            ELSE NULL
          END
        ))
        ORDER BY ord
      )
      FROM jsonb_array_elements(data->'clicks') WITH ORDINALITY AS x (c, ord)
    ),
    '[]'::jsonb
  )
)
WHERE data ? 'wrongPw' OR jsonb_array_length(COALESCE(data->'clicks', '[]'::jsonb)) > 0;

UPDATE sessions SET data = jsonb_set(data, '{r}', '""'::jsonb) WHERE data->>'r' LIKE '%@%';
UPDATE visitors SET recipient = NULL WHERE recipient LIKE '%@%';
