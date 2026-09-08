/*
  # Fix Drivers Created_By - Convert Email to UUID

  1. Issue
    - Some drivers have email addresses in created_by field instead of UUIDs
    - This breaks RLS policies that compare created_by with auth.uid()
    - Notes and other related data become invisible to users

  2. Solution
    - Update all drivers where created_by is an email address
    - Look up the corresponding UUID from auth.users
    - Update created_by to use the UUID

  3. Security
    - Maintains proper ownership relationships
    - Enables RLS policies to work correctly
*/

-- Update drivers where created_by contains an email address
UPDATE drivers d
SET created_by = (
  SELECT u.id::text 
  FROM auth.users u 
  WHERE u.email = d.created_by
)
WHERE d.created_by LIKE '%@%' 
  AND EXISTS (
    SELECT 1 
    FROM auth.users u 
    WHERE u.email = d.created_by
  );
