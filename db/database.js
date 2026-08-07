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
  }
};

module.exports = { ...db, initDB, pool };
