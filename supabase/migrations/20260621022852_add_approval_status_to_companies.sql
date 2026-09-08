-- Add approval workflow columns to companies table
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  ADD COLUMN IF NOT EXISTS approval_note text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill all existing companies to approved
UPDATE companies SET approval_status = 'approved' WHERE approval_status = 'approved';
-- (default already 'approved', so existing rows are fine — explicit to be safe)

-- Add referral columns to companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS referral_id uuid,
  ADD COLUMN IF NOT EXISTS referral_code_used text,
  ADD COLUMN IF NOT EXISTS referred_at timestamptz;

-- Index for fast approval status queries
CREATE INDEX IF NOT EXISTS idx_companies_approval_status ON companies(approval_status);
