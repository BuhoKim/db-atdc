/**
 * Read-only hr_employee export. Includes every column and retired employees.
 * node sync/inspect_hr_employee.js                 (company 1700)
 * node sync/inspect_hr_employee.js --all-companies (entire table)
 * Uses existing MySQL .env settings; does not connect to Supabase.
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { loadSyncEnv } = require('./loadEnv');

function options(args = []) {
  if (args.some(arg => !['--all-companies', '--help', '-h'].includes(arg))) {
    throw Object.assign(new Error('Unsupported option'), { code: 'INVALID_ARGUMENT' });
  }
  return { allCompanies: args.includes('--all-companies'), help: args.includes('--help') || args.includes('-h') };
}

function quoteColumn(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }
function stringify(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
}

function statusColumns(columns) {
  return columns.filter(column => /휴직|복직|휴복직/.test(column.COLUMN_COMMENT || '')
    || /RETIRE|RESIGN|STATUS|STATE|ABSENCE|SUSPEND|LEAVE|REINSTAT|REST|LOA|EMPLOY.*(TYPE|KIND|DIV)|WORK.*(TYPE|KIND|DIV)/i.test(column.COLUMN_NAME));
}

async function exportEmployees(conn, { allCompanies = false, outputRoot = path.join(__dirname, 'exports') } = {}) {
  let transaction = false;
  try {
    await conn.query('START TRANSACTION READ ONLY');
    transaction = true;
    const [columns] = await conn.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, ['hr_employee']);
    if (!columns.length) throw Object.assign(new Error('Table not found'), { code: 'EMPLOYEE_TABLE_NOT_FOUND' });
    const names = columns.map(column => column.COLUMN_NAME);
    if (!allCompanies && !names.includes('I_COMPANY')) {
      throw Object.assign(new Error('Company filter unavailable'), { code: 'COMPANY_COLUMN_MISSING' });
    }
    const order = ['I_COMPANY', 'I_EMPLOY_NO'].filter(name => names.includes(name));
    const sql = 'SELECT * FROM `hr_employee`' + (allCompanies ? '' : ' WHERE `I_COMPANY` = ?')
      + (order.length ? ' ORDER BY ' + order.map(quoteColumn).join(', ') : '');
    const [rows] = await conn.query({ sql, timeout: 60000 }, allCompanies ? [] : ['1700']);
    await conn.query('ROLLBACK');
    transaction = false;

    const candidates = statusColumns(columns);
    const summaryColumns = [...new Set([
      ...['I_COMPANY', 'I_EMPLOY_NO', 'N_EMPLOY_NAME', 'I_DEPT'].filter(name => names.includes(name)),
      ...candidates.map(column => column.COLUMN_NAME),
    ])];
    const company = allCompanies ? 'all' : '1700';
    const exportedAt = new Date().toISOString();
    const timestamp = exportedAt.replace(/[^0-9]/g, '');
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const outputDirectory = fs.mkdtempSync(path.join(outputRoot, `hr_employee_${company}_${timestamp}_`));
    const metadata = { table: 'hr_employee', companyCode: allCompanies ? null : '1700',
      scope: allCompanies ? 'all_companies' : 'company_1700', exportedAt, rowCount: rows.length };
    const outputs = {
      'hr_employee.json': { ...metadata, columns: names, rows },
      'schema.json': { ...metadata, columns, statusCandidateColumns: candidates },
      'employment_status.json': { ...metadata,
        note: 'Column names/comments are candidates, not verified meanings of status values.',
        columns: summaryColumns,
        rows: rows.map(row => Object.fromEntries(summaryColumns.map(name => [name, row[name]]))),
      },
    };
    for (const [filename, value] of Object.entries(outputs)) {
      fs.writeFileSync(path.join(outputDirectory, filename), stringify(value), { flag: 'wx', mode: 0o600 });
    }
    return { rowCount: rows.length, columnCount: columns.length, outputDirectory,
      statusCandidateColumns: candidates.map(column => column.COLUMN_NAME), company };
  } finally {
    if (transaction) await conn.query('ROLLBACK').catch(() => {});
  }
}

async function main(args = process.argv.slice(2)) {
  const selected = options(args);
  if (selected.help) {
    console.log('node inspect_hr_employee.js                 회사 1700 전체 직원·전체 컬럼');
    console.log('node inspect_hr_employee.js --all-companies 모든 회사의 전체 행·전체 컬럼');
    console.log('조회 전용. 결과는 이 스크립트 옆 exports 폴더에 저장됩니다.');
    return;
  }
  loadSyncEnv();
  for (const name of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DATABASE']) {
    if (!process.env[name]) throw Object.assign(new Error('Missing MySQL configuration'), { code: 'MYSQL_CONFIG_MISSING' });
  }
  let conn;
  try {
    conn = await mysql.createConnection({ host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE, port: Number(process.env.MYSQL_PORT || 3306),
      connectTimeout: 15000, dateStrings: true, supportBigNumbers: true,
      bigNumberStrings: true, decimalNumbers: false, multipleStatements: false });
    const result = await exportEmployees(conn, selected);
    console.log(`조회 완료: ${result.company === 'all' ? '모든 회사' : '회사 1700'} / ${result.rowCount}명 / ${result.columnCount}개 컬럼`);
    console.log(`상태 후보 컬럼: ${result.statusCandidateColumns.join(', ') || '(이름·설명으로 식별되지 않음; schema.json 전체 확인 필요)'}`);
    console.log(`저장 위치: ${result.outputDirectory}`);
    console.log('hr_employee.json: 전체 원본 / schema.json: 컬럼 구조·설명 / employment_status.json: 상태 후보 값');
    console.log('주의: 개인정보가 포함됩니다. 원본 전체를 채팅·Git에 올리지 마세요.');
    console.log('DB 및 기존 동기화 상태는 변경하지 않았습니다.');
  } finally {
    if (conn) await conn.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    const code = /^[A-Z0-9_]{1,64}$/.test(String(error.code || '')) ? error.code : 'EXPORT_FAILED';
    console.error(`조회 실패 (${code}). 서버PC의 MySQL 접속 설정·네트워크 및 exports 폴더 권한을 확인하세요.`);
    process.exitCode = 1;
  });
}
module.exports = { options, statusColumns, exportEmployees };
