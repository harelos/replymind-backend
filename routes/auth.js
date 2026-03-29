const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const crypto = require('crypto');
const validateToken = require('../middleware/validateToken');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PLAN_LIMITS = {
  free: { monthlyReplies: 10, intents: ['accept','decline','maybe','schedule','ask_info'], contacts: 3, reminders: 1 },
  basic: { monthlyReplies: 50, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce'], contacts: 20, reminders: 5 },
  pro: { monthlyReplies: Infinity, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce','custom'], contacts: Infinity, reminders: Infinity },
  premium: { monthlyReplies: Infinity, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce','custom'], contacts: Infinity, reminders: Infinity }
};

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
    const user = await db.createUser({ email: email.toLowerCase(), password_hash, activation_code });

    // Save industry if provided
    if (industry) {
      await db.updateUser(user.id, { industry: industry.slice(0, 100) });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    await db.logEvent(user.id, 'account_created', { email: user.email, industry: industry || '' });

    res.status(201).json({
      token,
      user: {
        id: user.id, email: user.email, plan: user.plan,
        toneProfile: '', industry: industry || '',
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
    const user = await db.getUserByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user.id, email: user.email, plan: user.plan,
        toneProfile: user.tone_profile || '', industry: user.industry || '',
        streakDays: user.streak_days || 0, totalReplies: user.total_replies || 0,
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

    const targetPlan = ['basic', 'pro', 'premium'].includes(plan) ? plan : 'pro';
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
  const user = req.user;
  const streak = await db.updateStreak(user.id);
  res.json({
    user: {
      id: user.id, email: user.email, plan: user.plan,
      toneProfile: user.tone_profile || '', industry: user.industry || '',
      streakDays: streak || user.streak_days || 0,
      totalReplies: user.total_replies || 0,
      monthlyUseCount: user.monthly_use_count || 0,
      planLimits: PLAN_LIMITS[user.plan]
    }
  });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.get('/admin/users', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  try {
    const users = await db.getAllUsers();
    const stats = await db.getUserStats();
    res.json({ users, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
