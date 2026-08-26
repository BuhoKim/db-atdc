/**
 * CAPS 원본 확인용 읽기 전용 스크립트
 * 기본값: 한국시간 어제 17:55:00 ~ 20:00:00, 회사 1700 / 그룹 09
 * 실행 예: node check_caps_window.js
 * 날짜 지정: node check_caps_window.js 20260826 17:55:00 20:00:00
 */

const mysql = require('mysql2/promise');
const { loadSyncEnv } = require('./loadEnv');

loadSyncEnv();

const COMPANY_CODE = process.env.MY_COMPANY_CODE || '1700';
const GROUP_CODE = process.env.CAPS_E_GROUP || '09';
const [dateArg, fromArg = '17:55:00', toArg = '20:00:00'] = process.argv.slice(2);

function koreaYesterday() {
  const now = new Date();
  const korea = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  korea.setDate(korea.getDate() - 1);
  const yyyy = korea.getFullYear();
  const mm = String(korea.getMonth() + 1).padStart(2, '0');
  const dd = String(korea.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function normalizeTime(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.padStart(6, '0').slice(-6);
}

const date = dateArg || koreaYesterday();
const from = normalizeTime(fromArg);
const to = normalizeTime(toArg);

if (!/^\d{8}$/.test(date) || from > to) {
  throw new Error('사용법: node check_caps_window.js [YYYYMMDD] [HH:mm:ss] [HH:mm:ss]');
}

const config = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT || 3306),
  connectTimeout: 20000,
};

async function main() {
  let conn;
  try {
    conn = await mysql.createConnection(config);
    const [rows] = await conn.execute(`
      SELECT t.*
      FROM tenter t
      WHERE t.E_DATE = ?
        AND t.E_GROUP = ?
        AND LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0') BETWEEN ? AND ?
      ORDER BY LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0'), t.E_IDNO
    `, [date, GROUP_CODE, from, to]);

    const resultCounts = {};
    for (const row of rows) {
      const key = String(row.E_RESULT ?? '(NULL)');
      resultCounts[key] = (resultCounts[key] || 0) + 1;
    }

    console.log(JSON.stringify({
      date,
      timeRange: `${from}~${to}`,
      company: COMPANY_CODE,
      group: GROUP_CODE,
      count: rows.length,
      resultCounts,
      rows,
    }, null, 2));
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((error) => {
  console.error(`조회 실패: ${error.message}`);
  process.exitCode = 1;
});
