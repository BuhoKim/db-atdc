/**
 * ================================================================
 * db-atdc 연차/휴가 내역 동기화 - hr_yuncha_use -> db_leaves
 * ================================================================
 */

const { loadSyncEnv } = require('./loadEnv');
const mysql = require('mysql2/promise');
const { createSyncSupabaseClient, COMPANY_CODE } = require('./supabaseClient');

loadSyncEnv();

const MY_COMPANY_CODE = COMPANY_CODE;
const APPROVED_STATUS = '40';

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  connectTimeout: 15000,
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

async function syncLeaves(conn) {
  const now = new Date();
  const fromMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const fromStr = `${fromMonth.getFullYear()}${String(fromMonth.getMonth() + 1).padStart(2, '0')}01`;

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
      AND y.D_END_DATE >= ?
  `, [MY_COMPANY_CODE, fromStr]);

  const approvedRows = (rows || []).filter((row) => String(row.status || '').trim() === APPROVED_STATUS);

  const records = approvedRows.map((r) => ({
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

  if (uniqueRecords.length > 0) {
    const { error } = await supabase
      .from('db_leaves')
      .upsert(uniqueRecords, { onConflict: 'emp_no,start_date,leave_code' });

    if (error) {
      throw new Error(`db_leaves upsert 실패: ${error.message}`);
    }
  }

  // 기존 db_leaves에는 승인 후 취소된 휴가가 남을 수 있다.
  // 원본 조회가 성공한 뒤, 같은 동기화 범위에서 승인 목록에 없는 기록을 제거한다.
  const { data: existingRows, error: existingError } = await supabase
    .from('db_leaves')
    .select('emp_no,start_date,end_date,leave_code')
    .or(`start_date.gte.${fromStr},end_date.gte.${fromStr}`);

  if (existingError) {
    throw new Error(`기존 db_leaves 조회 실패: ${existingError.message}`);
  }

  const approvedKeys = new Set(uniqueRecords.map((r) => `${r.emp_no}|${r.start_date}|${r.leave_code}`));
  const staleKeys = (existingRows || [])
    .map((row) => ({
      emp_no: String(row.emp_no || '').trim(),
      start_date: String(row.start_date || '').replace(/\D/g, '').slice(0, 8),
      leave_code: String(row.leave_code || '').trim(),
    }))
    .filter((row) => row.emp_no && row.start_date && row.leave_code)
    .filter((row) => !approvedKeys.has(`${row.emp_no}|${row.start_date}|${row.leave_code}`));

  let deletedCount = 0;
  for (let index = 0; index < staleKeys.length; index += 50) {
    const batch = staleKeys.slice(index, index + 50);
    const filters = batch.map((row) => `and(emp_no.eq.${row.emp_no},start_date.eq.${row.start_date},leave_code.eq.${row.leave_code})`);
    const { error: deleteError } = await supabase
      .from('db_leaves')
      .delete()
      .or(filters.join(','));
    if (deleteError) {
      throw new Error(`취소 휴가 삭제 실패: ${deleteError.message}`);
    }
    deletedCount += batch.length;
  }

  console.log(`[db-atdc] 연차 원본 ${rows?.length || 0}건 | 승인 ${uniqueRecords.length}건 | 취소/삭제 정리 ${deletedCount}건`);
  return uniqueRecords.length;
}

async function runSync() {
  console.log(`[db-atdc] 연차 동기화 시작 (법인: ${MY_COMPANY_CODE})`);
  let conn = null;
  try {
    conn = await mysql.createConnection(MYSQL_CONFIG);
    const count = await syncLeaves(conn);
    console.log(`[db-atdc] 연차 동기화 완료: ${count}건`);
  } catch (e) {
    console.error('[db-atdc] 연차 동기화 오류:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}

if (require.main === module) {
  runSync();
}

module.exports = { syncLeaves, runSync };
