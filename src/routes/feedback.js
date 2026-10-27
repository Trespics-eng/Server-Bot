import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

// In-memory fallback cache for feedbacks/complaints
const fallbackFeedbacks = [
  {
    id: 'fc-demo-1',
    user_id: '00000000-0000-0000-0000-000000000002',
    user_email: 'customer@business.com',
    type: 'complaint',
    category: 'auto_reply',
    subject: 'Auto reply triggered too frequently in group chat',
    message: 'Hello, when I added the bot to my business group, auto replies were replying to every member message without a cooldown. Can this be rate limited?',
    status: 'in_progress',
    admin_response: 'Investigating the per-sender cooldown setting in your group rules. Fix incoming.',
    resolved_at: null,
    created_at: new Date(Date.now() - 3600 * 1000 * 8).toISOString(),
    updated_at: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
  },
  {
    id: 'fc-demo-2',
    user_id: '00000000-0000-0000-0000-000000000002',
    user_email: 'customer@business.com',
    type: 'feedback',
    category: 'general',
    subject: 'Loving the custom auto reply feature!',
    message: 'Being able to customize my own auto reply texts and rules directly from the dashboard is incredible. Would love to see CSV rule import next!',
    status: 'resolved',
    admin_response: 'Thank you for the wonderful feedback! CSV rule importing is scheduled for our next release.',
    resolved_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
    created_at: new Date(Date.now() - 3600 * 1000 * 48).toISOString(),
    updated_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
  },
];

const feedbackSchema = z.object({
  type: z.enum(['feedback', 'complaint']),
  subject: z.string().min(2).max(150),
  message: z.string().min(5).max(3000),
  category: z.string().default('general'),
});

/**
 * POST /api/feedback
 * Submit a feedback or complaint
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }

    const newRecord = {
      id: crypto.randomUUID(),
      user_id: req.user.id,
      user_email: req.user.email,
      type: parsed.data.type,
      category: parsed.data.category,
      subject: parsed.data.subject,
      message: parsed.data.message,
      status: 'pending',
      admin_response: null,
      resolved_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Store in fallback store
    fallbackFeedbacks.unshift(newRecord);

    // Try saving to Supabase table
    try {
      await supabaseAdmin.from('feedbacks_complaints').insert({
        id: newRecord.id,
        user_id: req.user.id,
        user_email: req.user.email,
        type: newRecord.type,
        category: newRecord.category,
        subject: newRecord.subject,
        message: newRecord.message,
        status: newRecord.status,
      });
    } catch (dbErr) {
      logger.debug({ err: dbErr.message }, 'Supabase insert fallback to in-memory store');
    }

    logger.info({ id: newRecord.id, user: req.user.email, type: newRecord.type }, 'Feedback/complaint submitted');
    res.status(201).json({ success: true, feedback: newRecord });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to submit feedback');
    res.status(500).json({ success: false, error: 'Failed to submit feedback' });
  }
});

/**
 * GET /api/feedback/my
 * User retrieves their own submissions
 */
router.get('/my', requireAuth, async (req, res) => {
  try {
    // Attempt database query
    let items = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('feedbacks_complaints')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false });

      if (!error && data && data.length > 0) {
        items = data;
      }
    } catch {}

    if (items.length === 0) {
      items = fallbackFeedbacks.filter((f) => f.user_id === req.user.id);
    }

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load feedbacks' });
  }
});

/**
 * GET /api/feedback/all (or /api/admin/feedbacks)
 * Admin loads all feedbacks and complaints
 */
router.get('/all', requireAuth, requireAdmin, async (req, res) => {
  try {
    let items = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('feedbacks_complaints')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data && data.length > 0) {
        items = data;
      }
    } catch {}

    if (items.length === 0) {
      items = [...fallbackFeedbacks];
    }

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve feedbacks' });
  }
});

/**
 * PATCH /api/feedback/:id
 * Admin updates status and adds response
 */
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, adminResponse } = req.body;

  try {
    const updatePayload = {
      updated_at: new Date().toISOString(),
    };
    if (status) updatePayload.status = status;
    if (adminResponse !== undefined) updatePayload.admin_response = adminResponse;
    if (status === 'resolved') updatePayload.resolved_at = new Date().toISOString();

    // Update in-memory fallback
    const target = fallbackFeedbacks.find((f) => f.id === id);
    if (target) {
      if (status) target.status = status;
      if (adminResponse !== undefined) target.admin_response = adminResponse;
      if (status === 'resolved') target.resolved_at = new Date().toISOString();
      target.updated_at = new Date().toISOString();
    }

    // Try Supabase update
    try {
      await supabaseAdmin
        .from('feedbacks_complaints')
        .update(updatePayload)
        .eq('id', id);
    } catch {}

    res.json({ success: true, feedback: target || updatePayload });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update feedback status' });
  }
});

export default router;
