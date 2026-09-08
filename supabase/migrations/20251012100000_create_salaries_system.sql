-- =====================================================
-- SALARIES SYSTEM MIGRATION - CORRECTED VERSION
-- Fixed: Uses user_profiles.user_id (uuid) instead of id (bigint)
-- =====================================================

-- Step 1: Add salary_ratio column to drivers table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'drivers'
    AND column_name = 'salary_ratio'
  ) THEN
    ALTER TABLE public.drivers ADD COLUMN salary_ratio numeric(5,4) NOT NULL DEFAULT 0.5000;
    RAISE NOTICE '✓ Added salary_ratio column to drivers table';
  ELSE
    RAISE NOTICE '✓ salary_ratio column already exists';
  END IF;
END $$;

-- Step 2: Add check constraint for salary_ratio
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drivers_salary_ratio_check'
  ) THEN
    ALTER TABLE public.drivers ADD CONSTRAINT drivers_salary_ratio_check
      CHECK (salary_ratio >= 0 AND salary_ratio <= 1);
    RAISE NOTICE '✓ Added salary_ratio check constraint';
  ELSE
    RAISE NOTICE '✓ salary_ratio check constraint already exists';
  END IF;
END $$;

-- Step 3: Create salaries table
CREATE TABLE IF NOT EXISTS public.salaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  calc_revenue numeric(14,2) NOT NULL DEFAULT 0,
  calc_tips numeric(14,2) NOT NULL DEFAULT 0,
  amount_due numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('paid', 'unpaid')) DEFAULT 'unpaid',
  paid_at timestamptz,
  notes text,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT unique_driver_period UNIQUE (driver_id, period_start)
);

-- Step 4: Enable RLS on salaries table
ALTER TABLE public.salaries ENABLE ROW LEVEL SECURITY;

-- Step 5: Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_salaries_driver_id ON public.salaries(driver_id);
CREATE INDEX IF NOT EXISTS idx_salaries_period ON public.salaries(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_salaries_status ON public.salaries(status);
CREATE INDEX IF NOT EXISTS idx_salaries_created_by ON public.salaries(created_by);

-- Step 6: Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Authenticated users can view salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can insert salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can update salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can delete salaries" ON public.salaries;

-- =====================================================
-- Step 7: Create RLS policies for salaries table
-- FIXED: Uses user_profiles.user_id (uuid) = auth.uid()
-- Previously tried: user_profiles.id (bigint) = auth.uid() ❌
-- =====================================================

-- Policy: All authenticated users can view salaries
CREATE POLICY "Authenticated users can view salaries"
  ON public.salaries
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Admins can insert salaries
-- CORRECTED: user_id (uuid) instead of id (bigint)
CREATE POLICY "Admin and creators can insert salaries"
  ON public.salaries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- Policy: Admins can update salaries
-- CORRECTED: user_id (uuid) instead of id (bigint)
CREATE POLICY "Admin and creators can update salaries"
  ON public.salaries
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- Policy: Admins can delete salaries
-- CORRECTED: user_id (uuid) instead of id (bigint)
CREATE POLICY "Admin and creators can delete salaries"
  ON public.salaries
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- Step 8: Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_salaries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 9: Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS salaries_updated_at_trigger ON public.salaries;
CREATE TRIGGER salaries_updated_at_trigger
  BEFORE UPDATE ON public.salaries
  FOR EACH ROW
  EXECUTE FUNCTION update_salaries_updated_at();

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
DECLARE
  salary_ratio_exists boolean;
  salaries_exists boolean;
  policy_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'salary_ratio'
  ) INTO salary_ratio_exists;
  
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'salaries'
  ) INTO salaries_exists;
  
  SELECT COUNT(*) INTO policy_count
  FROM pg_policies
  WHERE tablename = 'salaries';
  
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'MIGRATION VERIFICATION';
  RAISE NOTICE '========================================';
  
  IF salary_ratio_exists THEN
    RAISE NOTICE '✓ salary_ratio column exists';
  ELSE
    RAISE WARNING '✗ salary_ratio column NOT found';
  END IF;
  
  IF salaries_exists THEN
    RAISE NOTICE '✓ salaries table exists';
  ELSE
    RAISE WARNING '✗ salaries table NOT found';
  END IF;
  
  RAISE NOTICE '✓ % RLS policies created', policy_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Key fix: Policies now use user_profiles.user_id (uuid)';
  RAISE NOTICE 'instead of user_profiles.id (bigint) to match auth.uid()';
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'MIGRATION COMPLETE!';
  RAISE NOTICE '========================================';
END $$;
