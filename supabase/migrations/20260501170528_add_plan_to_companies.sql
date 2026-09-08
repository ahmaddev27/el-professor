/*
  # Add subscription plan to companies table

  ## Summary
  Adds a `plan` column to the `companies` table so each company has a tracked
  subscription tier. This is the single source of truth for plan-based feature
  gating throughout the application.

  ## Changes

  ### companies table
  - `plan` (text, NOT NULL, DEFAULT 'basic') — subscription tier
    Allowed values: 'basic' | 'advanced' | 'premium'
    - basic:    Übersicht, Belege, Fahrer, Fahrzeuge, Umsätze, Fixkosten,
                Bargeldbestand, Backup, Excel-Export
    - advanced: All basic + Werkstatt, Abrechnung, Notizen, Rollen & Nutzer
    - premium:  All advanced + Gehälter, Trinkgeld Quittung, Stundennachweis

  ## Notes
  - Existing companies default to 'basic' (conservative default — super admin
    can upgrade them via the CompaniesPage)
  - New companies set their plan at signup
  - During a 14-day trial the company gets access to all Premium features
    regardless of the stored plan (trial_end IS NOT NULL AND now() < trial_end)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'plan'
  ) THEN
    ALTER TABLE companies ADD COLUMN plan text NOT NULL DEFAULT 'basic';
  END IF;
END $$;
