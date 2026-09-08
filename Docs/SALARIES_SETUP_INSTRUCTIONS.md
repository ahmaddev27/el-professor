# Salaries System Setup Instructions

## Quick Setup (Copy & Paste into Supabase)

### Step 1: Open Supabase SQL Editor
1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Click on "SQL Editor" in the left sidebar
4. Click "New query" button

### Step 2: Run the Migration
1. Open the file `apply_salaries_migration.sql` in this project
2. Copy the ENTIRE contents of that file
3. Paste it into the Supabase SQL Editor
4. Click "Run" button (or press Ctrl+Enter / Cmd+Enter)

### Step 3: Verify Success
You should see messages like:
- "Added salary_ratio column to drivers table"
- "Added salary_ratio check constraint"
- Plus other success indicators

### Step 4: Verify the Database Changes

Run this query to check everything was created:

```sql
-- Check if salary_ratio column exists in drivers table
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'drivers' AND column_name = 'salary_ratio';

-- Check if salaries table exists
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'salaries';

-- Check salaries table structure
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'salaries'
ORDER BY ordinal_position;

-- Check RLS policies
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename = 'salaries';
```

Expected results:
- ✅ `salary_ratio` column in drivers table (numeric, default 0.5000)
- ✅ `salaries` table exists with all columns
- ✅ 4 RLS policies on salaries table (SELECT, INSERT, UPDATE, DELETE)

---

## What This Migration Does

### 1. Adds to `drivers` table:
- **salary_ratio** column (numeric 0.0-1.0, default 0.5 = 50%)
- Check constraint to ensure ratio is between 0 and 1

### 2. Creates new `salaries` table:
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| driver_id | uuid | References drivers table |
| period_start | date | First day of month |
| period_end | date | Last day of month |
| calc_revenue | numeric(14,2) | Sum of Umsatz |
| calc_tips | numeric(14,2) | Sum of Trinkgeld |
| amount_due | numeric(14,2) | Total salary owed |
| status | text | 'paid' or 'unpaid' |
| paid_at | timestamptz | When marked as paid |
| notes | text | Optional notes |
| created_by | uuid | User who created record |
| created_at | timestamptz | Creation timestamp |
| updated_at | timestamptz | Last update timestamp |

### 3. Security (RLS Policies):
- **View**: All authenticated users
- **Insert/Update/Delete**: Admin or record creator only
- **Status changes**: Admin only (enforced in UI)

### 4. Indexes for Performance:
- Index on driver_id
- Index on period dates
- Index on status

---

## Troubleshooting

### Issue: "relation already exists"
This is OK! It means the table was already created. The script handles this safely.

### Issue: "column already exists"
This is OK! The script checks before adding columns.

### Issue: Policies fail to create
1. Drop all salaries policies first:
```sql
DROP POLICY IF EXISTS "Authenticated users can view salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can insert salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can update salaries" ON public.salaries;
DROP POLICY IF EXISTS "Admin and creators can delete salaries" ON public.salaries;
```
2. Then re-run the policy creation section from the migration file

### Issue: "user_profiles table not found"
Make sure you've run all previous migrations first. The user_profiles table should exist from earlier migrations.

---

## After Migration

1. **Refresh your application** - The Salaries menu item should now work
2. **Set driver salary ratios** - Go to the Fahrer page and edit each driver to set their salary_ratio (default is 0.5 = 50%)
3. **Start tracking salaries** - Go to Salaries page (/salaries) to view and manage monthly salaries

---

## Need Help?

If you encounter any issues:
1. Check the Supabase logs for detailed error messages
2. Verify all previous migrations have been run
3. Make sure you're logged in as an admin user
