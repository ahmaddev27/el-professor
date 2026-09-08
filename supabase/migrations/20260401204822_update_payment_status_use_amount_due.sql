/*
  # Update Payment Status to Use Amount Due

  1. Changes
    - Update the `update_salary_payment_status` function to use `amount_due` instead of `netto_salary`
    - This allows payment tracking based on calculated salary amounts
    - Status is automatically calculated: unpaid, partially_paid, or paid

  2. Impact
    - Payments can now be tracked against the calculated salary amount
    - Status updates automatically when payments are added, updated, or deleted
*/

-- Update function to use amount_due instead of netto_salary
CREATE OR REPLACE FUNCTION update_salary_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  salary_total decimal(10, 2);
  payments_total decimal(10, 2);
  new_status text;
  new_remaining decimal(10, 2);
BEGIN
  -- Get the salary total (amount_due)
  SELECT amount_due INTO salary_total
  FROM salaries
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate total payments for this salary
  SELECT COALESCE(SUM(amount), 0) INTO payments_total
  FROM salary_payments
  WHERE salary_id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate remaining balance
  new_remaining := salary_total - payments_total;

  -- Determine status
  IF payments_total = 0 THEN
    new_status := 'unpaid';
  ELSIF payments_total >= salary_total THEN
    new_status := 'paid';
    new_remaining := 0;
  ELSE
    new_status := 'partially_paid';
  END IF;

  -- Update the salary record
  UPDATE salaries
  SET 
    total_paid = payments_total,
    remaining_balance = new_remaining,
    payment_status = new_status
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;