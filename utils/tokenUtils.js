/**
 * Shared JWT / refresh-token helpers.
 * Imported by authController and freeUserController to avoid duplication.
 */

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { mainSequelize } = require('../config/database');

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m'
  });
}

async function createRefreshToken(userId) {
  const raw       = crypto.randomBytes(40).toString('hex');
  const hash      = crypto.createHash('sha256').update(raw).digest('hex');
  const days      = parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '30', 10);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await mainSequelize.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    { replacements: [userId, hash, expiresAt] }
  );

  return raw;
}

module.exports = { signAccessToken, createRefreshToken };
