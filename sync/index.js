/** Company 1700 / CAPS 09. All legacy entry points use this worker. */
const { loadSyncEnv } = require('./loadEnv');
const { createSyncSupabaseClient, COMPANY_CODE } = require('./supabaseClient');
const { acquireWorkerLock } = require('./workerLock');
const mysql = require('mysql2/promise');

const SYNC_INTERVAL_MS = 30 * 60 * 1000;

function log(message) {
  console.log(`[${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}] ${message}`);
}

async function shouldSyncEmployeesToday(supabase, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000);
  if (kst.getUTCHours() < 8) return { due: false, reason: '오전 8시 이전' };
  const start = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), -9));
  const end = new Date(start.getTime() + 86400000);
  const { data, error } = await supabase.from('db_employees').select('emp_no').eq('company_code', COMPANY_CODE)
    .gte('synced_at', start.toISOString()).lt('synced_at', end.toISOString()).limit(1);
  if (error) throw new Error(`임직원 동기화 상태 조회 실패: ${error.message}`);
  return data?.length ? { due: false, reason: '오늘 이미 동기화됨' } : { due: true };
}

function millisecondsUntilNextEightKst(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000);
  let target = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), -1);
  if (target <= now.getTime()) target += 86400000;
  return target - now.getTime();
}

async function main() {
  loadSyncEnv();
  const supabase = createSyncSupabaseClient();
  const { syncAttendance } = require('./caps');
  const { syncEmployees } = require('./employees');
  const { syncLeaves } = require('./leaves');
  const release = acquireWorkerLock();
  let inProgress = false;

  async function runCycle() {
    if (inProgress) { log('⚠️ 동기화 건너뜀 (이전 동기화 진행 중)'); return; }
    inProgress = true;
    const startedAt = Date.now();
    log('✅ 동기화 시작');
    let conn;
    let failure;
    try {
      conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
        port: Number(process.env.MYSQL_PORT || 3306), connectTimeout: 20000 });
      // Fetch the interrupted attendance window first, independently of HR sync failures.
      const capsCount = await syncAttendance(conn);
      const employeeStatus = await shouldSyncEmployeesToday(supabase);
      if (employeeStatus.due) log(`✅ 임직원 정보 동기화 완료 (${await syncEmployees(conn)}건)`);
      else log(`✅ 임직원 정보 동기화 건너뜀 (${employeeStatus.reason})`);
      const leaveCount = await syncLeaves(conn);
      log(`✅ 동기화 완료 (${((Date.now() - startedAt) / 1000).toFixed(1)}s) | 캡스 ${capsCount}건 | 연차 ${leaveCount}건`);
    } catch (error) {
      failure = error;
      log(`❌ 동기화 실패: ${error.message}`);
    } finally {
      try { if (conn) await conn.end(); } finally { inProgress = false; }
    }
    return failure;
  }

  if (process.argv.includes('--once') || process.argv.includes('-1')) {
    try { if (await runCycle()) process.exitCode = 1; } finally { release(); }
    return;
  }

  log(`✅ db-atdc 회사 DB 동기화 시작 (1700 / CAPS 09 / ${SYNC_INTERVAL_MS / 60000}분 주기)`);
  await runCycle();
  setInterval(() => runCycle().catch(error => log(`❌ ${error.message}`)), SYNC_INTERVAL_MS);
  function scheduleEight() {
    setTimeout(async () => {
      try { await runCycle(); } catch (error) { log(`❌ ${error.message}`); }
      finally { scheduleEight(); }
    }, millisecondsUntilNextEightKst());
  }
  scheduleEight();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, shouldSyncEmployeesToday, millisecondsUntilNextEightKst, SYNC_INTERVAL_MS };
