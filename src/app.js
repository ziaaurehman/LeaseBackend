const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');

const routes = require('./routes');
const { sendError } = require('./utils/response');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
  })
);
app.use(morgan('dev'));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: process.env.PORT, timestamp: new Date().toISOString() });
});

app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  return sendError(res, `Route ${req.method} ${req.originalUrl} not found`, 404);
});

// global error handler
app.use((err, req, res, next) => {
  console.error(err);
  return sendError(res, err.message || 'Internal server error', err.status || 500);
});

module.exports = app;
