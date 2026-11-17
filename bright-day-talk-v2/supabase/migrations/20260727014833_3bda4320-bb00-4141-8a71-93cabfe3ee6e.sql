ALTER TABLE public.seniors
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS analysis jsonb,
  ADD COLUMN IF NOT EXISTS analysis_at timestamptz;

CREATE INDEX IF NOT EXISTS seniors_phone_idx ON public.seniors (phone);