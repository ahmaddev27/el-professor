/*
  # Fix infinite loop in balance recalculation trigger

  1. Changes
    - Drop the existing triggers that cause infinite loop
    - Remove the balance recalculation trigger functions
    - Balance will be calculated on the frontend when loading data
    
  2. Why
    - The trigger was causing infinite recursion because updating receipts triggered the trigger again
    - Frontend calculation is simpler and avoids database stack depth issues
*/

-- Drop all triggers
DROP TRIGGER IF EXISTS recalculate_balances_after_insert ON receipts;
DROP TRIGGER IF EXISTS recalculate_balances_after_update ON receipts;
DROP TRIGGER IF EXISTS recalculate_balances_after_delete ON receipts;

-- Drop functions
DROP FUNCTION IF EXISTS trigger_recalculate_balances();
DROP FUNCTION IF EXISTS recalculate_all_balances();
