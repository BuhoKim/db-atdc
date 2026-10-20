const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { options, statusColumns, exportEmployees, exportStateCodes } = require('../inspect_hr_employee');

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
  assert.equal(options(['--state-codes']).stateCodes, true);
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

function stateConnection({ missingState = false, noDictionary = false, many = false, fail = false } = {}) {
  const calls = [];
  return { calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('KEY_COLUMN_USAGE')) return [[]];
      if (params[0] === 'hr_employee') return [[{ COLUMN_NAME: 'I_COMPANY' },
        ...(missingState ? [] : [{ COLUMN_NAME: 'I_STATE_CODE', COLUMN_TYPE: 'varchar(10)', COLUMN_COMMENT: '상태코드 H0123' }])]];
      assert.equal(params[0], 'tong_code');
      return [noDictionary ? [] : ['GUBUN_CODE', 'CODE', 'NAME', 'J_NAME'].map(COLUMN_NAME => ({ COLUMN_NAME }))];
    },
    async query(statement, params) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      calls.push({ sql, params });
      if (!sql.startsWith('SELECT')) {
        assert.ok(['START TRANSACTION READ ONLY', 'ROLLBACK'].includes(sql));
        return [];
      }
      if (fail) throw new Error('fixture');
      if (sql.includes('COUNT(*)')) {
        assert.deepEqual(params, ['1700']);
        return [[{ I_STATE_CODE: 'fixture-code', employee_count: 3 }]];
      }
      assert.ok(!sql.includes('SELECT *'));
      assert.ok(sql.includes('`tong_code`'));
      if (sql.includes(' LIKE ?')) {
        assert.ok(params.includes('%휴직%'));
        assert.ok(params.includes('H0123'));
        return [Array.from({ length: many ? 201 : 1 }, (_, i) => ({ GUBUN_CODE: 'H0123', CODE: String(i), NAME: '휴직(검증용 후보)' }))];
      }
      return [Array.from({ length: many ? 1001 : 2 }, (_, i) => ({ GUBUN_CODE: 'H0123', CODE: String(i), NAME: '검증용 후보' }))];
    },
  };
}

test('state code inspection exports descriptions and candidates, never assigns unverified meanings', async t => {
  const conn = stateConnection();
  const result = await exportStateCodes(conn, { outputRoot: temporaryOutput(t) });
  const report = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
  assert.equal(report.column.COLUMN_COMMENT, '상태코드 H0123');
  assert.equal(report.observedCodes[0].I_STATE_CODE, 'fixture-code');
  assert.equal(report.dictionary.verifiedMapping, false);
  assert.deepEqual(report.dictionary.groupsMentionedInColumnComment, ['H0123']);
  assert.equal(report.dictionary.relatedGroupRows.length, 2);
  assert.equal(report.rows, undefined);
  assert.ok(!JSON.stringify(report).includes('N_EMPLOY_NAME'));
  assert.equal(conn.calls[0].sql, 'START TRANSACTION READ ONLY');
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
});

test('missing state field fails safely and rolls back', async t => {
  const conn = stateConnection({ missingState: true });
  await assert.rejects(exportStateCodes(conn, { outputRoot: temporaryOutput(t) }), { code: 'STATE_COLUMN_MISSING' });
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
});

test('absent known dictionary still exports available column comment and observed codes', async t => {
  const conn = stateConnection({ noDictionary: true });
  const result = await exportStateCodes(conn, { outputRoot: temporaryOutput(t) });
  const report = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
  assert.equal(report.observedCodes.length, 1);
  assert.deepEqual(report.dictionary.matches, []);
  assert.ok(!conn.calls.some(call => call.sql.includes('FROM `tong_code`')));
});

test('large dictionary candidates are bounded and explicitly marked truncated', async t => {
  const result = await exportStateCodes(stateConnection({ many: true }), { outputRoot: temporaryOutput(t) });
  const report = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
  assert.equal(report.dictionary.matches.length, 200);
  assert.equal(report.dictionary.relatedGroupRows.length, 1000);
  assert.equal(report.dictionary.truncated, true);
});

test('state inspection query failure rolls back and writes no output', async t => {
  const outputRoot = temporaryOutput(t);
  const conn = stateConnection({ fail: true });
  await assert.rejects(exportStateCodes(conn, { outputRoot }));
  assert.equal(conn.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(fs.existsSync(outputRoot), false);
});
