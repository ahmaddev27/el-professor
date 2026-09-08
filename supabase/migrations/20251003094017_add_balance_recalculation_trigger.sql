/*
  # Add automatic balance recalculation trigger

  1. Changes
    - Create a function to recalculate all balances in the receipts table
    - Create triggers to automatically recalculate balances after INSERT, UPDATE, or DELETE
    
  2. How it works
    - After any change to receipts, recalculates the running balance for all receipts
    - Orders receipts by date to maintain accurate running balance
    - Updates all receipts with new balance values

  3. Notes
    - This ensures balance is always up-to-date in the database
    - Running balance accumulates income and subtracts expenses chronologically
*/

-- Function to recalculate all balances
CREATE OR REPLACE FUNCTION recalculate_all_balances()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  receipt_record RECORD;
  running_balance NUMERIC := 0;
BEGIN
  -- Loop through all receipts ordered by date
  FOR receipt_record IN 
    SELECT id, income, expense 
    FROM receipts 
    ORDER BY date ASC, created_at ASC
  LOOP
    -- Calculate running balance
    running_balance := running_balance + COALESCE(receipt_record.income, 0) - COALESCE(receipt_record.expense, 0);
    
    -- Update the receipt with new balance
    UPDATE receipts 
    SET balance = running_balance 
    WHERE id = receipt_record.id;
  END LOOP;
END;
$$;

-- Function to trigger balance recalculation
CREATE OR REPLACE FUNCTION trigger_recalculate_balances()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Recalculate all balances after any change
  PERFORM recalculate_all_balances();
  RETURN NULL;
END;
$$;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS recalculate_balances_after_insert ON receipts;
DROP TRIGGER IF EXISTS recalculate_balances_after_update ON receipts;
DROP TRIGGER IF EXISTS recalculate_balances_after_delete ON receipts;

-- Create triggers for INSERT, UPDATE, and DELETE
CREATE TRIGGER recalculate_balances_after_insert
AFTER INSERT ON receipts
FOR EACH STATEMENT
EXECUTE FUNCTION trigger_recalculate_balances();

CREATE TRIGGER recalculate_balances_after_update
AFTER UPDATE ON receipts
FOR EACH STATEMENT
EXECUTE FUNCTION trigger_recalculate_balances();

CREATE TRIGGER recalculate_balances_after_delete
AFTER DELETE ON receipts
FOR EACH STATEMENT
EXECUTE FUNCTION trigger_recalculate_balances();
