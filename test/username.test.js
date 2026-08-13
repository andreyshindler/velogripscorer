'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-un-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1';
process.env.ADMIN_EMAIL = 'un-admin@test.local';
process.env.ADMIN_PASSWORD = 'un-admin-secret';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
seedAdmin();

test('register with a username, then log in with either email or username', async () => {
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'andrey@test.co', password: 'password123', name: 'Andrey', username: 'Andrey' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.username, 'Andrey');

  const byEmail = await request(app).post('/api/auth/login').send({ email: 'andrey@test.co', password: 'password123' });
  assert.equal(byEmail.status, 200);

  // Username login is case-insensitive.
  const byUser = await request(app).post('/api/auth/login').send({ email: 'ANDREY', password: 'password123' });
  assert.equal(byUser.status, 200);
  assert.equal(byUser.body.user.id, byEmail.body.user.id);

  const wrong = await request(app).post('/api/auth/login').send({ email: 'andrey', password: 'nope' });
  assert.equal(wrong.status, 401);
});

test('a username with no display name becomes the display name; one is required', async () => {
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'noname@test.co', password: 'password123', username: 'soloName' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.name, 'soloName', 'display name defaults to the username');
  assert.equal(reg.body.user.username, 'soloName');

  const nada = await request(app).post('/api/auth/register')
    .send({ email: 'nada@test.co', password: 'password123' });
  assert.equal(nada.status, 400, 'a username (or name) is required');
});

test('usernames are unique and format-checked', async () => {
  const dup = await request(app).post('/api/auth/register')
    .send({ email: 'other@test.co', password: 'password123', name: 'Other', username: 'andrey' });
  assert.equal(dup.status, 409); // case-insensitive clash with "Andrey"

  const bad = await request(app).post('/api/auth/register')
    .send({ email: 'bad@test.co', password: 'password123', name: 'Bad', username: 'no spaces!' });
  assert.equal(bad.status, 400);
});

test('an existing account can set a username later, then log in with it', async () => {
  const reg = (await request(app).post('/api/auth/register')
    .send({ email: 'late@test.co', password: 'password123', name: 'Late' })).body;
  assert.equal(reg.user.username, null);

  const patched = await request(app).patch('/api/users/me')
    .set('Authorization', `Bearer ${reg.token}`).send({ username: 'latebloomer' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.username, 'latebloomer');

  const login = await request(app).post('/api/auth/login').send({ email: 'latebloomer', password: 'password123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, reg.user.id);

  // Taking an already-used username fails.
  const clash = await request(app).patch('/api/users/me')
    .set('Authorization', `Bearer ${reg.token}`).send({ username: 'Andrey' });
  assert.equal(clash.status, 409);
});
