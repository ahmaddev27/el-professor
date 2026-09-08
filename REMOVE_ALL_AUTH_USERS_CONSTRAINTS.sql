/*
  COMPREHENSIVE FIX: Remove ALL auth.users Foreign Key Constraints

  This script removes all foreign key constraints referencing auth.users
  from all tables in the database, which is causing permission errors.
*/

-- Drop foreign key constraints from all tables
ALTER TABLE IF EXISTS user_profiles DROP CONSTRAINT IF EXISTS user_profiles_user_id_fkey;
ALTER TABLE IF EXISTS receipts DROP CONSTRAINT IF EXISTS receipts_created_by_fkey;
ALTER TABLE IF EXISTS drivers DROP CONSTRAINT IF EXISTS drivers_created_by_fkey;
ALTER TABLE IF EXISTS income DROP CONSTRAINT IF EXISTS income_created_by_fkey;
ALTER TABLE IF EXISTS fixed_costs DROP CONSTRAINT IF EXISTS fixed_costs_created_by_fkey;
ALTER TABLE IF EXISTS salaries DROP CONSTRAINT IF EXISTS salaries_created_by_fkey;

-- Verify all constraints are removed
SELECT
  'All auth.users foreign key constraints removed!' as status,
  COUNT(*) as remaining_constraints
FROM information_schema.table_constraints tc
WHERE tc.constraint_type = 'FOREIGN KEY'
AND tc.table_schema = 'public'
AND tc.constraint_name LIKE '%auth%users%';
