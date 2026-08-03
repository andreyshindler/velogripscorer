'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// NB: OPEN_REGISTRATION is deliberately left unset here so new sign-ups require
// admin approval — the behaviour this file exercises.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-approval-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.ADMIN_EMAIL = 'approval-admin@test.local';
process.env.ADMIN_PASSWORD = 'approval-admin-secret';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
seedAdmin();

const login = (email, password) =>
  request(app).post('/api/auth/login').send({ email, password });

let adminToken;
test('admin (seeded) can log in without approval', async () => {
  const res = await login('approval-admin@test.local', 'approval-admin-secret');
  assert.equal(res.status, 200);
  adminToken = res.body.token;
  assert.ok(adminToken);
});

test('new registration is pending: no token, cannot log in yet', async () => {
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'newbie@test.co', password: 'password123', name: 'New Bie' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.pending, true);
  assert.equal(reg.body.token, undefined, 'no session is issued for a pending account');

  const attempt = await login('newbie@test.co', 'password123');
  assert.equal(attempt.status, 403, 'pending account cannot log in');
  assert.match(attempt.body.error, /pending/i);
});

test('the pending registration shows up for the admin', async () => {
  const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  const newbie = res.body.users.find((u) => u.email === 'newbie@test.co');
  assert.ok(newbie, 'newbie is listed');
  assert.equal(newbie.approved, 0, 'listed as not approved');
});

test('after admin approval the account can log in', async () => {
  const users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  const id = users.find((u) => u.email === 'newbie@test.co').id;

  const ok = await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(ok.status, 200);

  const res = await login('newbie@test.co', 'password123');
  assert.equal(res.status, 200, 'approved account logs in');
  assert.ok(res.body.token);
});

test('reject removes a pending registration; approved accounts are protected', async () => {
  await request(app).post('/api/auth/register')
    .send({ email: 'spammer@test.co', password: 'password123', name: 'Spammer' });
  let users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  const spammerId = users.find((u) => u.email === 'spammer@test.co').id;

  const rej = await request(app).post(`/api/admin/users/${spammerId}/reject`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(rej.status, 200);

  users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  assert.ok(!users.find((u) => u.email === 'spammer@test.co'), 'rejected registration is gone');

  // The now-approved newbie cannot be deleted through the reject endpoint.
  const approvedId = users.find((u) => u.email === 'newbie@test.co').id;
  const guarded = await request(app).post(`/api/admin/users/${approvedId}/reject`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(guarded.status, 404, 'reject only removes still-pending accounts');
});

test('non-admins cannot reach the approval endpoints', async () => {
  const token = (await login('newbie@test.co', 'password123')).body.token;
  const res = await request(app).post('/api/admin/users/1/approve').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
});
