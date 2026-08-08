// PostgreSQL database layer — persistent storage on Railway
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set');
  process.exit(1);
}

// Railway internal Postgres doesn't need SSL; external does
const isInternal = process.env.DATABASE_URL.includes('.railway.internal');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isInternal ? false : { rejectUnauthorized: false }
});

// ─── Schema initialization ───────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        plan VARCHAR(20) DEFAULT 'free',
        use_count INTEGER DEFAULT 0,
        monthly_use_count INTEGER DEFAULT 0,
        monthly_reset_date TIMESTAMPTZ DEFAULT NOW(),
        tone_profile TEXT DEFAULT '',
        industry VARCHAR(100) DEFAULT '',
        streak_days INTEGER DEFAULT 0,
        last_active_date DATE,
        total_replies INTEGER DEFAULT 0,
        trial_started_at TIMESTAMPTZ,
        trial_ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        activation_code VARCHAR(64)
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        event_name VARCHAR(100) NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS nudges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        segment VARCHAR(50) NOT NULL,
        risk_score INTEGER DEFAULT 0,
        status_label VARCHAR(100) NOT NULL,
        campaign_name VARCHAR(150) NOT NULL,
        trigger_channel VARCHAR(50) DEFAULT 'gmail_toast',
        ai_message TEXT NOT NULL,
        cta_label VARCHAR(100) DEFAULT 'Open ReplyMind',
        cta_action VARCHAR(100) DEFAULT 'open_replymind',
        confidence_score INTEGER DEFAULT 0,
        approved_by_admin BOOLEAN DEFAULT FALSE,
        dispatched_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_user_segment UNIQUE(user_id, segment)
      );

      CREATE TABLE IF NOT EXISTS reply_choices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        intent VARCHAR(50),
        context VARCHAR(50),
        feedback VARCHAR(10),
        language VARCHAR(10) DEFAULT 'en',
        time_to_pick_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Paid before the account existed: applied on next register/login for this email.
      CREATE TABLE IF NOT EXISTS pending_upgrades (
        email VARCHAR(255) PRIMARY KEY,
        plan VARCHAR(20) NOT NULL,
        product VARCHAR(32) NOT NULL DEFAULT 'replymind',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tool_leads (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        source_url VARCHAR(500) NOT NULL,
        tool_slug VARCHAR(150) NOT NULL,
        language VARCHAR(10) DEFAULT 'en',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- One account, many products. users.plan stays as ReplyMind's plan for
      -- backwards compatibility; everything new reads from here so a user can be
      -- Pro on ReplyMind and free on ConvertIQ without the two fighting.
      CREATE TABLE IF NOT EXISTS entitlements (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product VARCHAR(32) NOT NULL,            -- 'replymind' | 'convertiq'
        plan    VARCHAR(20) NOT NULL DEFAULT 'free',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, product)
      );

      -- ConvertIQ audit usage (free tier = 3 audits/month)
      CREATE TABLE IF NOT EXISTS audits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        url TEXT,
        score INTEGER,
        monthly_leak INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Older deploys may predate the product column on pending_upgrades.
    await client.query(`
      ALTER TABLE pending_upgrades
        ADD COLUMN IF NOT EXISTS product VARCHAR(32) NOT NULL DEFAULT 'replymind';
    `);
    // Clean up any undelivered duplicates so each user has at most 1 active nudge
    await client.query(`
      DELETE FROM nudges
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rnum
          FROM nudges
          WHERE delivered_at IS NULL
        ) t
        WHERE t.rnum > 1
      );
    `);
    
    // Attempt to add the constraint if it was created before the constraint existed
    try {
      await client.query(`ALTER TABLE nudges ADD CONSTRAINT unique_user_segment UNIQUE (user_id, segment);`);
    } catch (e) {
      // Ignore error if constraint already exists
    }

    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// ─── User operations ─────────────────────────────────────────────────────────
const db = {
  async getUserByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  async getUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async getUserByActivationCode(code) {
    const { rows } = await pool.query('SELECT * FROM users WHERE activation_code = $1', [code]);
    return rows[0] || null;
  },

  // ─── Pending upgrades (paid before account existed) ──────────────────────────
  async setPendingUpgrade(email, plan, product = 'replymind') {
    await pool.query(
      `INSERT INTO pending_upgrades (email, plan, product, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email) DO UPDATE
         SET plan = EXCLUDED.plan, product = EXCLUDED.product, created_at = NOW()`,
      [email.toLowerCase(), plan, product]
    );
  },

  // Returns { plan, product } so the caller grants the entitlement on the right product.
  async getPendingUpgrade(email) {
    const { rows } = await pool.query(
      'SELECT plan, product FROM pending_upgrades WHERE email = $1',
      [email.toLowerCase()]
    );
    return rows[0] ? { plan: rows[0].plan, product: rows[0].product || 'replymind' } : null;
  },

  async deletePendingUpgrade(email) {
    await pool.query('DELETE FROM pending_upgrades WHERE email = $1', [email.toLowerCase()]);
  },

  async createUser({ email, password_hash, activation_code }) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, activation_code, monthly_reset_date)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [email, password_hash, activation_code]
    );
    return rows[0];
  },

  async updateUser(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 2}`);
    const values = keys.map(k => fields[k]);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return rows[0] || null;
  },

  async incrementUseCount(id) {
    const { rows } = await pool.query(
      `UPDATE users SET use_count = use_count + 1, monthly_use_count = monthly_use_count + 1, total_replies = total_replies + 1 WHERE id = $1 RETURNING use_count`,
      [id]
    );
    return rows[0]?.use_count || 0;
  },

  async resetMonthlyIfNeeded(id) {
    const { rows } = await pool.query(
      `UPDATE users SET monthly_use_count = 0, monthly_reset_date = NOW()
       WHERE id = $1 AND monthly_reset_date < date_trunc('month', NOW())
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  async updateStreak(id) {
    const user = await db.getUserById(id);
    if (!user) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lastActive = user.last_active_date ? new Date(user.last_active_date).toISOString().slice(0, 10) : null;

    let newStreak = 1;
    if (lastActive === today) {
      return user.streak_days; // Already counted today
    } else if (lastActive === yesterday) {
      newStreak = (user.streak_days || 0) + 1;
    }
    await pool.query(
      'UPDATE users SET streak_days = $1, last_active_date = $2 WHERE id = $3',
      [newStreak, today, id]
    );
    return newStreak;
  },

  // ─── Events ──────────────────────────────────────────────────────────────────
  async logEvent(userId, eventName, metadata = {}) {
    try {
      await pool.query(
        'INSERT INTO events (user_id, event_name, metadata) VALUES ($1, $2, $3)',
        [userId || null, eventName, JSON.stringify(metadata)]
      );
    } catch (e) { /* non-critical */ }
  },

  // ─── Reply choices (learn-as-you-go) ─────────────────────────────────────────
  async saveReplyChoice(userId, { intent, context, feedback, language, timeToPickMs }) {
    await pool.query(
      `INSERT INTO reply_choices (user_id, intent, context, feedback, language, time_to_pick_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, intent, context, feedback || null, language || 'en', timeToPickMs || null]
    );
  },

  async getReplyChoices(userId) {
    const { rows } = await pool.query(
      'SELECT intent, context, feedback, language, time_to_pick_ms, created_at FROM reply_choices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [userId]
    );
    return rows;
  },

  async getReplyChoiceCount(userId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM reply_choices WHERE user_id = $1',
      [userId]
    );
    return parseInt(rows[0].count);
  },

  // ─── Admin ───────────────────────────────────────────────────────────────────
  async getAllUsers() {
    const { rows } = await pool.query(
      'SELECT id, email, plan, use_count, monthly_use_count, tone_profile, industry, streak_days, total_replies, created_at, activated_at FROM users ORDER BY created_at DESC'
    );
    return rows;
  },

  async getUserStats() {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE plan = 'free') as free_users,
        COUNT(*) FILTER (WHERE plan = 'basic') as basic_users,
        COUNT(*) FILTER (WHERE plan = 'pro') as pro_users,
        COUNT(*) FILTER (WHERE plan = 'premium') as premium_users,
        COUNT(*) FILTER (WHERE plan = 'business') as business_users,
        COALESCE(SUM(total_replies), 0) as total_replies
      FROM users
    `);
    return rows[0];
  },

  // ─── Admin analytics queries ─────────────────────────────────────────────────
  async getDAU() {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as dau FROM users WHERE last_active_date = CURRENT_DATE`
    );
    return parseInt(rows[0].dau);
  },

  async getWAU() {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as wau FROM users WHERE last_active_date >= CURRENT_DATE - INTERVAL '7 days'`
    );
    return parseInt(rows[0].wau);
  },

  async getMAU() {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as mau FROM users WHERE last_active_date >= CURRENT_DATE - INTERVAL '30 days'`
    );
    return parseInt(rows[0].mau);
  },

  async getSignupsByDay(days = 30) {
    const { rows } = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) as count
       FROM users WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(created_at) ORDER BY day`
    );
    return rows;
  },

  async getRepliesByDay(days = 30) {
    const { rows } = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) as count
       FROM events WHERE event_name = 'reply_generated'
       AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(created_at) ORDER BY day`
    );
    return rows;
  },

  async getIntentDistribution() {
    const { rows } = await pool.query(
      `SELECT intent, COUNT(*) as count FROM reply_choices
       GROUP BY intent ORDER BY count DESC`
    );
    return rows;
  },

  async getContextDistribution() {
    const { rows } = await pool.query(
      `SELECT context, COUNT(*) as count FROM reply_choices
       GROUP BY context ORDER BY count DESC`
    );
    return rows;
  },

  async getFeedbackStats() {
    const { rows } = await pool.query(
      `SELECT feedback, COUNT(*) as count FROM reply_choices
       WHERE feedback IS NOT NULL GROUP BY feedback`
    );
    return rows;
  },

  async getTokenUsage(days = 30) {
    const { rows } = await pool.query(
      `SELECT
         DATE(created_at) as day,
         SUM((metadata->>'prompt_tokens')::int) as prompt_tokens,
         SUM((metadata->>'completion_tokens')::int) as completion_tokens,
         SUM((metadata->>'total_tokens')::int) as total_tokens,
         COUNT(*) as requests
       FROM events
       WHERE event_name = 'token_usage'
       AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(created_at) ORDER BY day`
    );
    return rows;
  },

  async getTokenUsageTotal() {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM((metadata->>'total_tokens')::int), 0) as total_tokens,
         COALESCE(SUM((metadata->>'prompt_tokens')::int), 0) as prompt_tokens,
         COALESCE(SUM((metadata->>'completion_tokens')::int), 0) as completion_tokens,
         COUNT(*) as total_requests
       FROM events WHERE event_name = 'token_usage'`
    );
    return rows[0];
  },

  async getInactiveUsers(daysInactive = 14) {
    const { rows } = await pool.query(
      `SELECT id, email, plan, last_active_date, total_replies, created_at
       FROM users
       WHERE last_active_date IS NOT NULL
       AND last_active_date < CURRENT_DATE - INTERVAL '${parseInt(daysInactive)} days'
       ORDER BY last_active_date DESC`
    );
    return rows;
  },

  async getRecentEvents(limit = 50) {
    const { rows } = await pool.query(
      `SELECT e.id, e.event_name, e.metadata - 'email' AS metadata, e.created_at,
              CASE WHEN e.user_id IS NULL THEN 'system' ELSE 'signed-in user' END AS actor
       FROM events e
       ORDER BY e.created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(parseInt(limit) || 50, 200))]
    );
    return rows;
  },

  async getFunnelStats(days = 30) {
    const eventNames = [
      'account_created', 'onboarding_voice_completed', 'onboarding_completed', 'reply_generated',
      'reply_inserted', 'contact_remembered', 'memory_limit_shown',
      'checkout_clicked', 'plan_activated'
    ];
    const { rows } = await pool.query(
      `SELECT event_name, COUNT(*)::int AS events,
              COUNT(DISTINCT user_id)::int AS users
       FROM events
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND event_name = ANY($2::text[])
       GROUP BY event_name`,
      [Math.max(1, Math.min(parseInt(days) || 30, 365)), eventNames]
    );
    return rows;
  },

  // ─── Entitlements: one account, a plan per product ────────────────────────
  async getEntitlement(userId, product) {
    const { rows } = await pool.query(
      `SELECT plan FROM entitlements WHERE user_id = $1 AND product = $2`,
      [userId, product]
    );
    if (rows[0]) return rows[0].plan;
    // ReplyMind predates this table, so fall back to the legacy users.plan column.
    if (product === 'replymind') {
      const u = await pool.query(`SELECT plan FROM users WHERE id = $1`, [userId]);
      return u.rows[0]?.plan || 'free';
    }
    return 'free';
  },

  async setEntitlement(userId, product, plan) {
    await pool.query(
      `INSERT INTO entitlements (user_id, product, plan, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, product)
       DO UPDATE SET plan = EXCLUDED.plan, updated_at = NOW()`,
      [userId, product, plan]
    );
    // Keep the legacy column in step so nothing that still reads it breaks.
    if (product === 'replymind') {
      await pool.query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
    }
  },

  // ─── ConvertIQ audits ─────────────────────────────────────────────────────
  async countAuditsThisMonth(userId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audits
       WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
      [userId]
    );
    return rows[0].n;
  },

  async saveAudit(userId, url, score, monthlyLeak) {
    const { rows } = await pool.query(
      `INSERT INTO audits (user_id, url, score, monthly_leak)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [userId, url, score, monthlyLeak]
    );
    return rows[0];
  },

  async getAudits(userId, limit = 20) {
    const { rows } = await pool.query(
      `SELECT id, url, score, monthly_leak, created_at FROM audits
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, parseInt(limit)]
    );
    return rows;
  },

  async updateUserPlan(userId, plan) {
    const validPlans = ['free', 'basic', 'pro', 'premium', 'business'];
    if (!validPlans.includes(plan)) throw new Error('Invalid plan');
    const { rows } = await pool.query(
      `UPDATE users SET plan = $1, activated_at = NOW() WHERE id = $2 RETURNING *`,
      [plan, userId]
    );
    return rows[0] || null;
  },

  async getIndustryDistribution() {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(industry, ''), 'Not set') as industry, COUNT(*) as count
       FROM users GROUP BY COALESCE(NULLIF(industry, ''), 'Not set') ORDER BY count DESC`
    );
    return rows;
  },

  async getTopUsersByReplies(limit = 20) {
    const { rows } = await pool.query(
      `SELECT id, email, plan, total_replies, streak_days, industry, last_active_date, created_at
       FROM users ORDER BY total_replies DESC LIMIT $1`,
      [parseInt(limit)]
    );
    return rows;
  },

  async saveToolLead({ email, sourceUrl, toolSlug, language }) {
    const { rows } = await pool.query(
      `INSERT INTO tool_leads (email, source_url, tool_slug, language, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [email.toLowerCase().trim(), sourceUrl, toolSlug, language || 'en']
    );
    return rows[0];
  },

  async getToolLeadsStats() {
    const { rows } = await pool.query(
      `SELECT tool_slug, language, COUNT(*) as count
       FROM tool_leads
       GROUP BY tool_slug, language
       ORDER BY count DESC`
    );
    return rows;
  },

  // ─── Trial infrastructure ──────────────────────────────────────────────────
  getTrialStatus(user) {
    if (!user) return { isTrialActive: false, trialDaysLeft: 0, trialEndsAt: null, trialStartedAt: null };
    const trialEndsAt = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
    const trialStartedAt = user.trial_started_at ? new Date(user.trial_started_at) : null;
    const now = new Date();

    if (!trialEndsAt) {
      return { isTrialActive: false, trialDaysLeft: 0, trialEndsAt: null, trialStartedAt: user.trial_started_at || null };
    }

    const diffMs = trialEndsAt.getTime() - now.getTime();
    const trialDaysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const isTrialActive = user.plan === 'pro' && diffMs > 0;

    return {
      isTrialActive,
      trialDaysLeft,
      trialEndsAt: user.trial_ends_at,
      trialStartedAt: user.trial_started_at
    };
  },

  async checkAndDowngradeTrial(user) {
    if (!user || user.plan !== 'pro' || !user.trial_ends_at) return user;
    const now = new Date();
    const endsAt = new Date(user.trial_ends_at);
    if (endsAt <= now) {
      // Lazy expiry: trial ended and user has no active paid subscription
      const { rows } = await pool.query(
        `UPDATE users SET plan = 'free' WHERE id = $1 RETURNING *`,
        [user.id]
      );
      if (rows[0]) {
        await db.logEvent(user.id, 'trial_expired_downgraded', { plan: 'free' });
        return rows[0];
      }
    }
    return user;
  },

  async startTrial(userId, durationDays = 7) {
    const user = await db.getUserById(userId);
    if (!user) return null;
    // Write-once: set trial_started_at ONLY if it is currently NULL to prevent trial abuse
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `UPDATE users 
       SET plan = 'pro',
           trial_started_at = COALESCE(trial_started_at, NOW()),
           trial_ends_at = $1
       WHERE id = $2 RETURNING *`,
      [endsAt.toISOString(), userId]
    );
    if (rows[0]) {
      await db.logEvent(userId, 'trial_started', { durationDays });
    }
    return rows[0] || null;
  },

  async getUserByEmail(email) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    return rows[0] || null;
  },

  async createManualNudge(userId, message, ctaUrl) {
    const { rows } = await pool.query(
      `INSERT INTO nudges (user_id, segment, risk_score, status_label, campaign_name, trigger_channel, ai_message, cta_label, cta_action, confidence_score, approved_by_admin)
       VALUES ($1, 'MANUAL_NUDGE', 100, 'Manual Dispatch', 'Admin Manual Nudge', 'extension_popover', $2, 'Open Link', $3, 100, TRUE)
       RETURNING *`,
      [userId, message, ctaUrl || '']
    );
    return rows[0];
  },

  // ─── Predictive Nudges & Campaign Engine ─────────────────────────────────────
  async getNudgesForAdmin() {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (n.user_id) n.*, u.email as user_email
       FROM nudges n
       JOIN users u ON n.user_id = u.id
       WHERE n.delivered_at IS NULL
       ORDER BY n.user_id, n.created_at DESC`
    );
    // Sort by risk score descending for display
    rows.sort((a, b) => b.risk_score - a.risk_score);
    return rows;
  },

  async approveNudge(nudgeId) {
    const { rows } = await pool.query(
      `UPDATE nudges SET approved_by_admin = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [nudgeId]
    );
    return rows[0] || null;
  },

  async dispatchNudge(nudgeId) {
    const { rows } = await pool.query(
      `UPDATE nudges SET approved_by_admin = TRUE, dispatched_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [nudgeId]
    );
    return rows[0] || null;
  },

  async autoApproveHighConfidence() {
    const { rows } = await pool.query(
      `UPDATE nudges SET approved_by_admin = TRUE, updated_at = NOW()
       WHERE confidence_score >= 85 AND approved_by_admin = FALSE
       RETURNING id`
    );
    return { approvedCount: rows.length };
  },

  async getActiveNudgeForUser(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM nudges
       WHERE user_id = $1 AND approved_by_admin = TRUE AND delivered_at IS NULL
       ORDER BY risk_score DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  },

  async getChurnRiskData(userId) {
    const user = await db.getUserById(userId);
    let tonesCount = 0;
    if (user && user.tone_profile && user.tone_profile.trim().length > 0) {
      tonesCount = 1;
    }
    
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM events WHERE user_id = $1 AND event_name = 'contact_remembered'`,
      [userId]
    );
    const memoriesCount = parseInt(rows[0]?.count) || 0;
    
    return `You have ${memoriesCount} contact memories and ${tonesCount} Custom Tones saved. Downgrading means these will be permanently deleted.`;
  },

  async markNudgeDelivered(nudgeId) {
    await pool.query(
      `UPDATE nudges SET delivered_at = NOW() WHERE id = $1`,
      [nudgeId]
    );
  },

  async calculateAndStorePredictions() {
    const { rows: users } = await pool.query(`SELECT * FROM users`);
    const now = new Date();

    for (const u of users) {
      const createdTime = new Date(u.created_at).getTime();
      const hoursSinceCreated = Math.max(1, Math.floor((now.getTime() - createdTime) / 3600000));
      const lastActiveTime = u.last_active_date ? new Date(u.last_active_date).getTime() : createdTime;
      const hoursInactive = Math.max(0, Math.floor((now.getTime() - lastActiveTime) / 3600000));
      const totalReplies = u.total_replies || 0;

      let riskScore = 0;
      let segment = 'HEALTHY_ADVOCATE';
      let statusLabel = 'Healthy Engaged';
      let campaignName = 'Regular Active Retain';
      let triggerChannel = 'gmail_toast';
      let aiMessage = `Keep it up! ReplyMind is matching your voice seamlessly in Gmail.`;
      let ctaLabel = 'Open Gmail';
      let ctaAction = 'open_gmail';
      let confidenceScore = 75;

      if (totalReplies === 0 && hoursSinceCreated >= 12) {
        segment = 'STALLED_ACTIVATION';
        statusLabel = 'Stalled Activation (0 Replies)';
        riskScore = Math.min(98, Math.floor(50 + hoursSinceCreated * 1.5));
        campaignName = 'Activation Nudge: First AI Reply';
        triggerChannel = 'gmail_toast';
        aiMessage = u.onboarding_goal 
          ? `You wanted to ${u.onboarding_goal}. Don't give up now!`
          : `Hi there! Your personal AI Voice profile is loaded. Insert your first 1-click reply in Gmail to save 15 minutes today!`;
        ctaLabel = 'Write First Reply';
        ctaAction = 'trigger_gmail_toast';
        confidenceScore = 94;
      } else if (u.plan === 'free' && totalReplies >= 5) {
        segment = 'CONVERSION_CANDIDATE';
        statusLabel = 'Free Quota Reached (Pro Candidate)';
        riskScore = 85;
        campaignName = 'Time-Sensitive Flash Offer: 50% Off Pro ($9.50/mo)';
        triggerChannel = 'extension_popover';
        aiMessage = `🔥 You've used all 5 free replies! Claim your 48-hour 50% discount: Pro Plan for $9.50/mo (coupon REPLY50).`;
        ctaLabel = 'Claim 50% Off Pro';
        ctaAction = 'https://replymind.xyz/checkout?coupon=REPLY50';
        confidenceScore = 93;
      } else if ((u.streak_days || 0) >= 2 && hoursInactive >= 24) {
        segment = 'STREAK_SAVER';
        statusLabel = 'Streak at Risk (Inactive 24h)';
        riskScore = 78;
        campaignName = 'Streak Saver Nudge';
        triggerChannel = 'push_alarm';
        aiMessage = `⚡ Don't lose your ${u.streak_days}-day streak! Send 1 quick reply today to keep it going.`;
        ctaLabel = 'Save My Streak';
        ctaAction = 'open_gmail';
        confidenceScore = 88;
      } else if (hoursInactive >= 72) {
        segment = 'HIGH_RISK_CHURN';
        statusLabel = 'High Churn Risk (Inactive > 3 Days)';
        riskScore = 91;
        campaignName = 'Re-engagement Flash Offer';
        triggerChannel = 'extension_popover';
        aiMessage = u.onboarding_goal
          ? `You wanted to ${u.onboarding_goal}. Don't give up now!`
          : `🔥 We miss you! Claim your 48-hour 50% discount: Pro Plan for $9.50/mo (coupon REPLY50).`;
        ctaLabel = 'Claim 50% Off Pro';
        ctaAction = 'https://replymind.xyz/checkout?coupon=REPLY50';
        confidenceScore = 89;
      }

      // Clear old undelivered nudges for this user to prevent duplication across segments
      await pool.query(
        `DELETE FROM nudges WHERE user_id = $1 AND delivered_at IS NULL`,
        [u.id]
      );

      if (segment !== 'HEALTHY_ADVOCATE') {
        await pool.query(
          `INSERT INTO nudges (user_id, segment, risk_score, status_label, campaign_name, trigger_channel, ai_message, cta_label, cta_action, confidence_score, approved_by_admin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [u.id, segment, riskScore, statusLabel, campaignName, triggerChannel, aiMessage, ctaLabel, ctaAction, confidenceScore, confidenceScore >= 90]
        );
      }
    }
  }
};

module.exports = { ...db, initDB, pool };
