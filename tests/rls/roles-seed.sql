/* The fixture is --schema-only, so the system roles and their permission
   matrix have to be recreated. These are the same rows the live database
   holds; without them current_role_permits() denies everything and every
   assertion would pass for the wrong reason.

   Three roles, not four. `viewer` is seeded by migration 20261025130000,
   which is newer than the fixture epoch (20260908) and so applies before this
   file. It is deliberately NOT repeated here: it was hand-created on
   production on 26.04.2026 and no migration created it, and a copy in this
   seed is exactly what let that drift sit unnoticed — an assertion about the
   row would have measured the seed and passed with the migration reverted.
   Section 9 of company-roles.sql is the assertion; leaving the row out of this
   file is what gives it something to measure. If a future rebase drops that
   migration, every file here that looks the role up by name fails loudly
   rather than silently testing the seed. */
\set ON_ERROR_STOP on

INSERT INTO roles (id, name, description, company_id, is_system) VALUES
  ('84626035-c3a2-4ff5-96b9-a95cceb85cb0', 'admin',      'Administrator', NULL, true),
  ('dd20a60b-1042-44d8-89fd-705b4c09b008', 'supervisor', 'Supervisor',    NULL, true),
  ('6244fcda-95e9-429f-916f-f510e37f3737', 'editor',     'Editor',        NULL, true)
ON CONFLICT (id) DO NOTHING;

-- admin and supervisor: everything. editor: read-only on the four listed pages
-- and no access to users/roles. `viewer` is excluded by name, not merely
-- absent from the CASE: it exists by now (the migration above created it), so
-- `WHERE r.is_system` alone would have this file write its 16 rows and the
-- assertion would again be measuring the seed.
INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
SELECT r.id, p.page,
       CASE WHEN r.name = 'editor' AND p.page IN ('users','roles') THEN false ELSE true END,
       CASE
         WHEN r.name IN ('admin','supervisor') THEN true
         WHEN r.name = 'editor' AND p.page IN ('accounting','documents','settings','statistics','users','roles') THEN false
         ELSE true
       END
FROM roles r
CROSS JOIN (VALUES ('accounting'),('cars'),('cash-balance'),('documents'),('drivers'),
                   ('fixed-costs'),('income'),('notes'),('overview'),('receipts'),
                   ('roles'),('salaries'),('settings'),('statistics'),('users'),('werkstatt')) AS p(page)
WHERE r.is_system
  AND r.name <> 'viewer'
ON CONFLICT (role_id, page_key) DO NOTHING;

SELECT 'roles=' || (SELECT count(*) FROM roles) ||
       ' permissions=' || (SELECT count(*) FROM role_permissions);
