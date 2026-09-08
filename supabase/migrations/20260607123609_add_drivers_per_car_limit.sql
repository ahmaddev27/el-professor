ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS drivers_per_car_limit integer NOT NULL DEFAULT 4;

ALTER TABLE company_settings
  ADD CONSTRAINT chk_drivers_per_car_limit
  CHECK (drivers_per_car_limit >= 1 AND drivers_per_car_limit <= 10);