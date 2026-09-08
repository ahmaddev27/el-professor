/*
  # Add settings permissions to existing roles

  This migration adds the 'settings' page permission to all existing roles.

  1. Changes
    - Add settings permission to admin role (view + edit)
    - Add settings permission to supervisor role (view + edit)
    - Add settings permission to editor role (view only)

  2. Security
    - No changes to RLS policies
*/

-- Add settings permission for admin role
INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
SELECT id, 'settings', true, true
FROM roles
WHERE name = 'admin'
ON CONFLICT DO NOTHING;

-- Add settings permission for supervisor role
INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
SELECT id, 'settings', true, true
FROM roles
WHERE name = 'supervisor'
ON CONFLICT DO NOTHING;

-- Add settings permission for editor role
INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
SELECT id, 'settings', true, false
FROM roles
WHERE name = 'editor'
ON CONFLICT DO NOTHING;
