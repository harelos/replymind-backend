require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db/database');

const app = express();

// Allow all origins in development — tighten this when deploying to Railway
app.use(cors());

app.use(express.json({ limit: '10kb' }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/generate', require('./routes/generate'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`ReplyMind backend running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});