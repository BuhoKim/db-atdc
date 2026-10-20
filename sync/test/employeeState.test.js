const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStateCode, normalizeStateDate, mapEmployeeState } = require('../employeeState');
const { syncEmployees } = require('../employees');

test('known HR codes map exactly to active, on_leave and resigned', () => {
  for (const [code, status] of [['001', 'active'], ['002', 'on_leave'], ['999', 'resigned']]) {
    const mapped = mapEmployeeState({ I_STATE_CODE: code, D_STATE_DATE: '20261020' });
    assert.equal(mapped.state_code, code);
    assert.equal(mapped.employment_status, status);
    assert.equal(mapped.state_date, '2026-10-20');
    assert.equal(mapped.is_active, code !== '999');
  }
});

test('numeric and trimmed codes keep leading zeros without accepting unknown values', () => {
  assert.equal(normalizeStateCode(1), '001');
  assert.equal(normalizeStateCode(' 002 '), '002');
  assert.equal(mapEmployeeState({ state_code: 2 }).employment_status, 'on_leave');
  for (const code of [null, '', 'abc', '000', '003', '9999']) {
    assert.equal(mapEmployeeState({ state_code: code }).employment_status, null);
  }
});

test('calendar date is not replaced by sync time or shifted to UTC', () => {
  for (const date of ['20261020', 20261020, '2026-10-20', '2026/10/20', '2026-10-20 00:00:00', '20261020000000']) {
    assert.equal(normalizeStateDate(date), '2026-10-20');
  }
  assert.equal(normalizeStateDate(new Date(2026, 9, 20, 0, 0, 0)), '2026-10-20');
  assert.equal(normalizeStateDate('2024-02-29'), '2024-02-29');
  for (const date of [null, undefined, '', '00000000', '0000-00-00', '20260230', '2026-13-01', 'bad', new Date('invalid')]) {
    assert.equal(normalizeStateDate(date), null);
  }
  assert.equal(mapEmployeeState({ state_code: '002', state_date: '20261101' }).state_date, '2026-11-01');
});

test('manual deactivation is never undone by active or on-leave HR codes', () => {
  for (const code of ['001', '002']) {
    const result = mapEmployeeState({ state_code: code }, { is_active: false });
    assert.equal(result.is_active, false);
    assert.equal(result.employment_status, code === '001' ? 'active' : 'on_leave');
  }
});

test('known state code takes priority over legacy retirement flag', () => {
  assert.equal(mapEmployeeState({ state_code: '002', retire_yn: '1' }, { is_active: true }).is_active, true);
  assert.equal(mapEmployeeState({ state_code: '999', retire_yn: '0' }, { is_active: true }).is_active, false);
});

test('empty/unknown code preserves confirmed state and uses legacy flag only as fallback', () => {
  const existing = { is_active: true, state_code: '002', employment_status: 'on_leave', state_date: '2026-10-01' };
  for (const code of [null, '', '777']) {
    assert.deepEqual(mapEmployeeState({ state_code: code, state_date: '20261020' }, existing), existing);
  }
  assert.equal(mapEmployeeState({ retire_yn: '1' }).is_active, false);
  assert.equal(mapEmployeeState({ retire_yn: null }, { is_active: true }).is_active, true);
});

function client(existing = [], failRead = false) {
  const writes = [];
  return { writes,
    from(table) {
      assert.equal(table, 'db_employees');
      return {
        select(columns) { assert.ok(columns.includes('state_code')); return this; },
        async in(column, values) {
          assert.equal(column, 'emp_no'); assert.deepEqual(values, ['20260001', '20260002']);
          return { data: existing, error: failRead ? { message: 'fixture' } : null };
        },
        async upsert(rows, options) {
          writes.push(rows); assert.equal(options.onConflict, 'emp_no'); return {};
        },
      };
    },
  };
}

function connection(rows) {
  return { async execute(sql, params) {
    assert.match(sql, /e\.I_STATE_CODE\s+AS state_code/);
    assert.match(sql, /e\.D_STATE_DATE\s+AS state_date/);
    assert.deepEqual(params, ['1700']);
    assert.ok(!sql.includes('WHERE e.I_RETIRE_YN'));
    return [rows];
  } };
}
const rows = [
  { emp_no: '170020260001', name: 'FixtureLeave', dept: 'Test', state_code: '002', state_date: '20261020', retire_yn: '0' },
  { emp_no: '20260002', name: 'FixtureRetired', dept: 'Test', state_code: '999', state_date: '2026-09-30', retire_yn: '0' },
];

test('real employee sync upsert includes raw code, interpreted status and effective date', async () => {
  const mock = client([{ emp_no: '20260001', is_active: true }, { emp_no: '20260002', is_active: true }]);
  assert.equal(await syncEmployees(connection(rows), { supabaseClient: mock }), 2);
  assert.equal(mock.writes[0][0].company_code, '1700');
  assert.equal(mock.writes[0][0].state_code, '002');
  assert.equal(mock.writes[0][0].employment_status, 'on_leave');
  assert.equal(mock.writes[0][0].state_date, '2026-10-20');
  assert.equal(mock.writes[0][0].is_active, true);
  assert.equal(mock.writes[0][1].employment_status, 'resigned');
  assert.equal(mock.writes[0][1].is_active, false);
});

test('existing state read failure aborts before any upsert', async () => {
  const mock = client([], true);
  await assert.rejects(syncEmployees(connection(rows), { supabaseClient: mock }), /기존 재직상태 조회 실패/);
  assert.equal(mock.writes.length, 0);
});
