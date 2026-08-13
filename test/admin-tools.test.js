'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-at-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1';
process.env.ALLOW_TEST_RESET = '1';
process.env.ADMIN_EMAIL = 'at-admin@test.local';
process.env.ADMIN_PASSWORD = 'at-admin-secret';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
seedAdmin();

const auth = (s) => ({ Authorization: `Bearer ${s.token}` });
let admin, u1;

test('setup: admin logs in, a regular user + a race exist', async () => {
  admin = (await request(app).post('/api/auth/login')
    .send({ email: 'at-admin@test.local', password: 'at-admin-secret' })).body;
  assert.equal(admin.user.role, 'admin');

  u1 = (await request(app).post('/api/auth/register')
    .send({ email: 'u1@test.co', password: 'password123', username: 'racer1' })).body;
  await request(app).post('/api/contests').set(auth(u1)).send({
    title: 'A race', kind: 'race', category: 'other',
    start_at: new Date().toISOString(), end_at: new Date(Date.now() + 3600_000).toISOString(),
  });
});

test('admin can promote and demote a user; guards hold', async () => {
  const up = await request(app).post(`/api/admin/users/${u1.user.id}/role`).set(auth(admin)).send({ role: 'admin' });
  assert.equal(up.status, 200);
  assert.equal(up.body.role, 'admin');
  const check = (await request(app).get('/api/admin/users').set(auth(admin))).body.users.find((u) => u.id === u1.user.id);
  assert.equal(check.role, 'admin');

  // Can't change your own role.
  const self = await request(app).post(`/api/admin/users/${admin.user.id}/role`).set(auth(admin)).send({ role: 'voter' });
  assert.equal(self.status, 400);

  const down = await request(app).post(`/api/admin/users/${u1.user.id}/role`).set(auth(admin)).send({ role: 'voter' });
  assert.equal(down.status, 200);
  assert.equal(down.body.role, 'voter');
});

test('reset test data wipes races + non-admin users but keeps admins', async () => {
  // Needs the typed confirmation.
  const noConfirm = await request(app).post('/api/admin/reset-test-data').set(auth(admin)).send({});
  assert.equal(noConfirm.status, 400);

  const reset = await request(app).post('/api/admin/reset-test-data').set(auth(admin)).send({ confirm: 'RESET' });
  assert.equal(reset.status, 200);

  const users = (await request(app).get('/api/admin/users').set(auth(admin))).body.users;
  assert.ok(users.every((u) => u.role === 'admin'), 'only admins remain');
  assert.ok(!users.find((u) => u.id === u1.user.id), 'the regular user is gone');

  const races = (await request(app).get('/api/my/races').set(auth(admin))).body.races;
  assert.equal(races.length, 0, 'all races cleared');
});

test('reset is refused when ALLOW_TEST_RESET is off', async () => {
  process.env.ALLOW_TEST_RESET = '0';
  const r = await request(app).post('/api/admin/reset-test-data').set(auth(admin)).send({ confirm: 'RESET' });
  assert.equal(r.status, 403);
  process.env.ALLOW_TEST_RESET = '1';
});
