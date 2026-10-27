-- ============================================================================
-- SUPABASE POSTGRESQL SCHEMA FOR COMMERCIAL MULTI-USER WHATSAPP SAAS PLATFORM
-- ============================================================================

-- Enable pgcrypto extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Profiles Table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  trial_started_at TIMESTAMPTZ,
  trial_expires_at TIMESTAMPTZ,
  trial_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. WhatsApp Accounts Table (Enforced max 3 per customer)
CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone_number TEXT,
  label TEXT NOT NULL DEFAULT 'My WhatsApp',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'connecting', 'qr_ready', 'connected', 'disconnected', 'needs_reauthentication', 'error', 'suspended')
  ),
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON public.whatsapp_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON public.whatsapp_accounts(status);

-- Concurrency-safe enforcement of maximum 3 WhatsApp accounts per user
CREATE OR REPLACE FUNCTION public.check_max_whatsapp_accounts()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.whatsapp_accounts WHERE user_id = NEW.user_id) >= 3 THEN
    RAISE EXCEPTION 'Maximum limit of 3 WhatsApp accounts per customer reached.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_max_accounts ON public.whatsapp_accounts;
CREATE TRIGGER trg_enforce_max_accounts
BEFORE INSERT ON public.whatsapp_accounts
FOR EACH ROW
EXECUTE FUNCTION public.check_max_whatsapp_accounts();

-- 3. Feature Catalog Table (Includes individual features and All-In-One bundle)
CREATE TABLE IF NOT EXISTS public.feature_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'automation',
  is_bundle BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Feature Prices Table
CREATE TABLE IF NOT EXISTS public.feature_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id UUID NOT NULL REFERENCES public.feature_catalog(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly')),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0), -- Stored in lowest currency unit (cents or integer KES)
  currency TEXT NOT NULL DEFAULT 'KES',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feature_id, period)
);

-- 5. Feature Settings Table (Per-account settings)
CREATE TABLE IF NOT EXISTS public.feature_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_account_id UUID NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (whatsapp_account_id, feature_code)
);

CREATE INDEX IF NOT EXISTS idx_settings_account_code ON public.feature_settings(whatsapp_account_id, feature_code);

-- 6. Keyword Rules Table
CREATE TABLE IF NOT EXISTS public.keyword_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_account_id UUID NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact', 'contains', 'regex', 'starts_with')),
  case_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'private', 'group')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_account ON public.keyword_rules(whatsapp_account_id);

-- 7. Subscriptions Table
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  plan_period TEXT NOT NULL CHECK (plan_period IN ('weekly', 'monthly', 'trial')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('pending_payment', 'trialing', 'active', 'past_due', 'cancelled', 'expired', 'refunded')
  ),
  amount_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KES',
  start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at TIMESTAMPTZ NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  order_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subs_user_account ON public.subscriptions(user_id, whatsapp_account_id);
CREATE INDEX IF NOT EXISTS idx_subs_status_expiry ON public.subscriptions(status, end_at);

-- 8. Orders Table
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  plan_period TEXT NOT NULL CHECK (plan_period IN ('weekly', 'monthly')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id);

-- 9. Payments Table
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('mpesa', 'card')),
  provider_tx_ref TEXT,
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
  payer_phone TEXT,
  raw_callback_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON public.payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_checkout_req ON public.payments(checkout_request_id);

-- 10. Webhook Events Table (Idempotent processing)
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT UNIQUE NOT NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_event_id ON public.webhook_events(event_id);

-- 11. Audit Logs Table
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_action ON public.audit_logs(user_id, action);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Helper to check if current authenticated user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Profiles Policies
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id OR public.is_admin());

CREATE POLICY "Users can update own display name"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id AND role = (SELECT role FROM public.profiles WHERE id = auth.uid()));

-- WhatsApp Accounts Policies
CREATE POLICY "Users can manage own WhatsApp accounts"
  ON public.whatsapp_accounts FOR ALL
  USING (auth.uid() = user_id OR public.is_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin());

-- Feature Catalog & Prices (Public read for active items, admin write)
CREATE POLICY "Everyone can read active feature catalog"
  ON public.feature_catalog FOR SELECT
  USING (is_active = TRUE OR public.is_admin());

CREATE POLICY "Admin manage feature catalog"
  ON public.feature_catalog FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Everyone can read active prices"
  ON public.feature_prices FOR SELECT
  USING (is_active = TRUE OR public.is_admin());

CREATE POLICY "Admin manage prices"
  ON public.feature_prices FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Feature Settings & Rules
CREATE POLICY "Users can manage feature settings for own accounts"
  ON public.feature_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = feature_settings.whatsapp_account_id AND user_id = auth.uid()
    ) OR public.is_admin()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = feature_settings.whatsapp_account_id AND user_id = auth.uid()
    ) OR public.is_admin()
  );

CREATE POLICY "Users can manage rules for own accounts"
  ON public.keyword_rules FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = keyword_rules.whatsapp_account_id AND user_id = auth.uid()
    ) OR public.is_admin()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = keyword_rules.whatsapp_account_id AND user_id = auth.uid()
    ) OR public.is_admin()
  );

-- Subscriptions, Orders, Payments (Read-only for customers; modified via secure backend server)
CREATE POLICY "Users can view own subscriptions"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin());

CREATE POLICY "Users can view own orders"
  ON public.orders FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin());

CREATE POLICY "Users can view own payments"
  ON public.payments FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin());

-- Webhooks & Audit Logs (Admin only)
CREATE POLICY "Admin view webhook events"
  ON public.webhook_events FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admin view audit logs"
  ON public.audit_logs FOR SELECT
  USING (public.is_admin());
