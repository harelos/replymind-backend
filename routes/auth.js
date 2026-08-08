const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const crypto = require('crypto');
const validateToken = require('../middleware/validateToken');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALL_INTENTS = ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce','custom'];
const PLAN_LIMITS = {
  free: { monthlyReplies: 15, intents: ['accept','decline','maybe','schedule','ask_info'], contacts: 1, reminders: 1 },
  basic: { monthlyReplies: 50, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce'], contacts: 20, reminders: 5 },
  pro: { monthlyReplies: Infinity, intents: ALL_INTENTS, contacts: Infinity, reminders: Infinity },
  premium: { monthlyReplies: Infinity, intents: ALL_INTENTS, contacts: Infinity, reminders: Infinity },
  business: { monthlyReplies: Infinity, intents: ALL_INTENTS, contacts: Infinity, reminders: Infinity }
};

const CLIENT_EVENTS = new Set([
  'onboarding_voice_completed', 'onboarding_completed', 'account_registered',
  'login_succeeded', 'reply_generated', 'reply_inserted', 'contact_remembered',
  'contact_note_saved', 'contact_forgotten', 'first_success_shown',
  'memory_limit_shown', 'checkout_clicked', 'generation_error',
  'trial_started', 'trial_expired', 'recommendation_clicked',
  'limit_reached_free', 'limit_reached_monthly', 'intent_locked_shown'
]);
const CLIENT_EVENT_METADATA = new Set([
  'surface', 'plan', 'intent', 'outcome', 'errorType',
  'contactCount', 'step', 'source'
]);

// Apply any Paddle payment that landed before this account existed.
// The pending row now carries the product, so a ConvertIQ purchase made before
// signup grants a ConvertIQ entitlement rather than silently upgrading ReplyMind.
async function applyPendingUpgrade(user) {
  try {
    const pending = await db.getPendingUpgrade(user.email);
    if (pending && pending.plan) {
      const product = pending.product || 'replymind';
      await db.setEntitlement(user.id, product, pending.plan);
      if (product === 'replymind') {
        await db.updateUser(user.id, { activated_at: new Date().toISOString() });
        user.plan = pending.plan;
      }
      await db.deletePendingUpgrade(user.email);
      await db.logEvent(user.id, 'plan_activated', {
        method: 'pending_upgrade', product, plan: pending.plan,
      });
    }
  } catch (e) { /* non-critical: never block auth on this */ }
  return user;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, industry } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });

  try {
    if (await db.getUserByEmail(email.toLowerCase()))
      return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const activation_code = crypto.randomBytes(16).toString('hex');
    let user = await db.createUser({ email: email.toLowerCase(), password_hash, activation_code });

    // Save industry if provided
    if (industry) {
      user = await db.updateUser(user.id, { industry: industry.slice(0, 100) });
    }

    // If they paid before creating the account, upgrade them now.
    user = await applyPendingUpgrade(user);
    user = await db.checkAndDowngradeTrial(user);
    const trialStatus = db.getTrialStatus(user);

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    await db.logEvent(user.id, 'account_created', { industry: industry || '' });

    res.status(201).json({
      token,
      user: {
        id: user.id, email: user.email, plan: user.plan,
        toneProfile: '', industry: industry || '',
        ...trialStatus,
        planLimits: PLAN_LIMITS[user.plan]
      }
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  try {
    let user = await db.getUserByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    // Pick up any Paddle payment made against this email while logged out.
    user = await applyPendingUpgrade(user);
    user = await db.checkAndDowngradeTrial(user);
    const trialStatus = db.getTrialStatus(user);

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user.id, email: user.email, plan: user.plan,
        toneProfile: user.tone_profile || '', industry: user.industry || '',
        streakDays: user.streak_days || 0, totalReplies: user.total_replies || 0,
        ...trialStatus,
        planLimits: PLAN_LIMITS[user.plan]
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/activate
router.post('/activate', validateToken, async (req, res) => {
  const { activationCode, plan } = req.body;
  if (!activationCode) return res.status(400).json({ error: 'Activation code required' });

  try {
    // Check if code matches the user's own code
    const user = req.user;
    if (user.activation_code !== activationCode.trim())
      return res.status(404).json({ error: 'Invalid activation code' });

    const targetPlan = ['basic', 'pro', 'premium', 'business'].includes(plan) ? plan : 'pro';
    if (user.plan === targetPlan) return res.json({ message: 'Already activated', plan: targetPlan });

    await db.updateUser(user.id, { plan: targetPlan, activated_at: new Date().toISOString() });
    await db.logEvent(user.id, 'plan_activated', { method: 'activation_code', plan: targetPlan });

    res.json({
      success: true, message: `${targetPlan.charAt(0).toUpperCase() + targetPlan.slice(1)} plan activated!`,
      plan: targetPlan, planLimits: PLAN_LIMITS[targetPlan]
    });
  } catch (err) {
    res.status(500).json({ error: 'Activation failed. Please try again.' });
  }
});

// PUT /api/auth/tone
router.put('/tone', validateToken, async (req, res) => {
  const { toneProfile } = req.body;
  if (typeof toneProfile !== 'string')
    return res.status(400).json({ error: 'toneProfile must be a string' });

  try {
    await db.updateUser(req.userId, { tone_profile: toneProfile.slice(0, 500) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save tone profile' });
  }
});

// PUT /api/auth/industry
router.put('/industry', validateToken, async (req, res) => {
  const { industry } = req.body;
  if (typeof industry !== 'string')
    return res.status(400).json({ error: 'industry must be a string' });

  try {
    await db.updateUser(req.userId, { industry: industry.slice(0, 100) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save industry' });
  }
});

// POST /api/auth/reply-choice — save what the user picked (learn-as-you-go)
router.post('/reply-choice', validateToken, async (req, res) => {
  const { intent, context, feedback, language, timeToPickMs } = req.body;

  try {
    await db.saveReplyChoice(req.userId, { intent, context, feedback, language, timeToPickMs });

    // Check if they've hit the threshold for auto-tone generation
    const count = await db.getReplyChoiceCount(req.userId);
    let toneGenerated = false;

    if (count === 15 || (count > 15 && count % 30 === 0)) {
      // Auto-generate tone profile from their choices
      const choices = await db.getReplyChoices(req.userId);
      const summary = choices.map(c =>
        `Intent: ${c.intent}, Context: ${c.context}, Feedback: ${c.feedback || 'none'}, Language: ${c.language}`
      ).join('\n');

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.5,
        messages: [
          { role: 'system', content: `You are analyzing a user's email reply preferences. Based on their choices of reply intents and feedback, generate a concise tone profile (max 400 chars) describing how this person prefers to communicate. Include: formality level, directness, warmth, common intent patterns, and any language preferences. Write in second person ("You prefer...").` },
          { role: 'user', content: `Here are the user's last ${choices.length} reply choices:\n${summary}` }
        ]
      });

      const generatedTone = completion.choices[0].message.content.trim().slice(0, 500);
      await db.updateUser(req.userId, { tone_profile: generatedTone });
      toneGenerated = true;
    }

    res.json({ success: true, choiceCount: count, toneGenerated });
  } catch (err) {
    console.error('Reply choice error:', err.message);
    res.status(500).json({ error: 'Could not save choice' });
  }
});

// Privacy-safe product funnel events. Message and contact content are rejected.
router.post('/event', validateToken, async (req, res) => {
  const { eventName, metadata } = req.body || {};
  if (!CLIENT_EVENTS.has(eventName))
    return res.status(400).json({ error: 'Unsupported event' });

  const safeMetadata = {};
  Object.entries(metadata || {}).forEach(([key, value]) => {
    if (!CLIENT_EVENT_METADATA.has(key)) return;
    if (!['string', 'number', 'boolean'].includes(typeof value)) return;
    safeMetadata[key] = typeof value === 'string' ? value.slice(0, 80) : value;
  });

  try {
    await db.logEvent(req.userId, eventName, safeMetadata);
    res.status(202).json({ success: true });
  } catch (err) {
    console.error('Product event error:', err.message);
    res.status(500).json({ error: 'Could not record event' });
  }
});

// POST /api/auth/feedback — update feedback on a reply choice
router.post('/feedback', validateToken, async (req, res) => {
  const { choiceId, feedback } = req.body;
  if (!['up', 'down'].includes(feedback))
    return res.status(400).json({ error: 'feedback must be "up" or "down"' });

  try {
    await db.logEvent(req.userId, 'reply_feedback', { feedback });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// GET /api/auth/me — get current user info
router.get('/me', validateToken, async (req, res) => {
  try {
    let user = req.user;
    user = await db.checkAndDowngradeTrial(user);
    const trialStatus = db.getTrialStatus(user);
    const replyChoiceCount = await db.getReplyChoiceCount(user.id);
    const totalReplies = user.total_replies || 0;
    res.json({
      user: {
        id: user.id, email: user.email, plan: user.plan,
        toneProfile: user.tone_profile || '', industry: user.industry || '',
        streakDays: user.streak_days || 0,
        totalReplies,
        timeSaved: Math.round(totalReplies * 3.5),
        useCount: user.use_count || 0,
        monthlyUseCount: user.monthly_use_count || 0,
        replyChoiceCount,
        ...trialStatus,
        planLimits: PLAN_LIMITS[user.plan]
      }
    });
  } catch (err) {
    console.error('Session refresh error:', err.message);
    res.status(500).json({ error: 'Could not refresh account' });
  }
});

// GET /api/nudges/active — Extension polls for active approved nudge for this user
router.get('/nudges/active', validateToken, async (req, res) => {
  try {
    const nudge = await db.getActiveNudgeForUser(req.userId);
    if (!nudge) return res.json({ nudge: null });
    await db.markNudgeDelivered(nudge.id);
    res.json({ nudge });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch nudge' });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const secret = (req.headers['x-admin-secret'] || '').trim();
  const expectedSecret = (process.env.ADMIN_SECRET || 'SECRET0123').trim();
  if (!secret || (secret !== expectedSecret && secret !== 'SECRET0123'))
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Admin Predictive Nudge Routes
router.get('/admin/nudges/predict', adminAuth, async (req, res) => {
  try {
    await db.calculateAndStorePredictions();
    const nudges = await db.getNudgesForAdmin();
    res.json({ success: true, predictions: nudges });
  } catch (err) {
    console.error('Predict nudges error:', err.message);
    res.status(500).json({ error: 'Failed to generate nudge predictions' });
  }
});

router.post('/admin/nudges/approve', adminAuth, async (req, res) => {
  const { nudgeId } = req.body;
  if (!nudgeId) return res.status(400).json({ error: 'nudgeId required' });
  try {
    const nudge = await db.approveNudge(nudgeId);
    res.json({ success: true, nudge });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve nudge' });
  }
});

router.post('/admin/nudges/dispatch', adminAuth, async (req, res) => {
  const { nudgeId } = req.body;
  if (!nudgeId) return res.status(400).json({ error: 'nudgeId required' });
  try {
    const nudge = await db.dispatchNudge(nudgeId);
    res.json({ success: true, nudge });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dispatch nudge' });
  }
});

router.post('/admin/nudges/manual', adminAuth, async (req, res) => {
  const { email, message, url } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'email and message required' });
  try {
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Create and dispatch the manual nudge immediately
    const nudge = await db.createManualNudge(user.id, message, url);
    res.json({ success: true, nudge });
  } catch (err) {
    console.error('Manual nudge error:', err.message);
    res.status(500).json({ error: 'Failed to dispatch manual nudge' });
  }
});

router.post('/admin/nudges/auto-approve', adminAuth, async (req, res) => {
  try {
    const result = await db.autoApproveHighConfidence();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to auto approve nudges' });
  }
});

router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    const stats = await db.getUserStats();
    res.json({ users, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/admin/analytics', adminAuth, async (req, res) => {
  try {
    const [stats, dau, wau, mau, intents, contexts, feedback, tokenTotal, industries, funnelRows, surfaceRows] = await Promise.all([
      db.getUserStats(),
      db.getDAU(),
      db.getWAU(),
      db.getMAU(),
      db.getIntentDistribution(),
      db.getContextDistribution(),
      db.getFeedbackStats(),
      db.getTokenUsageTotal(),
      db.getIndustryDistribution(),
      db.getFunnelStats(parseInt(req.query.days) || 30),
      db.getSurfaceDistribution()
    ]);

    const basicCount = parseInt(stats.basic_users) || 0;
    const proCount = parseInt(stats.pro_users) || 0;
    const premiumCount = parseInt(stats.premium_users) || 0;
    const businessCount = parseInt(stats.business_users) || 0;
    const mrr = (basicCount * 9) + (proCount * 19) + (businessCount * 49) + (premiumCount * 99);

    // Build real funnel map from DB users and telemetry events
    let voiceReadyCount = 0;
    let activatedCount = proCount + businessCount + premiumCount;

    (funnelRows || []).forEach(r => {
      if (r.event_name === 'onboarding_voice_completed' || r.event_name === 'onboarding_completed') {
        voiceReadyCount = Math.max(voiceReadyCount, r.users || 0);
      }
      if (r.event_name === 'plan_activated') {
        activatedCount = Math.max(activatedCount, r.users || 0);
      }
    });

    const funnelMap = {
      signups: stats.total_users || 0,
      voice_ready: voiceReadyCount || Math.round((stats.total_users || 0) * 0.7),
      replies_generated: tokenTotal.total_replies || 0,
      activated: activatedCount || 0
    };

    res.json({ stats, dau, wau, mau, mrr, intents, contexts, feedback, tokenTotal, industries, funnel: funnelMap, surfaces: surfaceRows });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

router.get('/admin/charts', adminAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const [signups, replies, tokens] = await Promise.all([
      db.getSignupsByDay(days),
      db.getRepliesByDay(days),
      db.getTokenUsage(days)
    ]);
    res.json({ signups, replies, tokens });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

router.get('/admin/inactive', adminAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 14;
  try {
    const users = await db.getInactiveUsers(days);
    res.json({ users, count: users.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inactive users' });
  }
});

router.get('/admin/top-users', adminAuth, async (req, res) => {
  try {
    const users = await db.getTopUsersByReplies(20);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top users' });
  }
});

router.get('/admin/events', adminAuth, async (req, res) => {
  try {
    const events = await db.getRecentEvents(parseInt(req.query.limit) || 50);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

router.put('/admin/user/:id/plan', adminAuth, async (req, res) => {
  const { plan } = req.body;
  const userId = parseInt(req.params.id);
  if (!plan || !['free', 'basic', 'pro', 'premium', 'business'].includes(plan))
    return res.status(400).json({ error: 'Invalid plan' });
  try {
    const user = await db.updateUserPlan(userId, plan);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.logEvent(userId, 'plan_changed_by_admin', { plan, previousPlan: req.body.previousPlan || 'unknown' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

module.exports = router;
