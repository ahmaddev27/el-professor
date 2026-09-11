/* The fixture is --schema-only, so the four system roles and their 16x4
   permission matrix have to be recreated. These are the same rows the live
   database holds; without them current_role_permits() denies everything and
   every assertion would pass for the wrong reason. */
\set ON_ERROR_STOP on

INSERT INTO roles (id, name, description, company_id, is_system) VALUES
  ('84626035-c3a2-4ff5-96b9-a95cceb85cb0', 'admin',      'Administrator', NULL, true),
  ('dd20a60b-1042-44d8-89fd-705b4c09b008', 'supervisor', 'Supervisor',    NULL, true),
  ('6244fcda-95e9-429f-916f-f510e37f3737', 'editor',     'Editor',        NULL, true),
  ('fdb2798f-08a7-481c-8bbb-67e15540926e', 'viewer',     'Betrachter',    NULL, true)
ON CONFLICT (id) DO NOTHING;

-- admin and supervisor: everything. editor: read-only on the four listed pages
-- and no access to users/roles. viewer: read everywhere, write nowhere.
INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
SELECT r.id, p.page,
       CASE WHEN r.name = 'editor' AND p.page IN ('users','roles') THEN false ELSE true END,
       CASE
         WHEN r.name IN ('admin','supervisor') THEN true
         WHEN r.name = 'viewer' THEN false
         WHEN r.name = 'editor' AND p.page IN ('accounting','documents','settings','statistics','users','roles') THEN false
         ELSE true
       END
FROM roles r
CROSS JOIN (VALUES ('accounting'),('cars'),('cash-balance'),('documents'),('drivers'),
                   ('fixed-costs'),('income'),('notes'),('overview'),('receipts'),
                   ('roles'),('salaries'),('settings'),('statistics'),('users'),('werkstatt')) AS p(page)
WHERE r.is_system
ON CONFLICT (role_id, page_key) DO NOTHING;

SELECT 'roles=' || (SELECT count(*) FROM roles) ||
       ' permissions=' || (SELECT count(*) FROM role_permissions);
