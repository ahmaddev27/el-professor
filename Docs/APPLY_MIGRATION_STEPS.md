# Add Netto Salary Column - Step by Step Guide

The `netto_salary` column is missing from your database. Follow these steps to add it:

## Steps:

### 1. Open Supabase Dashboard
Go to: https://hnrvzakckwyomjwfizua.supabase.co

### 2. Navigate to SQL Editor
- Click on **"SQL Editor"** in the left sidebar
- Click **"New query"** button

### 3. Copy and Paste This SQL
```sql
ALTER TABLE public.salaries ADD COLUMN netto_salary numeric(10,2);
```

### 4. Run the Query
- Click the **"Run"** button (or press Cmd/Ctrl + Enter)
- You should see a success message

### 5. Verify the Column Was Added
Run this query to check:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'salaries'
ORDER BY ordinal_position;
```

You should see `netto_salary` in the list with type `numeric`.

### 6. Refresh Your Application
Once the column is added, refresh your application and the netto salary feature will work!

---

## What This Does
This adds a new column called `netto_salary` to store the net salary amounts that you manually enter for each driver's salary record.

## Safe to Run
This SQL is safe to run multiple times - if the column already exists, it will show an error but won't break anything.
