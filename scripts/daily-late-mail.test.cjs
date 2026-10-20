const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const Holidays = require('date-holidays');
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,
  '../supabase/functions/daily-late-mail/index.ts'), 'utf8')
  .replace("import Holidays from 'npm:date-holidays';", '')
  .replace("import { isEmployeeOnLeave } from '../_shared/employmentState.js';", ''));
const employmentRules = fs.readFileSync(path.join(__dirname,
  '../supabase/functions/_shared/employmentState.js'), 'utf8').replace(/export /g, '');
const target = 'https://qcpqcuzvirmbjzqjzapt.supabase.co';

function harness({ env = {}, tables = {}, duplicate = false, restFailure = false } = {}) {
  const values = { SUPABASE_URL: target, SUPABASE_SERVICE_ROLE_KEY: 'test-service',
    CRON_SECRET: 'test-cron', NAVER_WORKS_CLIENT_ID: 'test-client',
    NAVER_WORKS_CLIENT_SECRET: 'test-secret', NAVER_WORKS_REFRESH_TOKEN: 'test-refresh',
    NAVER_WORKS_SENDER_USER_ID: 'sender@example.invalid',
    DAILY_REPORT_RECIPIENTS: 'recipient@example.invalid', ...env };
  let handler;
  const calls = [];
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-19T00:00:00Z'])); }
  }
  const context = vm.createContext({ Holidays, Date: FixedDate, Response, Request, URL,
    URLSearchParams, TextEncoder, Uint8Array, crypto: globalThis.crypto,
    Deno: { env: { get: name => values[name] }, serve: fn => { handler = fn; } },
    fetch: async (url, init = {}) => {
      calls.push({ url, ...init });
      const parsed = new URL(url);
      if (parsed.hostname === 'auth.worksmobile.com') return Response.json({ access_token: 'mock-access' });
      if (parsed.hostname === 'www.worksapis.com') return new Response('', { status: 202 });
      assert.equal(parsed.origin, target);
      if (restFailure) return new Response('', { status: 500 });
      const table = parsed.pathname.split('/').at(-1);
      if (init.method === 'PATCH') return new Response(null, { status: 204 });
      if (init.method === 'POST') return Response.json(duplicate ? [] : [{ id: 1 }]);
      const offset = Number(parsed.searchParams.get('offset'));
      return Response.json((tables[table] || []).slice(offset, offset + 500));
    },
  });
  vm.runInContext(employmentRules + '\n' + source, context);
  return { calls, context, send: async (body = {}, headers = { 'x-cron-secret': 'test-cron' }, method = 'POST') => {
    const res = await handler(new Request('https://function.example.invalid', {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: res.status, body: await res.json() };
  } };
}

const employee = (id, name) => ({ emp_no: `2026000${id}`, name, dept: 'test', is_active: true });
const log = (id, time) => ({ emp_no: `2026000${id}`, a_time: `20261016${time.replace(':', '')}00` });
const fixtures = {
  db_employees: [employee(1, 'Absent'), employee(2, '<script>late</script>'),
    employee(3, 'Early'), employee(4, 'Leave'), employee(5, 'Half'), employee(6, 'Schedule')],
  db_attendance: [log(2, '09:10'), log(2, '18:10'), log(3, '08:55'), log(3, '17:40'),
    log(5, '14:10'), log(5, '18:10'), log(6, '09:44'), log(6, '18:10')],
  db_leaves: [{ emp_no: '20260004', leave_code: '12', leave_days: 1 },
    { emp_no: '20260005', leave_code: '16', leave_days: 0.5 }],
  db_employee_schedules: [{ emp_no: '20260006', schedule_time: '10:00', schedule_reason: '육아기 근로시간 단축' }],
};

test('four report groups in requested order; merged reasons and escaped names', async () => {
  const h = harness({ tables: fixtures });
  const { status, body } = await h.send({ dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.workDate, '2026-10-16');
  assert.equal(body.absentCount, 1);
  assert.equal(body.checkInCount, 3); // late + late half-day + personal schedule
  assert.equal(body.lateCount, 2);
  assert.equal(body.earlyCount, 1);
  assert.equal(body.leaveCount, 2);
  const indices = ['미출근자', '출근 이상', '퇴근 이상', '휴가자'].map(s => body.html.indexOf(s, body.html.indexOf('미출근자')));
  assert.ok(indices.every((v, i) => v >= 0 && (!i || v > indices[i - 1])));
  assert.ok(!body.html.includes('<script>'));
  assert.ok(body.html.includes('&lt;script&gt;late&lt;/script&gt;'));
  assert.ok(body.html.includes('지각 / 오전반차'));
  assert.ok(body.html.includes('육아기 근로시간 단축'));
  assert.equal(h.calls.filter(c => c.method === 'POST' || c.method === 'PATCH').length, 0);
});

test('empty report omits every section', async () => {
  const { body } = await harness().send({ dryRun: true });
  for (const title of ['미출근자', '출근 이상', '퇴근 이상', '휴가자']) assert.ok(!body.html.includes(title));
});

test('arbitrary bearer, missing auth and GET never access DB or provider', async () => {
  const h = harness();
  assert.equal((await h.send({}, { Authorization: 'Bearer arbitrary' })).status, 401);
  assert.equal((await h.send({}, {})).status, 401);
  assert.equal((await h.send({}, {}, 'GET')).status, 405);
  assert.equal(h.calls.length, 0);
});

test('old project cannot run report; missing provider config blocks actual send only', async () => {
  const old = harness({ env: { SUPABASE_URL: 'https://gbfoempwoeurhhlxqxgy.supabase.co' } });
  assert.equal((await old.send({ dryRun: true })).body.error, 'company_database_required');
  assert.equal(old.calls.length, 0);
  const h = harness({ env: { NAVER_WORKS_REFRESH_TOKEN: '' } });
  assert.equal((await h.send()).status, 503);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.send({ dryRun: true })).status, 200);
});

test('invalid body and impossible dates rejected', async () => {
  for (const body of [null, [], { workDate: '2026-02-30' }, { workDate: '2026-10-19' }, { workDate: 123 }]) {
    assert.equal((await harness().send(body)).status, 400);
  }
});

test('pagination reads beyond REST row limit', async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => ({ emp_no: `x${i}`, a_time: '20261016090000' }));
  const h = harness({ tables: { db_attendance: rows } });
  assert.equal((await h.send({ dryRun: true })).body.attendanceRowCount, 1005);
  assert.equal(h.calls.filter(c => c.url.includes('/db_attendance?')).length, 3);
});

test('duplicate claim prevents resend; successful send claims and audits once', async () => {
  const duplicate = harness({ duplicate: true });
  assert.equal((await duplicate.send()).body.skipped, 'already_claimed');
  assert.equal(duplicate.calls.length, 1);
  const h = harness({ tables: fixtures });
  assert.equal((await h.send()).status, 200);
  assert.equal(h.calls.filter(c => c.url.includes('www.worksapis.com')).length, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.equal(JSON.parse(h.calls.find(c => c.method === 'PATCH').body).status, 'sent');
});

test('force resend remains audited; REST failure returns controlled error', async () => {
  const h = harness();
  await h.send({ force: true });
  assert.match(JSON.parse(h.calls[0].body).job_key, /:resend-/);
  assert.equal((await harness({ restFailure: true }).send()).status, 502);
});

test('approved leave adjusts morning/afternoon attendance without suppressing partial leaves', async () => {
  const h = harness({ tables: {
    db_employees: [employee(1, 'MorningHalf'), employee(2, 'MorningTwo'), employee(3, 'AfternoonHalf'), employee(4, 'AfternoonTwo')],
    db_attendance: [log(1, '13:35'), log(1, '18:00'), log(2, '10:55'), log(2, '18:00'),
      log(3, '08:50'), log(3, '14:00'), log(4, '08:50'), log(4, '16:00')],
    db_leaves: [ ['16', 1], ['21', 2], ['17', 3], ['25', 4] ].map(([code, id]) => ({
      emp_no: `2026000${id}`, leave_code: code, leave_days: 1,
    })),
  } });
  const { body } = await h.send({ dryRun: true });
  assert.equal(body.lateCount, 0);
  assert.equal(body.checkInCount, 2);
  assert.equal(body.earlyCount, 2); // informational afternoon leave rows retained
  assert.equal(body.leaveCount, 4);
});

test('effective HR leave is excluded from absence, check-in, check-out and vacation lists', async () => {
  const h = harness({ tables: {
    db_employees: [
      { ...employee(1, 'OnLeaveMissing'), employment_status: 'on_leave', state_code: '002', state_date: '2026-10-16' },
      { ...employee(2, 'OnLeaveLogs'), employment_status: 'on_leave', state_date: '2026-10-15' },
      { ...employee(3, 'OnLeaveVacation'), employment_status: 'on_leave', state_date: null },
      { ...employee(4, 'InactiveOnLeaveVacation'), employment_status: 'on_leave', is_active: false, state_date: '2026-10-16' },
      employee(5, 'NormalMissing'),
    ],
    db_attendance: [log(2, '11:10'), log(2, '15:00')],
    db_leaves: [{ emp_no: '20260003', leave_code: '12', leave_days: 1 },
      { emp_no: '20260004', leave_code: '17', leave_days: 0.5 }],
  } });
  const { body, status } = await h.send({ dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.onLeaveExcludedCount, 4);
  assert.equal(body.absentCount, 1);
  assert.equal(body.lateCount, 0);
  assert.equal(body.checkInCount, 0);
  assert.equal(body.earlyCount, 0);
  assert.equal(body.leaveCount, 0);
  for (const name of ['OnLeaveMissing', 'OnLeaveLogs', 'OnLeaveVacation', 'InactiveOnLeaveVacation']) {
    assert.ok(!body.html.includes(name));
  }
  assert.ok(body.html.includes('NormalMissing'));
  assert.equal(h.calls.filter(call => call.method === 'POST' || call.method === 'PATCH').length, 0);
});

test('HR leave never excludes a work date before the effective date', async () => {
  const h = harness({ tables: { db_employees: [
    { ...employee(1, 'BeforeEffectiveDate'), employment_status: 'on_leave', state_code: '002', state_date: '2026-10-20' },
  ] } });
  const { body } = await h.send({ dryRun: true, workDate: '2026-10-16' });
  assert.equal(body.onLeaveExcludedCount, 0);
  assert.equal(body.absentCount, 1);
  assert.ok(body.html.includes('BeforeEffectiveDate'));
});

test('today can be previewed but never sent; future reports remain invalid', async () => {
  assert.equal((await harness().send({ dryRun: true, workDate: '2026-10-19' })).status, 200);
  assert.equal((await harness().send({ workDate: '2026-10-19' })).status, 400);
  assert.equal((await harness().send({ dryRun: true, workDate: '2026-10-20' })).status, 400);
});
