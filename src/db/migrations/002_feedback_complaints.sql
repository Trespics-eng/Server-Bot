-- ============================================================================
-- MIGRATION 002: FEEDBACK AND COMPLAINTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.feedbacks_complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('feedback', 'complaint')),
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved')),
  admin_response TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fc_user_id ON public.feedbacks_complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_fc_status ON public.feedbacks_complaints(status);
CREATE INDEX IF NOT EXISTS idx_fc_type ON public.feedbacks_complaints(type);

ALTER TABLE public.feedbacks_complaints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own feedbacks"
  ON public.feedbacks_complaints FOR ALL
  USING (auth.uid() = user_id OR public.is_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin());
