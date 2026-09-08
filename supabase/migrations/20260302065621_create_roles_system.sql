/*
  # Create Roles and Permissions System

  1. New Tables
    - `roles`
      - `id` (uuid, primary key)
      - `name` (text, unique) - Role name
      - `description` (text) - Role description
      - `is_system` (boolean) - If true, cannot be deleted (for admin, supervisor, editor)
      - `created_by` (uuid) - User who created the role
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `role_permissions`
      - `id` (uuid, primary key)
      - `role_id` (uuid, foreign key to roles)
      - `page_key` (text) - Page identifier (e.g., 'overview', 'drivers', 'income')
      - `can_view` (boolean) - Can view the page
      - `can_edit` (boolean) - Can edit/modify data on the page
      - `created_at` (timestamptz)

  2. Changes to Existing Tables
    - Update `user_profiles` to reference `roles` table via `role_id`
    - Keep existing `role` column for backward compatibility during migration
    - Add trigger to sync role name with role_id

  3. Security
    - Enable RLS on both tables
    - Admin can manage all roles
    - Supervisor can view roles
    - Editor can view roles
    - System roles cannot be deleted

  4. Data Migration
    - Create default system roles (admin, supervisor, editor) with full permissions
*/

-- Create roles table
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  description text DEFAULT '',
  is_system boolean DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create role_permissions table
CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid REFERENCES roles(id) ON DELETE CASCADE NOT NULL,
  page_key text NOT NULL,
  can_view boolean DEFAULT false,
  can_edit boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(role_id, page_key)
);

-- Add role_id to user_profiles if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'role_id'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN role_id uuid REFERENCES roles(id);
  END IF;
END $$;

-- Enable RLS
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for roles table
CREATE POLICY "Admin can view all roles"
  ON roles
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Supervisor and editor can view roles"
  ON roles
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('supervisor', 'editor')
    )
  );

CREATE POLICY "Admin can insert roles"
  ON roles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admin can update roles"
  ON roles
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admin can delete non-system roles"
  ON roles
  FOR DELETE
  TO authenticated
  USING (
    is_system = false
    AND EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- RLS Policies for role_permissions table
CREATE POLICY "Admin and supervisor can view all permissions"
  ON role_permissions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  );

CREATE POLICY "Editor can view permissions"
  ON role_permissions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'editor'
    )
  );

CREATE POLICY "Admin can insert permissions"
  ON role_permissions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admin can update permissions"
  ON role_permissions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admin can delete permissions"
  ON role_permissions
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Insert default system roles with full permissions for all pages
DO $$
DECLARE
  admin_role_id uuid;
  supervisor_role_id uuid;
  editor_role_id uuid;
  page_keys text[] := ARRAY[
    'overview', 'drivers', 'income', 'receipts', 'fixed-costs', 
    'salaries', 'cash-balance', 'statistics', 'print', 'accounting',
    'users', 'cars', 'werkstatt', 'notes', 'roles'
  ];
  current_page_key text;
BEGIN
  -- Insert admin role
  INSERT INTO roles (name, description, is_system)
  VALUES ('admin', 'Administrator with full access', true)
  ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
  RETURNING id INTO admin_role_id;

  -- Insert supervisor role
  INSERT INTO roles (name, description, is_system)
  VALUES ('supervisor', 'Supervisor with full view and edit access', true)
  ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
  RETURNING id INTO supervisor_role_id;

  -- Insert editor role
  INSERT INTO roles (name, description, is_system)
  VALUES ('editor', 'Editor with limited access', true)
  ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
  RETURNING id INTO editor_role_id;

  -- Add full permissions for admin (view and edit all pages)
  FOREACH current_page_key IN ARRAY page_keys
  LOOP
    INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
    VALUES (admin_role_id, current_page_key, true, true)
    ON CONFLICT (role_id, page_key) DO UPDATE 
    SET can_view = true, can_edit = true;
  END LOOP;

  -- Add full permissions for supervisor (view and edit all pages)
  FOREACH current_page_key IN ARRAY page_keys
  LOOP
    INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
    VALUES (supervisor_role_id, current_page_key, true, true)
    ON CONFLICT (role_id, page_key) DO UPDATE 
    SET can_view = true, can_edit = true;
  END LOOP;

  -- Add limited permissions for editor (view most, edit some)
  FOREACH current_page_key IN ARRAY page_keys
  LOOP
    IF current_page_key IN ('users', 'roles') THEN
      -- No access to users and roles management
      INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
      VALUES (editor_role_id, current_page_key, false, false)
      ON CONFLICT (role_id, page_key) DO UPDATE 
      SET can_view = false, can_edit = false;
    ELSIF current_page_key IN ('statistics', 'accounting', 'print') THEN
      -- View only for reports
      INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
      VALUES (editor_role_id, current_page_key, true, false)
      ON CONFLICT (role_id, page_key) DO UPDATE 
      SET can_view = true, can_edit = false;
    ELSE
      -- View and edit for operational pages
      INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
      VALUES (editor_role_id, current_page_key, true, true)
      ON CONFLICT (role_id, page_key) DO UPDATE 
      SET can_view = true, can_edit = true;
    END IF;
  END LOOP;

  -- Update existing users to link to role_id
  UPDATE user_profiles up
  SET role_id = r.id
  FROM roles r
  WHERE up.role = r.name
  AND up.role_id IS NULL;
END $$;

-- Create trigger to keep role column in sync with role_id
CREATE OR REPLACE FUNCTION sync_user_profile_role()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role_id IS NOT NULL THEN
    SELECT name INTO NEW.role
    FROM roles
    WHERE id = NEW.role_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_role_trigger ON user_profiles;
CREATE TRIGGER sync_role_trigger
  BEFORE INSERT OR UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_profile_role();

-- Add updated_at trigger for roles
CREATE OR REPLACE FUNCTION update_roles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_roles_updated_at_trigger ON roles;
CREATE TRIGGER update_roles_updated_at_trigger
  BEFORE UPDATE ON roles
  FOR EACH ROW
  EXECUTE FUNCTION update_roles_updated_at();
