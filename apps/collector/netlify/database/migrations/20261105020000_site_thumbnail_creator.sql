-- Thumbnail and creator for each project, shown in the dashboard.
-- screenshot_url: Netlify's screenshot of the latest production deploy
-- created_by / created_by_name: Netlify user who created the project, and their name
ALTER TABLE sites ADD COLUMN screenshot_url text;
ALTER TABLE sites ADD COLUMN created_by text;
ALTER TABLE sites ADD COLUMN created_by_name text;
