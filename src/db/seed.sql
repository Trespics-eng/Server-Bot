-- ============================================================================
-- SEED DATA: FEATURE CATALOG & PRICING
-- Includes individual features and All-In-One Full Bundle (Weekly & Monthly)
-- ============================================================================

-- 1. Insert Feature Catalog
INSERT INTO public.feature_catalog (code, name, description, category, is_bundle, is_active)
VALUES
  (
    'bundle_all',
    '⭐ All-In-One Full Pass',
    'Full access to all bot capabilities: Anti-Delete, Auto-Reply, Anti-ViewOnce, and File Organizer bundled together at a discounted rate.',
    'bundle',
    TRUE,
    TRUE
  ),
  (
    'anti_delete',
    'Anti-Delete Message Recovery',
    'Retain and recover deleted text messages and media across private chats and groups.',
    'security',
    FALSE,
    TRUE
  ),
  (
    'auto_reply',
    'Smart Auto-Reply & Keyword Rules',
    'Automated instant responses, keyword-matching rules, greeting messages, and away status.',
    'automation',
    FALSE,
    TRUE
  ),
  (
    'anti_view_once',
    'Anti-ViewOnce Media Capture',
    'Safely capture and inspect permitted ephemeral view-once photos and videos on demand.',
    'privacy',
    FALSE,
    TRUE
  ),
  (
    'file_organizer',
    'Automatic File Organizer',
    'Intelligently categorize and archive incoming documents, images, audio, and videos.',
    'storage',
    FALSE,
    TRUE
  )
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_bundle = EXCLUDED.is_bundle,
  is_active = EXCLUDED.is_active;

-- 2. Insert Pricing Plans (amounts in minor units / KES)
-- All-In-One Full Pass
INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'weekly', 7, 35, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'bundle_all'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'monthly', 30, 120, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'bundle_all'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

-- Anti-Delete (KES 10 weekly, KES 40 monthly)
INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'weekly', 7, 10, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'anti_delete'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'monthly', 30, 40, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'anti_delete'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

-- Auto-Reply (KES 15 weekly, KES 50 monthly)
INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'weekly', 7, 15, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'auto_reply'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'monthly', 30, 50, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'auto_reply'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

-- Anti-ViewOnce (KES 15 weekly, KES 50 monthly)
INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'weekly', 7, 15, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'anti_view_once'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'monthly', 30, 50, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'anti_view_once'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

-- File Organizer (KES 10 weekly, KES 40 monthly)
INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'weekly', 7, 10, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'file_organizer'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;

INSERT INTO public.feature_prices (feature_id, period, duration_days, amount_minor, currency, is_active)
SELECT id, 'monthly', 30, 40, 'KES', TRUE
FROM public.feature_catalog WHERE code = 'file_organizer'
ON CONFLICT (feature_id, period) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;
