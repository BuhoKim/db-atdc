const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { options, statusColumns, exportEmployees } = require('../inspect_hr_employee');

function temporaryOutput(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-atdc-employee-export-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    const parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('db-atdc-employee-export-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return path.join(directory, 'exports');
}

function fakeConnection({ columns, rows, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /information_schema.COLUMNS/);
      assert.deepEqual(params, ['hr_employee']);
      return [columns || [
        { COLUMN_NAME: 'I_COMPANY', DATA_TYPE: 'varchar' },
        { COLUMN_NAME: 'I_EMPLOY_NO', DATA_TYPE: 'varchar' },
        { COLUMN_NAME: 'N_EMPLOY_NAME', DATA_TYPE: 'varchar' },
        { COLUMN_NAME: 'I_RETIRE_YN', COLUMN_COMMENT: '퇴사 여부' },
        { COLUMN_NAME: 'D_REST_START', COLUMN_COMMENT: '휴직 시작일' },
        { COLUMN_NAME: 'D_RETURN', COLUMN_COMMENT: '복직일' },
        { COLUMN_NAME: 'OTHER', DATA_TYPE: 'text' },
      ]];
    },
    async query(statement, params) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      calls.push({ sql, params });
      if (!sql.startsWith('SELECT')) {
        assert.ok(['START TRANSACTION READ ONLY', 'ROLLBACK'].includes(sql));
        return [];
      }
      if (fail) throw new Error('fixture');
      return [rows || [{ I_COMPANY: '1700', I_EMPLOY_NO: '00123456', N_EMPLOY_NAME: 'Fixture',
        I_RETIRE_YN: '1', D_REST_START: null, D_RETURN: '', OTHER: '한글\n"메모"' }]];
    },
  };
}

test('defaults to company 1700; all-company access is explicit', () => {
  assert.equal(options().allCompanies, false);
  assert.equal(options(['--all-companies']).allCompanies, true);
  assert.equal(options(['--help']).help, true);
  assert.throws(() => options(['--company=1600']), { code: 'INVALID_ARGUMENT' });
});

test('all original values including retired employee, NULL and leading zeros are preserved', async t => {
  const conn = fakeConnection();
  const result = await exportEmployees(conn, { outputRoot: temporaryOutput(t) });
  const raw = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, 'hr_employee.json'), 'utf8'));
  assert.equal(raw.rowCount, 1);
  assert.equal(raw.columns.length, 7);
  assert.deepEqual(raw.rows[0], { I_COMPANY: '1700', I_EMPLOY_NO: '00123456', N_EMPLOY_NAME: 'Fixture',
    I_RETIRE_YN: '1', D_REST_START: null, D_RETURN: '', OTHER: '한글\n"메모"' });
  const select = conn.calls.find(call => call.sql.startsWith('SELECT *'));
  assert.match(select.sql, /WHERE `I_COMPANY` = \?/);
  assert.deepEqual(select.params, ['1700']);
  assert.ok(!select.sql.includes('RETIRE'));
  assert.equal(conn.calls[0].sql, 'START TRANSACTION READ ONLY');
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
  const schema = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, 'schema.json'), 'utf8'));
  assert.equal(schema.columns.length, 7);
  assert.equal(schema.rows, undefined);
  const summary = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, 'employment_status.json'), 'utf8'));
  assert.equal(summary.rows[0].D_REST_START, null);
  assert.ok(!Object.hasOwn(summary.rows[0], 'OTHER'));
});

test('all-company option removes only company filter, not columns', async t => {
  const conn = fakeConnection();
  const result = await exportEmployees(conn, { allCompanies: true, outputRoot: temporaryOutput(t) });
  const select = conn.calls.find(call => call.sql.startsWith('SELECT *'));
  assert.ok(!select.sql.includes('WHERE'));
  assert.deepEqual(select.params, []);
  assert.equal(result.company, 'all');
});

test('missing company column fails closed and rolls back', async t => {
  const conn = fakeConnection({ columns: [{ COLUMN_NAME: 'OTHER' }] });
  await assert.rejects(exportEmployees(conn, { outputRoot: temporaryOutput(t) }), { code: 'COMPANY_COLUMN_MISSING' });
  assert.ok(!conn.calls.some(call => call.sql.startsWith('SELECT *')));
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
});

test('failed query rolls back without exporting partial rows', async t => {
  const outputRoot = temporaryOutput(t);
  const conn = fakeConnection({ fail: true });
  await assert.rejects(exportEmployees(conn, { outputRoot }));
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!fs.existsSync(outputRoot));
});

test('repeated execution never overwrites a prior export', async t => {
  const outputRoot = temporaryOutput(t);
  const first = await exportEmployees(fakeConnection(), { outputRoot });
  const second = await exportEmployees(fakeConnection(), { outputRoot });
  assert.notEqual(first.outputDirectory, second.outputDirectory);
  assert.ok(fs.existsSync(path.join(first.outputDirectory, 'hr_employee.json')));
});

test('status candidates use both field names and Korean column comments', () => {
  assert.deepEqual(statusColumns([
    { COLUMN_NAME: 'I_RETIRE_YN' }, { COLUMN_NAME: 'D_CUSTOM', COLUMN_COMMENT: '휴직 시작일' },
    { COLUMN_NAME: 'D_BACK', COLUMN_COMMENT: '복직 예정일' }, { COLUMN_NAME: 'N_EMAIL' },
  ]).map(column => column.COLUMN_NAME), ['I_RETIRE_YN', 'D_CUSTOM', 'D_BACK']);
});
