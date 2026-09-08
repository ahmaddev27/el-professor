/*
  # Rename print permission to documents permission

  This migration updates the role permissions from 'print' to 'documents'
  to reflect the new Dokumente module.

  1. Changes
    - Update all role_permissions with page_key 'print' to 'documents'

  2. Security
    - No changes to RLS policies
*/

-- Update all print permissions to documents
UPDATE role_permissions
SET page_key = 'documents'
WHERE page_key = 'print';
