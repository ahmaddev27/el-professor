/*
  # Fix Salary Payment Calculation
  
  1. Changes
    - Update `update_salary_payment_status` function to use `netto_salary` if available, otherwise `amount_due`
    - This ensures proper calculation when netto_salary has been set (manual adjustments)
    - Fixes issue where amount_due might be 0 but netto_salary has the correct value
  
  2. Logic
    - Priority: netto_salary > amount_due
    - Calculates: total_paid, remaining_balance, payment_status
    - Status: unpaid (0 paid) | partially_paid (0 < paid < total) | paid (paid >= total)
*/

CREATE OR REPLACE FUNCTION update_salary_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  salary_total decimal(10, 2);
  payments_total decimal(10, 2);
  new_status text;
  new_remaining decimal(10, 2);
BEGIN
  -- Get the salary total (use netto_salary if set, otherwise amount_due)
  SELECT COALESCE(netto_salary, amount_due, 0) INTO salary_total
  FROM salaries
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate total payments for this salary
  SELECT COALESCE(SUM(amount), 0) INTO payments_total
  FROM salary_payments
  WHERE salary_id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate remaining balance
  new_remaining := GREATEST(salary_total - payments_total, 0);

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
