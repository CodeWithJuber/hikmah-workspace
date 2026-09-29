// Per-message language detection: Arabic-script presence -> 'ar', else 'en'.
// Run: node --test tests/chat-language.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLang } from '../lib/chat/language.ts';

test('arabic text detects ar', () => {
  assert.equal(detectLang('مرحبا بك في حكمة'), 'ar');
});

test('english text detects en', () => {
  assert.equal(detectLang('Hello, welcome to Hikmah.'), 'en');
});

test('mixed content detects ar (any Arabic script wins)', () => {
  assert.equal(detectLang('Hello مرحبا world'), 'ar');
  assert.equal(detectLang('السلام عليكم, how are you?'), 'ar');
});

test('arabic presentation forms detect ar', () => {
  assert.equal(detectLang('ﻣﺮﺣﺑﺎ'), 'ar');
});

test('empty / null / undefined detect en', () => {
  assert.equal(detectLang(''), 'en');
  assert.equal(detectLang('   '), 'en');
  assert.equal(detectLang(null), 'en');
  assert.equal(detectLang(undefined), 'en');
});

test('numbers and punctuation alone detect en', () => {
  assert.equal(detectLang('123 — ...?!'), 'en');
});
