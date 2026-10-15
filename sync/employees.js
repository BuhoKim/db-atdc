/**
 * ================================================================
 * db-atdc 임직원 마스터 동기화 - hr_employee -> db_employees
 * ================================================================
 */

const { loadSyncEnv } = require('./loadEnv');
const mysql = require('mysql2/promise');
const { createSyncSupabaseClient, COMPANY_CODE } = require('./supabaseClient');

loadSyncEnv();

const MY_COMPANY_CODE = COMPANY_CODE;

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

function pickFirst(row, keys = []) {
  for (const k of keys) {
    const v = String(row?.[k] ?? '').trim();
    if (v) return v;
  }
  return '';
}

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
  `, [MY_COMPANY_CODE]);

  if (!rows || rows.length === 0) return 0;

  const empNos = rows.map((row) => normalizeEmpNo(row.emp_no)).filter(Boolean);
  const { data: existingRows, error: existingError } = await supabase
    .from('db_employees')
    .select('emp_no,is_active')
    .in('emp_no', empNos);
  if (existingError) throw new Error(`기존 재직상태 조회 실패: ${existingError.message}`);
  const existingByEmpNo = new Map((existingRows || []).map((row) => [row.emp_no, row]));

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
      company_code: MY_COMPANY_CODE,
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

async function runSync() {
  console.log(`[db-atdc] 임직원 동기화 시작 (법인: ${MY_COMPANY_CODE})`);
  let conn = null;
  try {
    conn = await mysql.createConnection(MYSQL_CONFIG);
    const count = await syncEmployees(conn);
    console.log(`[db-atdc] 임직원 동기화 완료: ${count}명`);
  } catch (e) {
    console.error('[db-atdc] 임직원 동기화 오류:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}

if (require.main === module) {
  runSync();
}

module.exports = { syncEmployees, runSync };
