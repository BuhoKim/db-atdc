/**
 * ==============================================================================
 * db-atdc 2026년도 전체 근태/출입/연차 일괄 적재 스크립트 (누락 방지 풀 스캔)
 * ==============================================================================
 * 
 * [사용 방법 1] MySQL 직접 연동 (사내망/VPN 접속 상태):
 *   node sync/sync_2026_full.js
 * 
 * [사용 방법 2] 캡스 엑셀/CSV 파일 일괄 적재:
 *   node sync/sync_2026_full.js --file="C:/경로/2026_출입기록.xlsx"
 * 
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const { createSyncSupabaseClient, COMPANY_CODE } = require('./supabaseClient');
const { loadSyncEnv } = require('./loadEnv');
const { mapEmployeeState } = require('./employeeState');

// 1. 환경 변수 로드
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env')
  ];

  envPaths.forEach((p) => {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      content.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const k = trimmed.substring(0, idx).trim();
          let v = trimmed.substring(idx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      });
    }
  });
}

loadSyncEnv();

const MY_COMPANY_CODE = COMPANY_CODE;

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || 'Prd-Hecto-WHR-Ext-NLB-8e82b66ed560637d.elb.ap-northeast-2.amazonaws.com',
  user: process.env.MYSQL_USER || 'secomncaps',
  password: process.env.MYSQL_PASSWORD || 'Hecto12#$',
  database: process.env.MYSQL_DATABASE || 'whr',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  connectTimeout: 20000,
};

const supabase = createSyncSupabaseClient();

function normalizeEmpNo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(MY_COMPANY_CODE) && digits.length >= 12) {
    return digits.slice(MY_COMPANY_CODE.length).slice(-8).replace(/^0+/, '') || digits.slice(-8);
  }
  return digits.slice(-8).replace(/^0+/, '') || digits.slice(-8);
}

function pickFirst(row, keys = []) {
  for (const k of keys) {
    const v = String(row?.[k] ?? '').trim();
    if (v) return v;
  }
  return '';
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

function chunkArray(array, size = 500) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// -----------------------------------------------------------------------------
// [모드 1] 엑셀 파일로부터 2026년 출입 기록 일괄 적재
// -----------------------------------------------------------------------------
async function syncFromExcelFile(filePath) {
  console.log(`\n📂 엑셀 파일 로딩 중: ${filePath}`);
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

  console.log(`✓ 엑셀에서 ${rows.length.toLocaleString()}행의 데이터를 읽었습니다.`);

  const records = [];
  const seen = new Set();

  for (const r of rows) {
    const empNoRaw = r['사번'] || r['사원번호'] || r['emp_no'] || r['I_EMPLOY_NO'] || r['IDNO'] || '';
    const dateRaw = r['일자'] || r['출입일자'] || r['e_date'] || r['날짜'] || '';
    const timeRaw = r['시각'] || r['출입시각'] || r['e_time'] || r['시간'] || '';
    const gate = r['게이트'] || r['단말기'] || r['gate'] || r['e_name'] || 'CAPS';

    const empNo = normalizeEmpNo(empNoRaw);
    const dateDigits = String(dateRaw).replace(/\D/g, '');
    const timeDigits = String(timeRaw).replace(/\D/g, '').padStart(6, '0');

    if (!empNo || dateDigits.length !== 8 || timeDigits.length < 6) continue;
    if (!dateDigits.startsWith('2026')) continue;

    const aTime = `${dateDigits}${timeDigits.slice(0, 6)}`;
    const sabun = `${MY_COMPANY_CODE}${empNo.padStart(8, '0')}`;
    const key = `${sabun}_${aTime}`;

    if (seen.has(key)) continue;
    seen.add(key);

    records.push({
      sabun,
      emp_no: empNo,
      card_no: r['카드번호'] || r['card_no'] || null,
      a_time: aTime,
      log_time: parseATime(aTime),
      eq_code: null,
      gate_name: String(gate).trim() || 'CAPS',
      flag1: null,
      event_type: '출입',
      source: 'caps',
      synced_at: new Date().toISOString(),
    });
  }

  console.log(`📦 2026년 정제된 고유 출입 기록: ${records.length.toLocaleString()}건`);
  if (records.length === 0) {
    console.log('⚠️ 2026년도 대상 데이터가 없습니다.');
    return;
  }

  const chunks = chunkArray(records, 500);
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { error } = await supabase.from('db_attendance').upsert(chunks[i], { onConflict: 'sabun,a_time' });
    if (error) throw error;
    inserted += chunks[i].length;
    const p = ((inserted / records.length) * 100).toFixed(1);
    process.stdout.write(`\r진행률: [${inserted.toLocaleString()} / ${records.length.toLocaleString()}] (${p}%) 완료...`);
  }

  console.log(`\n✅ db_attendance에 ${records.length.toLocaleString()}건 적재 완료!`);
}

// -----------------------------------------------------------------------------
// [모드 2] MySQL 원본 데이터베이스로부터 2026년 전체 일괄 동기화
// -----------------------------------------------------------------------------
async function syncEmployees(conn) {
  console.log('\n[1/3] 👥 2026년 재직 임직원 목록 조회 중...');

  const [rows] = await conn.execute(`
    SELECT
      e.*,
      e.I_EMPLOY_NO   AS emp_no,
      e.N_EMPLOY_NAME AS name,
      d.N_DEPT        AS dept,
      e.I_RETIRE_YN   AS retire_yn,
      e.I_STATE_CODE  AS state_code,
      e.D_STATE_DATE  AS state_date
    FROM hr_employee e
    LEFT JOIN hr_department d ON
      d.I_COMPANY = e.I_COMPANY
      AND d.I_DEPT = e.I_DEPT
    WHERE e.I_COMPANY = ?
    ORDER BY d.N_DEPT, e.N_EMPLOY_NAME
  `, [MY_COMPANY_CODE]);

  if (!rows || rows.length === 0) {
    console.log('⚠️ 조회된 임직원 데이터가 없습니다.');
    return 0;
  }

  const empNos = rows.map((row) => normalizeEmpNo(row.emp_no)).filter(Boolean);
  const { data: existingRows, error: existingError } = await supabase
    .from('db_employees')
    .select('emp_no,is_active,state_code,employment_status,state_date')
    .in('emp_no', empNos);
  if (existingError) throw new Error(`기존 재직상태 조회 실패: ${existingError.message}`);
  const existingByEmpNo = new Map((existingRows || []).map((row) => [row.emp_no, row]));

  console.log(`✓ MySQL에서 ${rows.length}명의 임직원(퇴사 상태 포함)을 조회했습니다.`);

  const batch = rows.map((row) => {
    const empNo = normalizeEmpNo(row.emp_no);
    const email = pickFirst(row, ['email', 'EMAIL', 'I_EMAIL', 'N_EMAIL', 'EMAIL_ADDRESS']);
    const loginId = pickFirst(row, ['login_id', 'LOGIN_ID', 'user_id', 'USER_ID', 'userid']) || (email.includes('@') ? email.split('@')[0] : '');

    const existing = existingByEmpNo.get(empNo);
    const item = {
      emp_no: empNo,
      name: String(row.name || '').trim(),
      dept: String(row.dept || '').trim() || '소속미지정',
      email: email && email.includes('@') ? email : null,
      login_id: loginId || null,
      company_code: MY_COMPANY_CODE,
      ...mapEmployeeState(row, existing),
      synced_at: new Date().toISOString(),
    };
    return item;
  }).filter((item) => Boolean(item.emp_no && item.name));

  const { error } = await supabase
    .from('db_employees')
    .upsert(batch, { onConflict: 'emp_no' });

  if (error) {
    throw new Error(`db_employees upsert 실패: ${error.message}`);
  }

  console.log(`✅ db_employees 테이블: ${batch.length}명 동기화 완료!`);
  return batch.length;
}

async function syncLeaves2026(conn) {
  console.log('\n[2/3] 🏖️ 2026년 전체 연차/휴가 내역 동기화 중...');

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
    LEFT JOIN hr_department d ON d.I_COMPANY = e.I_COMPANY AND d.I_DEPT = e.I_DEPT
    WHERE y.I_COMPANY = ?
      AND y.I_STATUS = '40'
      AND (y.D_START_DATE >= '20260101' OR y.D_END_DATE >= '20260101')
    ORDER BY y.D_START_DATE DESC
  `, [MY_COMPANY_CODE]);

  if (!rows || rows.length === 0) {
    console.log('⚠️ 2026년도 휴가 내역이 없습니다.');
    return 0;
  }

  console.log(`✓ MySQL에서 ${rows.length}건의 2026년 연차/휴가 내역을 조회했습니다.`);

  const leaves = rows.map((r) => ({
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

  const uniqueLeaves = [];
  const leaveSeen = new Set();
  for (const l of leaves) {
    const k = `${l.emp_no}_${l.start_date}_${l.leave_code}`;
    if (!leaveSeen.has(k)) {
      leaveSeen.add(k);
      uniqueLeaves.push(l);
    }
  }

  const leaveChunks = chunkArray(uniqueLeaves, 500);
  for (let i = 0; i < leaveChunks.length; i++) {
    const { error } = await supabase.from('db_leaves').upsert(leaveChunks[i], { onConflict: 'emp_no,start_date,leave_code' });
    if (error) {
      throw new Error(`db_leaves upsert 실패: ${error.message}`);
    }
  }
  console.log(`✅ db_leaves 테이블: ${uniqueLeaves.length}건 동기화 완료!`);
  return uniqueLeaves.length;
}

async function syncAttendance2026(conn) {
  console.log('\n[3/3] 🚪 2026년 전체 CAPS 출입 기록 전체 스캔 동기화 중 (2026-01-01 ~ 현재)...');

  // E_GROUP 필터 제거 및 다중 매칭(사번 12자리, 사번 8자리, 이름 매칭)으로 100% 전수 조회!
  const [rows] = await conn.execute(`
    SELECT
      e.I_EMPLOY_NO AS emp_no,
      e.N_EMPLOY_NAME AS name,
      d.N_DEPT      AS dept,
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
      AND (
        (e.I_COMPANY = LEFT(t.E_IDNO, 4) AND e.I_EMPLOY_NO = RIGHT(t.E_IDNO, 8))
        OR (e.I_EMPLOY_NO = t.E_IDNO)
        OR (t.E_NAME = e.N_EMPLOY_NAME AND t.E_NAME IS NOT NULL AND t.E_NAME <> '')
      )
    LEFT JOIN hr_department d ON
      d.I_COMPANY = e.I_COMPANY
      AND d.I_DEPT = e.I_DEPT
    WHERE COALESCE(e.I_RETIRE_YN, '0') <> '1'
      AND t.E_DATE >= '20260101'
    ORDER BY t.E_DATE ASC, t.E_TIME ASC
  `, [MY_COMPANY_CODE]);

  if (!rows || rows.length === 0) {
    console.log('⚠️ 2026년 출입 기록 데이터가 없습니다.');
    return 0;
  }

  console.log(`✓ MySQL에서 ${rows.length.toLocaleString()}건의 2026년 출입 기록을 조회했습니다.`);

  const attRecords = [];
  const attSeen = new Set();

  for (const r of rows) {
    const rawDate = String(r.e_date || '').replace(/\D/g, '');
    const rawTime = String(r.e_time || '').replace(/\D/g, '').padStart(6, '0');
    if (rawDate.length !== 8 || rawTime.length < 6) continue;

    const aTime = `${rawDate}${rawTime.slice(0, 6)}`;
    const empNo = normalizeEmpNo(r.emp_no || r.idno);
    const sabun = String(r.idno || '').trim() || `${MY_COMPANY_CODE}${String(empNo).padStart(8, '0')}`;
    const key = `${sabun}_${aTime}`;

    if (attSeen.has(key)) continue;
    attSeen.add(key);

    attRecords.push({
      sabun,
      emp_no: empNo || null,
      card_no: r.card_no ? String(r.card_no) : null,
      a_time: aTime,
      log_time: parseATime(aTime),
      eq_code: r.gate_code ? String(r.gate_code) : null,
      gate_name: buildGateName(r) || 'CAPS',
      flag1: null,
      event_type: '출입',
      source: 'caps',
      synced_at: new Date().toISOString(),
    });
  }

  console.log(`📦 2026년 정제된 고유 출입 기록: ${attRecords.length.toLocaleString()}건`);
  const attChunks = chunkArray(attRecords, 500);
  let inserted = 0;
  for (let i = 0; i < attChunks.length; i++) {
    const { error } = await supabase.from('db_attendance').upsert(attChunks[i], { onConflict: 'sabun,a_time' });
    if (error) {
      throw new Error(`db_attendance upsert 실패: ${error.message}`);
    }
    inserted += attChunks[i].length;
    const p = ((inserted / attRecords.length) * 100).toFixed(1);
    process.stdout.write(`\r진행률: [${inserted.toLocaleString()} / ${attRecords.length.toLocaleString()}] (${p}%) 완료...`);
  }

  console.log(`\n✅ db_attendance 테이블: ${attRecords.length.toLocaleString()}건 동기화 완료!`);
  return attRecords.length;
}

async function syncFromMySQL() {
  const mysql = require('mysql2/promise');
  let conn = null;
  const startTime = Date.now();

  try {
    console.log('================================================================');
    console.log('🚀 [db-atdc] 2026년도 전체 근태/출입/연차 MySQL 풀스캔 동기화 시작');
    console.log(`📌 법인 코드: ${MY_COMPANY_CODE}`);
    console.log(`📌 MySQL 호스트: ${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}`);
    console.log(`📌 Supabase URL: ${supabaseUrl}`);
    console.log('================================================================');

    conn = await mysql.createConnection(MYSQL_CONFIG);
    console.log('🔌 MySQL 데이터베이스 연결 성공!');

    const empCount = await syncEmployees(conn);
    const leaveCount = await syncLeaves2026(conn);
    const attCount = await syncAttendance2026(conn);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n================================================================');
    console.log('🎉 2026년 전체 데이터 일괄 동기화 성공!');
    console.log(`⏱️ 총 소요 시간: ${elapsed}초`);
    console.log(`👥 임직원: ${empCount}명`);
    console.log(`🏖️ 2026년 연차/휴가: ${leaveCount}건`);
    console.log(`🚪 2026년 출입 기록: ${attCount.toLocaleString()}건`);
    console.log('================================================================');
  } catch (e) {
    console.error('\n❌ MySQL 동기화 에러:', e.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));

  if (fileArg) {
    const filePath = fileArg.split('=')[1].replace(/^["']|["']$/g, '');
    await syncFromExcelFile(filePath);
  } else {
    await syncFromMySQL();
  }
}

main();
