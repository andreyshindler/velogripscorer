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

test('admin can delete a plain user; self and admins are protected', async () => {
  // A fresh user with no data.
  await request(app).post('/api/auth/register')
    .send({ email: 'deleteme@test.co', password: 'password123', name: 'Delete Me' });
  let users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  const delId = users.find((u) => u.email === 'deleteme@test.co').id;
  const adminId = users.find((u) => u.role === 'admin').id;

  // cannot delete yourself or another admin
  assert.equal((await request(app).delete(`/api/admin/users/${adminId}`).set('Authorization', `Bearer ${adminToken}`)).status, 400);

  const ok = await request(app).delete(`/api/admin/users/${delId}`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(ok.status, 200);
  users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  assert.ok(!users.find((u) => u.email === 'deleteme@test.co'), 'user is gone');
});

test('deleting a user who owns races is refused', async () => {
  // Approve a user, let them create a race, then deletion must be blocked.
  await request(app).post('/api/auth/register')
    .send({ email: 'owner@test.co', password: 'password123', name: 'Race Owner' });
  let users = (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)).body.users;
  const ownerId = users.find((u) => u.email === 'owner@test.co').id;
  await request(app).post(`/api/admin/users/${ownerId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  const ownerToken = (await login('owner@test.co', 'password123')).body.token;

  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  await request(app).post('/api/contests').set('Authorization', `Bearer ${ownerToken}`)
    .send({ title: 'Owned race', kind: 'race', category: 'other', start_at: now, end_at: later });

  const res = await request(app).delete(`/api/admin/users/${ownerId}`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 409, 'cannot delete a user who owns races');
});
