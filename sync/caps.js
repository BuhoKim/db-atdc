/**
 * ================================================================
 * db-atdc CAPS 출입기록 동기화 - tenter MySQL -> Supabase db_attendance
 * 회사 코드: 1700 / 그룹 필터: 09
 * ================================================================
 */

const { loadSyncEnv } = require('./loadEnv');
const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const {
  getAttendanceWindow,
  saveAttendanceCheckpoint,
  formatBytes,
} = require('./attendanceIncremental');

loadSyncEnv();

const MY_COMPANY_CODE = process.env.MY_COMPANY_CODE || '1700';
const E_GROUP_FILTER = process.env.CAPS_E_GROUP || '09';
const ATTENDANCE_OVERLAP_MINUTES = parseInt(process.env.ATTENDANCE_OVERLAP_MINUTES, 10) || 10;
const ATTENDANCE_INITIAL_LOOKBACK_MINUTES = parseInt(process.env.ATTENDANCE_INITIAL_LOOKBACK_MINUTES, 10) || 60;

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  connectTimeout: 15000,
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const GATE_MAPPING = {
  '4000': 'CAPS',
  '4004': 'CAPS',
};

function parseATime(aTime) {
  if (!aTime || String(aTime).length < 14) return null;
  const s = String(aTime);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}T${s.substring(8, 10)}:${s.substring(10, 12)}:${s.substring(12, 14)}+09:00`;
}

function log(level, msg, detail = '') {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const prefix = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' }[level] || 'INFO';
  console.log(`[db-atdc-caps] [${now}] ${prefix} ${msg}${detail ? ` | ${detail}` : ''}`);
}

function normalizeEmpNo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(MY_COMPANY_CODE) && digits.length >= 12) {
    return digits.slice(MY_COMPANY_CODE.length).slice(-8).replace(/^0+/, '') || digits.slice(-8);
  }
  return digits.slice(-8).replace(/^0+/, '') || digits.slice(-8);
}

function buildGateName(row) {
  const parts = [row.e_group, row.e_mode, row.e_type, row.e_result]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '출입';
}

async function syncAttendance(conn) {
  const now = new Date();
  const window = await getAttendanceWindow({
    supabase,
    companyCode: MY_COMPANY_CODE,
    source: 'caps',
    now,
    overlapMinutes: ATTENDANCE_OVERLAP_MINUTES,
    initialLookbackMinutes: ATTENDANCE_INITIAL_LOOKBACK_MINUTES,
  });
  const queryStartedAt = Date.now();

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
      AND (t.E_DATE > ? OR LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0') >= ?)
      AND (t.E_DATE < ? OR LPAD(REPLACE(CAST(t.E_TIME AS CHAR), ':', ''), 6, '0') <= ?)
    ORDER BY t.E_DATE DESC, t.E_TIME DESC
  `, [MY_COMPANY_CODE, MY_COMPANY_CODE, E_GROUP_FILTER, window.fromDateStr, window.toDateStr, window.fromDateStr, window.fromTimeStr, window.toDateStr, window.toTimeStr]);

  const queryBytes = Buffer.byteLength(JSON.stringify(rows || []), 'utf8');
  log('INFO', `CAPS 증분 조회 ${window.from.toISOString()} ~ ${window.to.toISOString()}`, `${rows?.length || 0}건 | 약 ${formatBytes(queryBytes)} | ${Date.now() - queryStartedAt}ms | 기준 ${window.cursorOrigin} / 겹침 ${window.overlapMinutes}분`);
  if (!rows || rows.length === 0) {
    await saveAttendanceCheckpoint({ supabase, companyCode: MY_COMPANY_CODE, source: 'caps', window, rowCount: 0, queryBytes });
    log('INFO', '동기화 대상 CAPS 기록 없음');
    return 0;
  }

  const batchSize = 500;
  let total = 0;
  let upsertBytes = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((row) => {
      const empNo = normalizeEmpNo(row.emp_no || row.idno);
      const sabun = String(row.idno || '').trim() || `${MY_COMPANY_CODE}${String(empNo).padStart(8, '0')}`;
      const aTime = `${String(row.e_date || '').replace(/\D/g, '').slice(0, 8)}${String(row.e_time || '').replace(/\D/g, '').slice(0, 6).padStart(6, '0')}`;

      return {
        sabun,
        emp_no: empNo || null,
        card_no: row.card_no ? String(row.card_no) : null,
        a_time: aTime,
        log_time: parseATime(aTime),
        eq_code: row.gate_code ? String(row.gate_code) : null,
        gate_name: buildGateName(row) || GATE_MAPPING[String(row.gate_code || '')] || '출입',
        flag1: null,
        event_type: '출입',
        source: 'caps',
        synced_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from('db_attendance')
      .upsert(batch, { onConflict: 'sabun,a_time' });

    if (error) {
      throw new Error(`db_attendance upsert 실패: ${error.message}`);
    }

    total += batch.length;
    upsertBytes += Buffer.byteLength(JSON.stringify(batch), 'utf8');
  }

  await saveAttendanceCheckpoint({ supabase, companyCode: MY_COMPANY_CODE, source: 'caps', window, rowCount: rows.length, queryBytes, upsertBytes });
  log('INFO', `CAPS 저장 완료 ${total}건`, `예상 Supabase 전송량 약 ${formatBytes(upsertBytes)}`);

  return total;
}

async function runSync() {
  const startedAt = Date.now();
  log('INFO', `CAPS 동기화 시작 (법인: ${MY_COMPANY_CODE}, 그룹: ${E_GROUP_FILTER})`);

  let conn = null;
  try {
    conn = await mysql.createConnection(MYSQL_CONFIG);
    const count = await syncAttendance(conn);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log('INFO', `동기화 완료 (${elapsed}s)`, `출입기록 ${count}건`);
  } catch (error) {
    log('ERROR', 'CAPS 동기화 실패', error.message);
  } finally {
    if (conn) await conn.end();
  }
}

if (require.main === module) {
  runSync();
}

module.exports = { syncAttendance, runSync };
