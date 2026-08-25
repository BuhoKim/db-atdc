/**
 * 임직원 휴대폰번호·생년월일 일회성 추출 스크립트
 * 대상: 회사코드 1700의 hr_employee
 * 출력: exports/employee_contacts_birthdays_YYYYMMDD.csv
 *
 * 실행:
 *   node sync/export_employee_contacts_birthdays.js
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadSyncEnv } = require('./loadEnv');

loadSyncEnv();

const COMPANY_CODE = process.env.MY_COMPANY_CODE || '1700';
const mysqlConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  connectTimeout: 15000,
};

const PHONE_KEYS = [
  'I_MOBILE_NO', 'I_MOBILE', 'MOBILE_NO', 'MOBILE', 'MOBILE_PHONE',
  'PHONE', 'PHONE_NO', 'TEL', 'TEL_NO', 'H_PHONE', 'H_TEL', 'CELL_PHONE',
];
const BIRTH_KEYS = [
  'D_BIRTH_DATE', 'D_BIRTH', 'BIRTH_DATE', 'BIRTHDAY', 'BIRTH', 'BIRTH_DT',
];

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9가-힣]/gi, '').toUpperCase();
}

function findValue(row, preferredKeys, keywordPattern) {
  const keys = Object.keys(row);
  const normalized = new Map(keys.map((key) => [normalizedKey(key), key]));
  for (const preferred of preferredKeys) {
    const actual = normalized.get(normalizedKey(preferred));
    if (actual && cleanText(row[actual])) return cleanText(row[actual]);
  }
  const fallbackKey = keys.find((key) => keywordPattern.test(key) && cleanText(row[key]));
  return fallbackKey ? cleanText(row[fallbackKey]) : '';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('01')) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10 && digits.startsWith('01')) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(value).trim();
}

function normalizeBirth(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
  }
  const digits = String(value).replace(/\D/g, '');
  const match = digits.match(/(?:19|20)\d{6}/);
  return match ? match[0] : '';
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function main() {
  let conn;
  try {
    conn = await mysql.createConnection(mysqlConfig);
    const [rows] = await conn.execute(`
      SELECT e.*, d.N_DEPT AS dept
      FROM hr_employee e
      LEFT JOIN hr_department d ON
        d.I_COMPANY = e.I_COMPANY
        AND d.I_DEPT = e.I_DEPT
      WHERE e.I_COMPANY = ?
      ORDER BY d.N_DEPT, e.N_EMPLOY_NAME
    `, [COMPANY_CODE]);

    const headers = ['회사코드', '사번', '성명', '부서', '휴대폰번호', '생년월일(8자리)', '재직여부'];
    const outputRows = (rows || []).map((row) => {
      const phone = findValue(row, PHONE_KEYS, /(MOBILE|PHONE|TEL|CELL|휴대|핸드폰|전화)/i);
      const birth = findValue(row, BIRTH_KEYS, /(BIRTH|생년)/i);
      return [
        COMPANY_CODE,
        cleanText(row.I_EMPLOY_NO || row.emp_no),
        cleanText(row.N_EMPLOY_NAME || row.name),
        cleanText(row.dept),
        normalizePhone(phone),
        normalizeBirth(birth),
        cleanText(row.I_RETIRE_YN) === '1' ? '퇴사' : '재직',
      ];
    });

    const exportDir = path.join(process.cwd(), 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outputPath = path.join(exportDir, `employee_contacts_birthdays_${date}.csv`);
    const csv = '\uFEFF' + [headers, ...outputRows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(outputPath, csv, 'utf8');

    const phoneCount = outputRows.filter((row) => row[4]).length;
    const birthCount = outputRows.filter((row) => /^\d{8}$/.test(row[5])).length;
    console.log(`추출 완료: ${outputRows.length}명`);
    console.log(`휴대폰번호: ${phoneCount}건 / 생년월일 8자리: ${birthCount}건`);
    console.log(`파일: ${outputPath}`);
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((error) => {
  console.error(`추출 실패: ${error.message}`);
  process.exitCode = 1;
});

