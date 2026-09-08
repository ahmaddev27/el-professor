/*
  # RLS Company Isolation - Part 2
  Applies helper functions and all company-scoped policies.
  Drops existing policies by their real names before recreating them.
*/

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT company_id
  FROM user_profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(is_super_admin, false)
  FROM user_profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

-- =============================================================================
-- RECEIPTS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'receipts' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON receipts', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view receipts"
  ON receipts FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert receipts"
  ON receipts FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update receipts"
  ON receipts FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete receipts"
  ON receipts FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- INCOME
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'income' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON income', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view income"
  ON income FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert income"
  ON income FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update income"
  ON income FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete income"
  ON income FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- DRIVERS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'drivers' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON drivers', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view drivers"
  ON drivers FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert drivers"
  ON drivers FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update drivers"
  ON drivers FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete drivers"
  ON drivers FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- FIXED COSTS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'fixed_costs' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON fixed_costs', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view fixed_costs"
  ON fixed_costs FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert fixed_costs"
  ON fixed_costs FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update fixed_costs"
  ON fixed_costs FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete fixed_costs"
  ON fixed_costs FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- SALARIES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'salaries' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON salaries', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view salaries"
  ON salaries FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert salaries"
  ON salaries FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update salaries"
  ON salaries FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete salaries"
  ON salaries FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- SALARY PAYMENTS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'salary_payments' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON salary_payments', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view salary_payments"
  ON salary_payments FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert salary_payments"
  ON salary_payments FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update salary_payments"
  ON salary_payments FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete salary_payments"
  ON salary_payments FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- CASH TRANSACTIONS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'cash_transactions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON cash_transactions', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view cash_transactions"
  ON cash_transactions FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert cash_transactions"
  ON cash_transactions FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update cash_transactions"
  ON cash_transactions FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete cash_transactions"
  ON cash_transactions FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- CARS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'cars' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON cars', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view cars"
  ON cars FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert cars"
  ON cars FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update cars"
  ON cars FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete cars"
  ON cars FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- CAR DRIVER ASSIGNMENTS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'car_driver_assignments' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON car_driver_assignments', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view car_driver_assignments"
  ON car_driver_assignments FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert car_driver_assignments"
  ON car_driver_assignments FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update car_driver_assignments"
  ON car_driver_assignments FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete car_driver_assignments"
  ON car_driver_assignments FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- DRIVER NOTES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'driver_notes' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON driver_notes', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view driver_notes"
  ON driver_notes FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert driver_notes"
  ON driver_notes FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update driver_notes"
  ON driver_notes FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete driver_notes"
  ON driver_notes FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- WERKSTATT CHECKS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'werkstatt_checks' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON werkstatt_checks', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view werkstatt_checks"
  ON werkstatt_checks FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert werkstatt_checks"
  ON werkstatt_checks FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update werkstatt_checks"
  ON werkstatt_checks FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete werkstatt_checks"
  ON werkstatt_checks FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- DOCUMENTS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'documents' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON documents', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view documents"
  ON documents FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert documents"
  ON documents FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update documents"
  ON documents FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete documents"
  ON documents FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- DOCUMENT VARIABLES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'document_variables' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON document_variables', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view document_variables"
  ON document_variables FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_variables.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

CREATE POLICY "Company users can insert document_variables"
  ON document_variables FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_variables.document_id
        AND d.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company users can update document_variables"
  ON document_variables FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_variables.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_variables.document_id
        AND d.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company users can delete document_variables"
  ON document_variables FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_variables.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

-- =============================================================================
-- DOCUMENT BLOCKS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'document_blocks' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON document_blocks', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view document_blocks"
  ON document_blocks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_blocks.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

CREATE POLICY "Company users can insert document_blocks"
  ON document_blocks FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_blocks.document_id
        AND d.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company users can update document_blocks"
  ON document_blocks FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_blocks.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_blocks.document_id
        AND d.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company users can delete document_blocks"
  ON document_blocks FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_blocks.document_id
        AND (d.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

-- =============================================================================
-- DOCUMENT TEMPLATES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'document_templates' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON document_templates', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view document_templates"
  ON document_templates FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company users can insert document_templates"
  ON document_templates FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can update document_templates"
  ON document_templates FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company users can delete document_templates"
  ON document_templates FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

-- =============================================================================
-- DOCUMENT CATEGORIES (system-level, globally readable)
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'document_categories' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON document_categories', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Authenticated users can view document_categories"
  ON document_categories FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Super admins can insert document_categories"
  ON document_categories FOR INSERT TO authenticated
  WITH CHECK (is_user_super_admin());

CREATE POLICY "Super admins can update document_categories"
  ON document_categories FOR UPDATE TO authenticated
  USING (is_user_super_admin())
  WITH CHECK (is_user_super_admin());

CREATE POLICY "Super admins can delete document_categories"
  ON document_categories FOR DELETE TO authenticated
  USING (is_user_super_admin());

-- =============================================================================
-- COMPANY SETTINGS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'company_settings' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON company_settings', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Company users can view company_settings"
  ON company_settings FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Company admins can insert company_settings"
  ON company_settings FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company admins can update company_settings"
  ON company_settings FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Super admins can delete company_settings"
  ON company_settings FOR DELETE TO authenticated
  USING (is_user_super_admin());

-- =============================================================================
-- ROLES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'roles' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON roles', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view roles"
  ON roles FOR SELECT TO authenticated
  USING (
    company_id IS NULL
    OR company_id = get_user_company_id()
    OR is_user_super_admin()
  );

CREATE POLICY "Company admins can insert roles"
  ON roles FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company admins can update roles"
  ON roles FOR UPDATE TO authenticated
  USING (
    (company_id = get_user_company_id() OR is_user_super_admin())
    AND is_system = false
  )
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "Company admins can delete roles"
  ON roles FOR DELETE TO authenticated
  USING (
    (company_id = get_user_company_id() OR is_user_super_admin())
    AND is_system = false
  );

-- =============================================================================
-- ROLE PERMISSIONS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'role_permissions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON role_permissions', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view role_permissions"
  ON role_permissions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (r.company_id IS NULL OR r.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

CREATE POLICY "Company admins can insert role_permissions"
  ON role_permissions FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company admins can update role_permissions"
  ON role_permissions FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (r.company_id = get_user_company_id() OR is_user_super_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company admins can delete role_permissions"
  ON role_permissions FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (r.company_id = get_user_company_id() OR is_user_super_admin())
    )
  );

-- =============================================================================
-- USER PROFILES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'user_profiles' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON user_profiles', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view company profiles"
  ON user_profiles FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR company_id = get_user_company_id()
    OR is_user_super_admin()
  );

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update company profiles"
  ON user_profiles FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR company_id = get_user_company_id()
    OR is_user_super_admin()
  )
  WITH CHECK (
    user_id = auth.uid()
    OR company_id = get_user_company_id()
    OR is_user_super_admin()
  );

CREATE POLICY "Admins can delete company profiles"
  ON user_profiles FOR DELETE TO authenticated
  USING (
    company_id = get_user_company_id()
    OR is_user_super_admin()
  );

-- =============================================================================
-- COMPANIES
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'companies' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON companies', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view their company"
  ON companies FOR SELECT TO authenticated
  USING (id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Super admins can insert companies"
  ON companies FOR INSERT TO authenticated
  WITH CHECK (is_user_super_admin());

CREATE POLICY "Company admins can update their company"
  ON companies FOR UPDATE TO authenticated
  USING (id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "Super admins can delete companies"
  ON companies FOR DELETE TO authenticated
  USING (is_user_super_admin());

-- =============================================================================
-- USER SESSIONS
-- =============================================================================

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'user_sessions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON user_sessions', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view own sessions"
  ON user_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own sessions"
  ON user_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own sessions"
  ON user_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own sessions"
  ON user_sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid());
