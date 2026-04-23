const crypto = require('crypto');

const UPPER  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER  = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SPECIAL = '!@#$%^&*';
const ALL = UPPER + LOWER + DIGITS + SPECIAL;

const pick = (chars) => chars[crypto.randomInt(0, chars.length)];

// Guarantees at least one of each required character type
const generateTempPassword = (length = 12) => {
  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  const rest = Array.from({ length: length - required.length }, () => pick(ALL));
  return [...required, ...rest]
    .sort(() => crypto.randomInt(0, 3) - 1)
    .join('');
};

module.exports = { generateTempPassword };
