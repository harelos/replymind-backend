require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db/database');

const path = require('path');

const app = express();

// Allow all origins in development — tighten this when deploying to Railway
app.use(cors());

// Paddle webhook needs the RAW body for signature verification, so parse it as a
// Buffer for that path only, BEFORE the JSON parser consumes the stream.
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '256kb' }));

app.use(express.json({ limit: '10kb' }));

// Serve admin panel
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/convertiq', require('./routes/convertiq'));
app.use('/api/leads', require('./routes/leads'));

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
  console.error(err.stack);
  process.exit(1);
});