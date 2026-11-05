-- One-time backfill: visits recorded before the collector saved coordinates only have a
-- city and country. Place them at the city centre (rounded to 1 decimal, like live visits)
-- so they show on the maps. Only touches visits that have no coordinates yet.
UPDATE sessions s
SET data = jsonb_set(jsonb_set(s.data, '{lat}', to_jsonb(p.lat)), '{lon}', to_jsonb(p.lon))
FROM (VALUES
  ('Atlanta', 'US', 33.7, -84.4),
  ('San Francisco', 'US', 37.8, -122.4),
  ('Redwood City', 'US', 37.5, -122.2),
  ('Vancouver', 'CA', 49.3, -123.1)
) AS p (city, cc, lat, lon)
WHERE s.data->>'city' = p.city
  AND s.data->>'cc' = p.cc
  AND (s.data->>'lat') IS NULL;
