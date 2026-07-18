-- Roof Visualizer → report: a project can carry one chosen "after" render
-- (the homeowner's new roof), shown in the report/proposal as an illustrative
-- preview. Nullable; the report simply omits it when absent.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS hero_render_url TEXT;
