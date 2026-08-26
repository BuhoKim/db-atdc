/**
 * ==============================================================================
 * db-atdc 서버PC 전용 단독 동기화 스크립트 (sync_server.js)
 * ==============================================================================
 * 
 * [동기화 대상 (AWS MySQL -> Supabase)]
 * 1. 임직원 리스트  : hr_employee      -> db_employees
 * 2. 출입기록 (CAPS): tenter           -> db_attendance
 * 3. 연차사용내역   : hr_yuncha_use    -> db_leaves
 * 
 * [적용 설정]
 * - 법인 코드 (MY_COMPANY_CODE): 1700
 * - 캡스 그룹 (CAPS_E_GROUP)   : 09
 * 
 * [실행 방법]
 *   1회 즉시 실행:  node sync_server.js --once
 *   데몬 주기 실행: node sync_server.js (기본 10분 주기)
 *   PM2 백그라운드: pm2 start sync_server.js --name db-atdc-sync
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const {
  getAttendanceWindow,
  saveAttendanceCheckpoint,
  formatAttendanceMetrics,
} = require('./sync/attendanceIncremental');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------------------
// 1. 환경변수 및 기본 설정 (.env 자동 탐색 + Fallback 기본값)
// ------------------------------------------------------------------------------
function loadEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '.env.local'),
    path.join(__dirname, 'sync', '.env'),
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '.env.local'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      });
    }
  }
}

loadEnv();

// 설정값 매핑
const CONFIG = {
  // MySQL 원본 DB (읽기 전용)
  mysql: {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
    connectTimeout: 20000,
  },

  // Supabase (저장소)
  supabase: {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // 법인 및 캡스 필터
  // 드림베이 전용: 환경변수 오염으로 1600 자료가 섞이지 않도록 고정한다.
  companyCode: '1700',
  capsGroup: '09',
  // 운영 동기화 주기는 항상 10분이다. 이전 PM2 환경값은 사용하지 않는다.
  syncIntervalMs: SYNC_INTERVAL_MS,
  attendanceOverlapMinutes: parseInt(process.env.ATTENDANCE_OVERLAP_MINUTES, 10) || 5,
  attendanceInitialLookbackMinutes: parseInt(process.env.ATTENDANCE_INITIAL_LOOKBACK_MINUTES, 10) || 60,
};

// Supabase 키 유효성 검사 및 안내
if (!CONFIG.supabase.serviceRoleKey) {
  console.error('\n❌ [ERROR] Supabase Service Role Key가 설정되지 않았습니다.');
  console.error('👉 해결 방법: 프로젝트 루트에 .env.local 파일 또는 sync/.env 파일을 생성해 주세요.\n');
  process.exit(1);
}

// Supabase Admin 클라이언트 생성
const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ------------------------------------------------------------------------------
// 2. 헬퍼 함수
// ------------------------------------------------------------------------------
function timestamp() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hour24 = kst.getUTCHours();
  const period = hour24 < 12 ? '오전' : '오후';
  return `${kst.getUTCFullYear()}. ${kst.getUTCMonth() + 1}. ${kst.getUTCDate()}. ${period} ${hour24 % 12 || 12}:${String(kst.getUTCMinutes()).padStart(2, '0')}:${String(kst.getUTCSeconds()).padStart(2, '0')}`;
}

function log(level, message, detail = '') {
  const prefix = { INFO: '✅', SUCCESS: '✅', WARN: '⚠️', ERROR: '❌' }[level] || 'ℹ️';
  console.log(`[${timestamp()}] ${prefix} ${message}${detail ? ` | ${detail}` : ''}`);
}

function normalizeEmpNo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(CONFIG.companyCode) && digits.length >= 12) {
    return digits.slice(CONFIG.companyCode.length).slice(-8).replace(/^0+/, '') || digits.slice(-8);
  }
  return digits.slice(-8).replace(/^0+/, '') || digits.slice(-8);
}

function parseATime(aTime) {
  if (!aTime || String(aTime).length < 14) return null;
  const s = String(aTime);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}T${s.substring(8, 10)}:${s.substring(10, 12)}:${s.substring(12, 14)}+09:00`;
}

function buildGateName(row) {
  const parts = [row.e_group, row.e_mode, row.e_type, row.e_result]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'CAPS';
}

function getKstDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getKstHour() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date()));
}

async function shouldSyncEmployeesToday() {
  if (getKstHour() < 8) return { due: false, reason: '오전 8시 이전' };
  const day = getKstDateKey();
  const from = new Date(`${day}T00:00:00+09:00`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('db_employees')
    .select('emp_no')
    .eq('company_code', CONFIG.companyCode)
    .gte('synced_at', from.toISOString())
    .lt('synced_at', to.toISOString())
    .limit(1);
  if (error) throw new Error(`임직원 동기화 상태 조회 실패: ${error.message}`);
  return data?.length
    ? { due: false, reason: '오늘 이미 동기화됨' }
    : { due: true, reason: '미동기화' };
}

// ------------------------------------------------------------------------------
// 3. 임직원 마스터 동기화 (hr_employee -> db_employees)
// ------------------------------------------------------------------------------
async function syncEmployees(conn) {
  const [rows] = await conn.execute(`
    SELECT
      e.*,
      e.I_EMPLOY_NO   AS emp_no,
      e.N_EMPLOY_NAME AS name,
      d.N_DEPT        AS dept,
      e.I_RETIRE_YN   AS retire_yn
    FROM hr_employee e
    LEFT JOIN hr_department d ON
      d.I_COMPANY = e.I_COMPANY
      AND d.I_DEPT = e.I_DEPT
    WHERE e.I_COMPANY = ?
    ORDER BY d.N_DEPT, e.N_EMPLOY_NAME
  `, [CONFIG.companyCode]);

  if (!rows || rows.length === 0) return 0;

  const empNos = rows.map((row) => normalizeEmpNo(row.emp_no)).filter(Boolean);
  const { data: existingRows, error: existingError } = await supabase
    .from('db_employees')
    .select('emp_no,is_active')
    .eq('company_code', CONFIG.companyCode)
    .in('emp_no', empNos);
  if (existingError) throw new Error(`기존 재직상태 조회 실패: ${existingError.message}`);
  const existingByEmpNo = new Map((existingRows || []).map((row) => [row.emp_no, row]));

  function pickFirst(row, keys = []) {
    for (const k of keys) {
      const v = String(row?.[k] ?? '').trim();
      if (v) return v;
    }
    return '';
  }

  const batch = rows.map((row) => {
    const empNo = normalizeEmpNo(row.emp_no);
    const email = pickFirst(row, ['email', 'EMAIL', 'I_EMAIL', 'N_EMAIL', 'EMAIL_ADDRESS']);
    const loginId = pickFirst(row, ['login_id', 'LOGIN_ID', 'user_id', 'USER_ID', 'userid']) || (email.includes('@') ? email.split('@')[0] : '');

    const sourceRetired = String(row.retire_yn ?? '').trim() === '1';
    const existing = existingByEmpNo.get(empNo);
    const item = {
      emp_no: empNo,
      name: String(row.name || '').trim(),
      dept: String(row.dept || '').trim() || '소속미지정',
      email: email && email.includes('@') ? email : null,
      login_id: loginId || null,
      company_code: CONFIG.companyCode,
      is_active: sourceRetired ? false : (existing ? existing.is_active !== false : true),
      synced_at: new Date().toISOString(),
    };
    return item;
  }).filter((item) => Boolean(item.emp_no));

  const { error } = await supabase
    .from('db_employees')
    .upsert(batch, { onConflict: 'emp_no' });

  if (error) {
    throw new Error(`db_employees upsert 실패: ${error.message}`);
  }

  return batch.length;
}

// ------------------------------------------------------------------------------
// 4. 연차 사용내역 동기화 (hr_yuncha_use -> db_leaves)
// ------------------------------------------------------------------------------
async function syncLeaves(conn) {
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const fromStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const toStr = `${toDate.getFullYear()}${String(toDate.getMonth() + 1).padStart(2, '0')}${String(toDate.getDate()).padStart(2, '0')}`;

  const [rows] = await conn.execute(`
    SELECT
      y.I_EMPLOY_NO                AS emp_no,
      e.N_EMPLOY_NAME              AS emp_name,
      y.D_START_DATE               AS start_date,
      y.D_END_DATE                 AS end_date,
      y.I_CODE                     AS leave_code,
      CAST(y.I_CODE AS CHAR)       AS leave_name,
      CAST(y.O_ANNLEV_CNT AS CHAR) AS leave_days,
      y.I_STATUS                   AS status
    FROM hr_yuncha_use y
    INNER JOIN hr_employee e ON e.I_COMPANY = y.I_COMPANY AND e.I_EMPLOY_NO = y.I_EMPLOY_NO
    INNER JOIN hr_department d ON d.I_COMPANY = e.I_COMPANY AND d.I_DEPT = e.I_DEPT
    WHERE y.I_COMPANY = ?
      AND y.I_STATUS = '40'
      AND y.D_START_DATE <= ?
      AND y.D_END_DATE >= ?
  `, [CONFIG.companyCode, toStr, fromStr]);

  if (!rows || rows.length === 0) return 0;

  const records = rows.map((r) => ({
    emp_no: normalizeEmpNo(r.emp_no),
    emp_name: String(r.emp_name || '').trim(),
    start_date: String(r.start_date || '').replace(/\D/g, '').slice(0, 8),
    end_date: String(r.end_date || r.start_date || '').replace(/\D/g, '').slice(0, 8),
    leave_code: String(r.leave_code || '연차'),
    leave_name: String(r.leave_name || '연차'),
    leave_days: parseFloat(r.leave_days) || 1,
    status: String(r.status || '40'),
    synced_at: new Date().toISOString(),
  })).filter((item) => Boolean(item.emp_no && item.start_date));

  const uniqueRecords = [];
  const seen = new Set();
  for (const r of records) {
    const key = `${r.emp_no}_${r.start_date}_${r.leave_code}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRecords.push(r);
    }
  }

  const { error } = await supabase
    .from('db_leaves')
    .upsert(uniqueRecords, { onConflict: 'emp_no,start_date,leave_code' });

  if (error) {
    throw new Error(`db_leaves upsert 실패: ${error.message}`);
  }

  return uniqueRecords.length;
}

// ------------------------------------------------------------------------------
// 5. CAPS 출입기록 동기화 (tenter -> db_attendance)
// ------------------------------------------------------------------------------
async function syncCapsAttendance(conn) {
  const now = new Date();
  const window = await getAttendanceWindow({
    supabase,
    companyCode: CONFIG.companyCode,
    source: 'caps',
    now,
    overlapMinutes: CONFIG.attendanceOverlapMinutes,
    initialLookbackMinutes: CONFIG.attendanceInitialLookbackMinutes,
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
      AND (t.E_DATE > ? OR REPLACE(CAST(t.E_TIME AS CHAR), ':', '') >= ?)
      AND (t.E_DATE < ? OR REPLACE(CAST(t.E_TIME AS CHAR), ':', '') <= ?)
    ORDER BY t.E_DATE DESC, t.E_TIME DESC
  `, [CONFIG.companyCode, CONFIG.companyCode, CONFIG.capsGroup, window.fromDateStr, window.toDateStr, window.fromDateStr, window.fromTimeStr, window.toDateStr, window.toTimeStr]);

  const queryBytes = Buffer.byteLength(JSON.stringify(rows || []), 'utf8');
  const queryElapsed = Date.now() - queryStartedAt;

  if (!rows || rows.length === 0) {
    await saveAttendanceCheckpoint({ supabase, companyCode: CONFIG.companyCode, source: 'caps', window, rowCount: 0, queryBytes, upsertBytes: 0 });
    log('INFO', formatAttendanceMetrics({ source: 'CAPS', rowCount: 0, queryBytes, queryMs: queryElapsed, upsertBytes: 0, checkpointAt: window.to.toISOString(), origin: window.cursorOrigin }));
    return 0;
  }

  const batchSize = 500;
  let total = 0;
  let upsertBytes = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((row) => {
      const empNo = normalizeEmpNo(row.emp_no || row.idno);
      const sabun = String(row.idno || '').trim() || `${CONFIG.companyCode}${String(empNo).padStart(8, '0')}`;
      const aTime = `${String(row.e_date || '').replace(/\D/g, '').slice(0, 8)}${String(row.e_time || '').replace(/\D/g, '').slice(0, 6).padStart(6, '0')}`;

      return {
        sabun,
        emp_no: empNo || null,
        card_no: row.card_no ? String(row.card_no) : null,
        a_time: aTime,
        log_time: parseATime(aTime),
        eq_code: row.gate_code ? String(row.gate_code) : null,
        gate_name: buildGateName(row) || 'CAPS',
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

  await saveAttendanceCheckpoint({ supabase, companyCode: CONFIG.companyCode, source: 'caps', window, rowCount: rows.length, queryBytes, upsertBytes });
  log('INFO', formatAttendanceMetrics({ source: 'CAPS', rowCount: rows.length, queryBytes, queryMs: queryElapsed, upsertBytes, checkpointAt: window.to.toISOString(), origin: window.cursorOrigin }));

  return total;
}

// ------------------------------------------------------------------------------
// 6. 전체 동기화 사이클 실행기
// ------------------------------------------------------------------------------
async function executeFullSync() {
  if (executeFullSync.inProgress) {
    log('WARN', '동기화 건너뜀 (이전 동기화 진행 중)');
    return;
  }

  executeFullSync.inProgress = true;
  const startTime = Date.now();
  log('INFO', '동기화 시작');

  let conn = null;
  try {
    conn = await mysql.createConnection(CONFIG.mysql);

    const employeeStatus = await shouldSyncEmployeesToday();
    if (employeeStatus.due) {
      const empCount = await syncEmployees(conn);
      log('INFO', `임직원 정보 동기화 완료 (${empCount}건)`);
    } else {
      log('INFO', `임직원 정보 동기화 건너뜀 (${employeeStatus.reason})`);
    }

    const leaveCount = await syncLeaves(conn);
    const capsCount = await syncCapsAttendance(conn);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('SUCCESS', `동기화 완료 (${elapsed}s) | 캡스 ${capsCount}건 | 연차 ${leaveCount}건`);
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ERROR', `동기화 실패 (${elapsed}s)`, error.message);
  } finally {
    executeFullSync.inProgress = false;
    if (conn) {
      try {
        await conn.end();
      } catch (e) {}
    }
  }
}

function millisecondsUntilNextEightKst() {
  const now = Date.now();
  const kstNow = new Date(now + 9 * 60 * 60 * 1000);
  let target = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
    -1, 0, 0,
  );
  if (target <= now + 1000) target += 24 * 60 * 60 * 1000;
  return target - now;
}

function scheduleDailyEightSync() {
  setTimeout(async () => {
    await executeFullSync();
    scheduleDailyEightSync();
  }, millisecondsUntilNextEightKst());
}

// ------------------------------------------------------------------------------
// 7. 메인 실행 진입점
// ------------------------------------------------------------------------------
async function main() {
  const isOnce = process.argv.includes('--once') || process.argv.includes('-1');

  if (isOnce) {
    await executeFullSync();
    process.exit(0);
  } else {
    await executeFullSync();
    setInterval(executeFullSync, CONFIG.syncIntervalMs);
    scheduleDailyEightSync();
  }
}

main();
