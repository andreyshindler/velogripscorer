'use strict';

// Basic automated moderation (req 3.3/3.9): profanity screen for user text.
// Intentionally small; a real deployment would plug in a proper service here.

const PROFANITY = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'slut', 'whore',
];

const pattern = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'i');

function containsProfanity(...texts) {
  return texts.some((t) => typeof t === 'string' && pattern.test(t));
}

module.exports = { containsProfanity };
