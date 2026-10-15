/**
 * 최근 7일 CAPS 출입기록 일회성 보충
 * 기본 범위: 한국시간 오늘 기준 7일 전 00:00:00 ~ 현재
 * 실행: node backfill_attendance_7days.js
 * 확인만: node backfill_attendance_7days.js --dry-run
 */

const mysql = require('mysql2/promise');
const { createSyncSupabaseClient, COMPANY_CODE, CAPS_GROUP } = require('./supabaseClient');
const { loadSyncEnv } = require('./loadEnv');

loadSyncEnv();

const GROUP_CODE = CAPS_GROUP;
const DAYS = Number(process.env.BACKFILL_DAYS || 7);
const DRY_RUN = process.argv.includes('--dry-run');

const mysqlConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT || 3306),
  connectTimeout: 20000,
};

const supabase = createSyncSupabaseClient();

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    time: `${parts.hour}${parts.minute}${parts.second}`,
  };
}

function compactDate(year, month, day) {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function getWindow() {
  const now = kstParts();
  const start = new Date(Date.UTC(now.year, now.month - 1, now.day - DAYS));
  return {
    fromDate: compactDate(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    fromTime: '000000',
    toDate: compactDate(now.year, now.month, now.day),
    toTime: now.time,
  };
}

function normalizeEmpNo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(COMPANY_CODE) && digits.length >= 12) {
    return digits.slice(COMPANY_CODE.length).slice(-8).replace(/^0+/, '') || digits.slice(-8);
  }
  return digits.slice(-8).replace(/^0+/, '') || digits.slice(-8);
}

function parseATime(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 14) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+09:00`;
}

function buildGateName(row) {
  const parts = [row.e_group, row.e_mode, row.e_type, row.e_result]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : '출입';
}

async function main() {
  const window = getWindow();
  let conn = null;
  try {
    conn = await mysql.createConnection(mysqlConfig);
    const [rows] = await conn.execute(`
      SELECT
        e.I_EMPLOY_NO AS emp_no,
        t.E_IDNO AS idno,
        t.E_CARD AS card_no,
        t.E_DATE AS e_date,
        t.E_TIME AS e_time,
        t.G_ID AS gate_code,
        t.E_GROUP AS e_group,
        t.E_MODE AS e_mode,
        t.E_TYPE AS e_type,
        t.E_RESULT AS e_result
      FROM tenter t
      INNER JOIN hr_employee e ON
        e.I_COMPANY = ?
        AND t.E_IDNO IS NOT NULL
        AND t.E_IDNO <> ''
        AND e.I_COMPANY = LEFT(t.E_IDNO, 4)
        AND e.I_EMPLOY_NO = RIGHT(t.E_IDNO, 8)
      INNER JOIN hr_department d ON d.I_COMPANY = ? AND d.I_DEPT = e.I_DEPT
      WHERE COALESCE(e.I_RETIRE_YN, '0') <> '1'
        AND t.E_GROUP = ?
        AND t.E_DATE >= ?
        AND t.E_DATE <= ?
        AND (t.E_DATE > ? OR LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0') >= ?)
        AND (t.E_DATE < ? OR LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0') <= ?)
      ORDER BY t.E_DATE ASC, t.E_TIME ASC
    `, [COMPANY_CODE, COMPANY_CODE, GROUP_CODE, window.fromDate, window.toDate, window.fromDate, window.fromTime, window.toDate, window.toTime]);

    const records = rows.map((row) => {
      const empNo = normalizeEmpNo(row.emp_no || row.idno);
      const aTime = `${String(row.e_date || '').replace(/\D/g, '').slice(0, 8)}${String(row.e_time || '').replace(/\D/g, '').slice(0, 6).padStart(6, '0')}`;
      return {
        sabun: String(row.idno || '').trim() || `${COMPANY_CODE}${String(empNo).padStart(8, '0')}`,
        emp_no: empNo || null,
        card_no: row.card_no ? String(row.card_no) : null,
        a_time: aTime,
        log_time: parseATime(aTime),
        eq_code: row.gate_code ? String(row.gate_code) : null,
        gate_name: buildGateName(row),
        flag1: null,
        event_type: '출입',
        source: 'caps',
        synced_at: new Date().toISOString(),
      };
    });

    const resultCounts = records.reduce((result, row) => {
      const key = row.gate_name.split(' / ').at(-1) || '(NULL)';
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});

    if (!DRY_RUN) {
      for (let index = 0; index < records.length; index += 500) {
        const { error } = await supabase
          .from('db_attendance')
          .upsert(records.slice(index, index + 500), { onConflict: 'sabun,a_time' });
        if (error) throw new Error(`db_attendance upsert 실패: ${error.message}`);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      dryRun: DRY_RUN,
      company: COMPANY_CODE,
      group: GROUP_CODE,
      from: `${window.fromDate}${window.fromTime}`,
      to: `${window.toDate}${window.toTime}`,
      sourceRows: rows.length,
      upsertedRows: DRY_RUN ? 0 : records.length,
      resultCounts,
    }, null, 2));
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((error) => {
  console.error(`최근 7일 출입기록 보충 실패: ${error.message}`);
  process.exitCode = 1;
});
