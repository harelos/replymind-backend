const express = require('express');
const router = express.Router();
const db = require('../db/database');

// POST /api/leads - Capture lead from free web tool
router.post('/', async (req, res) => {
  try {
    const { email, sourceUrl, toolSlug, language } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address required' });
    }

    const lead = await db.saveToolLead({
      email: email.trim(),
      sourceUrl: sourceUrl || req.headers.referer || 'unknown',
      toolSlug: toolSlug || 'unknown',
      language: language || 'en'
    });

    return res.status(201).json({ success: true, message: 'Lead captured successfully', leadId: lead.id });
  } catch (err) {
    console.error('Error saving tool lead:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/leads/stats - View lead stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.getToolLeadsStats();
    return res.json({ stats });
  } catch (err) {
    console.error('Error fetching lead stats:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
