const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAttendanceWindow } = require('../attendanceIncremental');
const clientModule = require('../supabaseClient');
const { recoveryOptions } = require('../recover_attendance');
const { shouldSyncEmployeesToday, millisecondsUntilNextEightKst } = require('../index');
const { acquireWorkerLock } = require('../workerLock');

function fakeClient({ cursor = '2026-10-15T07:12:44.665Z', latest = null, readError = null,
  failBatch = 0, hideStoredRows = false, employeeSynced = false } = {}) {
  const client = { batches: [], checkpoints: [], saved: new Map() };
  client.from = table => {
    let columns;
    const query = {
      select(value) { columns = value; return this; },
      eq() { return this; }, like() { return this; }, order() { return this; },
      gte() { return this; }, lt() { return this; }, lte() { return this; },
      async limit() {
        if (table === 'db_sync_checkpoints') return { data: cursor ? [{ last_success_at: cursor }] : [], error: readError };
        if (table === 'db_employees') return { data: employeeSynced ? [{ emp_no: 'fixture' }] : [] };
        return { data: latest ? [{ synced_at: latest }] : [] };
      },
      async upsert(records, options) {
        if (table === 'db_sync_checkpoints') { client.checkpoints.push(records); return {}; }
        assert.equal(options.onConflict, 'sabun,a_time');
        client.batches.push(records);
        if (client.batches.length === failBatch) return { error: { message: 'fixture write failed' } };
        for (const row of records) client.saved.set(`${row.sabun}|${row.a_time}`, row);
        return {};
      },
      async range(from, to) {
        assert.equal(columns, 'sabun,a_time');
        return { data: hideStoredRows ? [] : [...client.saved.values()].slice(from, to + 1) };
      },
    };
    return query;
  };
  return client;
}

test('17-hour outage resumes from preserved checkpoint minus 10 minutes', async () => {
  const window = await getAttendanceWindow({ supabase: fakeClient(), companyCode: '1700', source: 'caps',
    now: new Date('2026-10-16T00:30:00Z'), overlapMinutes: 10 });
  assert.equal(window.fromStr, '20261015160244');
  assert.equal(window.toStr, '20261016093000');
  assert.equal(window.cursorOrigin, 'checkpoint');
});

test('recovery also covers a full day if copied data has a recent synced_at', async () => {
  const window = await getAttendanceWindow({ supabase: fakeClient({ cursor: null, latest: '2026-10-16T00:20:00Z' }),
    companyCode: '1700', source: 'caps', now: new Date('2026-10-16T00:30:00Z'),
    recoveryFrom: new Date('2026-10-15T00:30:00Z'), overlapMinutes: 10 });
  assert.equal(window.fromStr, '20261015092000');
});

test('recovery does not truncate an outage lasting several days', async () => {
  const window = await getAttendanceWindow({ supabase: fakeClient({ cursor: '2026-10-10T00:00:00Z' }),
    companyCode: '1700', source: 'caps', now: new Date('2026-10-16T00:30:00Z'),
    recoveryFrom: new Date('2026-10-15T00:30:00Z'), overlapMinutes: 10 });
  assert.equal(window.fromStr, '20261010085000');
});

test('checkpoint read failure never falls back and skips the outage', async () => {
  await assert.rejects(getAttendanceWindow({ supabase: fakeClient({ readError: { message: 'fixture' } }),
    companyCode: '1700', source: 'caps' }), /체크포인트 조회 실패/);
});

test('company guard rejects legacy DB, browser key and wrong company/group', () => {
  const env = { SUPABASE_URL: clientModule.COMPANY_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture' };
  assert.equal(clientModule.getCompanySupabaseConfig(env).url, clientModule.COMPANY_SUPABASE_URL);
  assert.throws(() => clientModule.getCompanySupabaseConfig({ ...env, SUPABASE_URL: 'https://gbfoempwoeurhhlxqxgy.supabase.co' }));
  assert.throws(() => clientModule.getCompanySupabaseConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_fixture' }));
  assert.throws(() => clientModule.getCompanySupabaseConfig({ ...env, MY_COMPANY_CODE: '1600' }));
  assert.throws(() => clientModule.getCompanySupabaseConfig({ ...env, CAPS_E_GROUP: '08' }));
});

test('employee sync runs after 08:00 KST only if not already synced today', async () => {
  assert.equal((await shouldSyncEmployeesToday(fakeClient(), new Date('2026-10-15T22:59:00Z'))).due, false);
  assert.equal((await shouldSyncEmployeesToday(fakeClient(), new Date('2026-10-15T23:00:00Z'))).due, true);
  assert.equal((await shouldSyncEmployeesToday(fakeClient({ employeeSynced: true }), new Date('2026-10-16T00:00:00Z'))).due, false);
  assert.equal(millisecondsUntilNextEightKst(new Date('2026-10-15T22:59:00Z')), 60000);
});

test('legacy entry points resolve to the same 10-minute worker without starting it', () => {
  const worker = require('../index');
  assert.equal(require('../../sync_server').main, worker.main);
  assert.equal(require('../sync_server').main, worker.main);
  assert.equal(worker.SYNC_INTERVAL_MS, 600000);
});

test('duplicate worker lock is rejected and releases cleanly', () => {
  const file = path.join(os.tmpdir(), `db-atdc-test-lock-${process.pid}`);
  const release = acquireWorkerLock(file);
  try { assert.throws(() => acquireWorkerLock(file), /이미 db-atdc/); } finally { release(); }
  assert.equal(fs.existsSync(file), false);
});

test('recovery argument validation rejects accidental invalid ranges', () => {
  assert.deepEqual(recoveryOptions([]), { hours: 24, dryRun: false });
  assert.deepEqual(recoveryOptions(['--hours', '48', '--dry-run']), { hours: 48, dryRun: true });
  assert.throws(() => recoveryOptions(['--hours']));
  assert.throws(() => recoveryOptions(['--hours', '-1']));
});

function sourceRow(second) {
  const date = new Date(Date.UTC(2026, 9, 16, 0, 0, second));
  const time = date.toISOString().slice(11, 19).replace(/:/g, '');
  return { emp_no: '20240001', idno: '170020240001', card_no: 'fixture', e_date: '20261016',
    e_time: time, gate_code: '4000', e_group: '09', e_mode: '1', e_type: '1', e_result: '5' };
}

let activeClient;
const originalFactory = clientModule.createSyncSupabaseClient;
clientModule.createSyncSupabaseClient = () => ({ from: (...args) => activeClient.from(...args) });
const { syncAttendance } = require('../caps');
clientModule.createSyncSupabaseClient = originalFactory;
const now = new Date('2026-10-16T00:30:00Z');
function connection(rows) {
  return { async execute(sql, params) {
    assert.deepEqual(params.slice(0, 3), ['1700', '1700', '09']);
    assert.match(sql, /t\.E_IDNO/);
    assert.doesNotMatch(sql, /db_leaves|hr_yuncha/);
    return [rows];
  } };
}

test('dry-run counts real source rows without writes or checkpoint changes', async () => {
  activeClient = fakeClient();
  assert.equal(await syncAttendance(connection([sourceRow(1)]), { now, dryRun: true }), 1);
  assert.equal(activeClient.batches.length, 0);
  assert.equal(activeClient.checkpoints.length, 0);
});

test('failed later batch keeps checkpoint so retry can recover the entire window', async () => {
  activeClient = fakeClient({ failBatch: 2 });
  await assert.rejects(syncAttendance(connection(Array.from({ length: 501 }, (_, i) => sourceRow(i))), { now }), /upsert 실패/);
  assert.equal(activeClient.batches.length, 2);
  assert.equal(activeClient.checkpoints.length, 0);
});

test('successful recovery deduplicates, verifies every key across pages, then advances checkpoint', async () => {
  activeClient = fakeClient();
  const rows = Array.from({ length: 501 }, (_, i) => sourceRow(i));
  rows.push({ ...sourceRow(0), e_time: '00:00:00' });
  assert.equal(await syncAttendance(connection(rows), { now, verify: true }), 501);
  assert.equal(activeClient.saved.size, 501);
  assert.equal(activeClient.checkpoints.length, 1);
  assert.equal(activeClient.checkpoints[0].last_success_at, now.toISOString());
});

test('verification failure never advances checkpoint', async () => {
  activeClient = fakeClient({ hideStoredRows: true });
  await assert.rejects(syncAttendance(connection([sourceRow(1)]), { now, verify: true }), /원본 대조 누락 1건/);
  assert.equal(activeClient.checkpoints.length, 0);
});

test('invalid source employee number never advances checkpoint', async () => {
  activeClient = fakeClient();
  await assert.rejects(syncAttendance(connection([{ ...sourceRow(1), idno: '160020240001' }]), { now }), /원본 사번/);
  assert.equal(activeClient.checkpoints.length, 0);
});
