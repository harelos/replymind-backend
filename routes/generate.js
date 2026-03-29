const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const db = require('../db/database');
const validateToken = require('../middleware/validateToken');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PLAN_LIMITS = {
  free: { monthlyReplies: 10, intents: ['accept','decline','maybe','schedule','ask_info'] },
  basic: { monthlyReplies: 50, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce'] },
  pro: { monthlyReplies: Infinity, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce','custom'] },
  premium: { monthlyReplies: Infinity, intents: ['accept','decline','maybe','schedule','delegate','ask_info','check_in','negotiate','thank_you','apologize','introduce','custom'] }
};

const INTENT_PROMPTS = {
  accept: 'Write a positive, confirming reply that agrees to or accepts what was proposed in the message.',
  decline: 'Write a polite, professional rejection/decline. Be kind but clear. Offer a brief reason if appropriate.',
  maybe: 'Write a reply that expresses interest but asks for time to consider. Don\'t commit but don\'t close the door.',
  schedule: 'Write a reply that proposes scheduling a meeting or call. Suggest 2-3 potential time slots or ask for their availability.',
  delegate: 'Write a reply that redirects to another person. Use "[Name/Role]" as a placeholder for the person to forward to. Explain why you\'re connecting them.',
  ask_info: 'Write a reply that asks for more information or clarification before making a decision. Be specific about what you need.',
  check_in: 'Write a friendly follow-up/check-in reply. Reference the previous conversation naturally and ask for an update without being pushy.',
  negotiate: 'Write a reply that proposes adjusted terms, pricing, or conditions. Be professional and collaborative, not adversarial. Acknowledge the original offer and present a counter.',
  thank_you: 'Write a warm, genuine thank-you reply. Reference specifically what you are grateful for. Keep it personal and sincere, not generic.',
  apologize: 'Write a professional apology that takes ownership. Acknowledge the issue, express regret, and offer a concrete next step to make it right.',
  introduce: 'Write a reply that introduces or connects two parties. Explain briefly why the connection is valuable for both sides. Use "[Name]" as placeholder if needed.',
  custom: '' // Will be filled from user\'s custom prompt
};

const INTENT_LABELS = {
  accept: '✅ Accept', decline: '❌ Decline', maybe: '🤔 Maybe',
  schedule: '📅 Schedule', delegate: '➡️ Delegate', ask_info: '❓ More Info',
  check_in: '🔄 Check In', negotiate: '💰 Negotiate', thank_you: '🙏 Thank You',
  apologize: '😔 Apologize', introduce: '🤝 Introduce', custom: '✍️ Custom'
};

function detectContext(text) {
  const t = text.toLowerCase();
  if (/pricing|price|cost|quote|proposal|demo|interested in|tell me more|how much/.test(t)) return 'sales_inquiry';
  if (/unhappy|disappointed|refund|cancel|complaint|wrong|broken|issue|problem|frustrated/.test(t)) return 'complaint';
  if (/partner|supplier|vendor|wholesale|bulk|distribute|collaborate|opportunity/.test(t)) return 'vendor_outreach';
  if (/following up|just checking|circling back|any update|heard back|last email/.test(t)) return 'lead_followup';
  return 'general';
}

function contextLabel(context) {
  return {
    sales_inquiry: '📩 Sales Inquiry',
    complaint: '⚠️ Complaint',
    vendor_outreach: '🤝 Vendor Outreach',
    lead_followup: '🔄 Follow-up',
    general: '💬 General'
  }[context] || '💬 General';
}

router.post('/', validateToken, async (req, res) => {
  const { messageText, toneProfile, intent, customPrompt, replyLength = 'medium', context = 'auto' } = req.body;

  if (!messageText || typeof messageText !== 'string' || messageText.trim().length < 5)
    return res.status(400).json({ error: 'Message text is required', code: 'NO_MESSAGE' });

  if (!intent || !INTENT_PROMPTS.hasOwnProperty(intent))
    return res.status(400).json({ error: 'Valid intent is required', code: 'NO_INTENT' });

  const user = req.user;
  const plan = user.plan || 'free';
  const limits = PLAN_LIMITS[plan];

  // Check plan allows this intent
  if (!limits.intents.includes(intent))
    return res.status(403).json({ error: `${INTENT_LABELS[intent]} is not available on your plan`, code: 'INTENT_LOCKED', upgrade: true });

  // Check usage limits
  if (plan === 'free' && user.use_count >= limits.monthlyReplies) {
    return res.status(403).json({
      error: 'Free replies used up',
      code: 'FREE_LIMIT_REACHED',
      usesRemaining: 0,
      upgradeUrl: 'https://harelos.github.io/replymind'
    });
  }
  if (plan === 'basic' && user.monthly_use_count >= limits.monthlyReplies) {
    return res.status(403).json({
      error: 'Monthly limit reached. Upgrade for unlimited replies.',
      code: 'MONTHLY_LIMIT_REACHED',
      usesRemaining: 0,
      upgradeUrl: 'https://harelos.github.io/replymind'
    });
  }

  // CHROME POLICY: never log messageText
  await db.logEvent(user.id, 'reply_generated', { intent, replyLength, plan, context });

  const detectedContext = context === 'auto' ? detectContext(messageText) : context;
  const lengthGuide = { short: '30-60 words', medium: '60-100 words', detailed: '100-150 words' }[replyLength] || '60-100 words';

  const hasToneProfile = toneProfile && toneProfile.trim().length > 0;
  const toneInstruction = hasToneProfile
    ? `The sender's personal communication style: "${toneProfile.trim()}". Match this tone very carefully.`
    : 'Use a professional, warm, and direct tone.';

  const intentInstruction = intent === 'custom' && customPrompt
    ? customPrompt.slice(0, 200)
    : INTENT_PROMPTS[intent];

  const systemPrompt = `You are an expert business communication assistant.
${toneInstruction}

INTENT: ${intentInstruction}

IMPORTANT RULES:
1. Reply in the SAME LANGUAGE as the original message. If the message is in Hebrew, reply in Hebrew. If in Spanish, reply in Spanish. Match the language exactly.
2. The reply should be ${lengthGuide}.
3. Message context: ${detectedContext}.
4. Write exactly ONE reply that fits the intent perfectly.
5. Do NOT include a subject line or email headers.

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:
{"text":"...","wordCount":N,"intent":"${intent}","language":"detected_language_code"}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Reply to this message:\n\n${messageText.trim().slice(0, 2000)}` }
      ]
    });

    let reply;
    try {
      const raw = completion.choices[0].message.content.trim();
      reply = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (typeof reply.text !== 'string') throw new Error('Invalid reply format');
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.', code: 'PARSE_ERROR' });
    }

    // Increment usage
    await db.incrementUseCount(user.id);

    // Update streak
    const streak = await db.updateStreak(user.id);

    const updatedUser = await db.getUserById(user.id);
    const usesRemaining = plan === 'free'
      ? Math.max(0, limits.monthlyReplies - (updatedUser?.use_count || 0))
      : plan === 'basic'
        ? Math.max(0, limits.monthlyReplies - (updatedUser?.monthly_use_count || 0))
        : null;

    const timeSaved = (updatedUser?.total_replies || 1) * 3.5; // 3.5 min saved per reply

    res.json({
      reply,
      detectedContext,
      contextLabel: contextLabel(detectedContext),
      usesRemaining,
      plan,
      hasToneProfile,
      streak: streak || 0,
      totalReplies: updatedUser?.total_replies || 0,
      timeSaved: Math.round(timeSaved),
      intentLabel: INTENT_LABELS[intent],
      planLimits: limits
    });

  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('timeout'))
      return res.status(504).json({ error: 'AI is taking too long. Please try again.', code: 'TIMEOUT' });
    console.error('Generate error:', err.message);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;