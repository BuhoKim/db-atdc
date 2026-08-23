/**
 * 서버 장애 시 누락된 최근 3일 CAPS 출입기록을 일회성으로 보충한다.
 * 대상: 회사코드 1700 / CAPS 그룹 09
 * 임직원·연차 동기화는 수행하지 않는다.
 *
 * 실행:
 *   node sync/backfill_attendance_3days.js
 */

const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const { loadSyncEnv } = require('./loadEnv');

loadSyncEnv();

const COMPANY_CODE = '1700';
const CAPS_GROUP = '09';
const DAYS = 3;

const mysqlConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  connectTimeout: 15000,
};

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function shiftDateKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-');
}

function compactDate(key) {
  return key.replace(/-/g, '');
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
  const text = String(value || '');
  if (text.length < 14) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+09:00`;
}

function log(message) {
  console.log(`[CAPS 3일 보충] [${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}] ${message}`);
}

async function main() {
  const today = dateKey();
  const from = shiftDateKey(today, -DAYS);
  const fromStr = compactDate(from);
  const toStr = compactDate(today);

  log(`조회 시작: ${from} ~ ${today} (회사 ${COMPANY_CODE}, 그룹 ${CAPS_GROUP})`);

  let conn;
  try {
    conn = await mysql.createConnection(mysqlConfig);
    const [rows] = await conn.execute(`
      SELECT
        e.I_EMPLOY_NO AS emp_no,
        t.E_IDNO      AS idno,
        t.E_CARD      AS card_no,
        t.E_DATE      AS e_date,
        t.E_TIME      AS e_time,
        t.G_ID        AS gate_code,
        t.E_GROUP     AS e_group,
        t.E_MODE      AS e_mode,
        t.E_TYPE      AS e_type,
        t.E_RESULT    AS e_result
      FROM tenter t
      INNER JOIN hr_employee e ON
        e.I_COMPANY = ?
        AND t.E_IDNO IS NOT NULL
        AND t.E_IDNO <> ''
        AND e.I_COMPANY = LEFT(t.E_IDNO, 4)
        AND e.I_EMPLOY_NO = RIGHT(t.E_IDNO, 8)
      INNER JOIN hr_department d ON
        d.I_COMPANY = ?
        AND d.I_DEPT = e.I_DEPT
      WHERE COALESCE(e.I_RETIRE_YN, '0') <> '1'
        AND t.E_GROUP = ?
        AND t.E_DATE >= ?
        AND t.E_DATE <= ?
      ORDER BY t.E_DATE ASC, t.E_TIME ASC
    `, [COMPANY_CODE, COMPANY_CODE, CAPS_GROUP, fromStr, toStr]);

    const records = (rows || []).map((row) => {
      const empNo = normalizeEmpNo(row.emp_no || row.idno);
      const aTime = `${String(row.e_date || '').replace(/\D/g, '').slice(0, 8)}${String(row.e_time || '').replace(/\D/g, '').slice(0, 6).padStart(6, '0')}`;
      const gateParts = [row.e_group, row.e_mode, row.e_type, row.e_result]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
      return {
        sabun: String(row.idno || '').trim() || `${COMPANY_CODE}${String(empNo).padStart(8, '0')}`,
        emp_no: empNo || null,
        card_no: row.card_no ? String(row.card_no) : null,
        a_time: aTime,
        log_time: parseATime(aTime),
        eq_code: row.gate_code ? String(row.gate_code) : null,
        gate_name: gateParts.join(' / ') || 'CAPS',
        flag1: null,
        event_type: '출입',
        source: 'caps',
        synced_at: new Date().toISOString(),
      };
    }).filter((row) => row.emp_no && /^\d{14}$/.test(row.a_time));

    let total = 0;
    for (let index = 0; index < records.length; index += 500) {
      const batch = records.slice(index, index + 500);
      const { error } = await supabase
        .from('db_attendance')
        .upsert(batch, { onConflict: 'sabun,a_time' });
      if (error) throw new Error(`Supabase 저장 실패: ${error.message}`);
      total += batch.length;
    }

    log(`보충 완료: 원본 ${rows?.length || 0}건 / 저장 ${total}건`);
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((error) => {
  log(`실패: ${error.message}`);
  process.exitCode = 1;
});

