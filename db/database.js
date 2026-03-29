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
        SUM(total_replies) as total_replies_generated
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
      `SELECT DATE(created_at) as day, COUNT(*) as signups
       FROM users WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(created_at) ORDER BY day`
    );
    return rows;
  },

  async getRepliesByDay(days = 30) {
    const { rows } = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) as replies
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
      `SELECT e.id, e.user_id, u.email, e.event_name, e.metadata, e.created_at
       FROM events e LEFT JOIN users u ON e.user_id = u.id
       ORDER BY e.created_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    return rows;
  },

  async updateUserPlan(userId, plan) {
    const validPlans = ['free', 'basic', 'pro', 'premium'];
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
      `SELECT id, email, plan, total_replies, streak_days, last_active_date, created_at
       FROM users ORDER BY total_replies DESC LIMIT $1`,
      [parseInt(limit)]
    );
    return rows;
  }
};

module.exports = { ...db, initDB, pool };
