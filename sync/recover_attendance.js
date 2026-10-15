/** CAPS-only recovery. The earlier of checkpoint and --hours ago wins. */
const mysql = require('mysql2/promise');
const { loadSyncEnv } = require('./loadEnv');
const { acquireWorkerLock } = require('./workerLock');

function recoveryOptions(args = process.argv.slice(2)) {
  let hours = 24;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--hours') hours = Number(args[++i]);
    else throw new Error(`지원하지 않는 복구 옵션: ${args[i]}`);
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) throw new Error('--hours는 0보다 크고 8760 이하여야 합니다.');
  return { hours, dryRun };
}

async function main() {
  const { hours, dryRun } = recoveryOptions();
  loadSyncEnv();
  const { syncAttendance } = require('./caps');
  const release = acquireWorkerLock();
  let conn;
  try {
    conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
      port: Number(process.env.MYSQL_PORT || 3306), connectTimeout: 20000 });
    const now = new Date();
    const rows = await syncAttendance(conn, { now, recoveryFrom: new Date(now.getTime() - hours * 3600000),
      dryRun, verify: !dryRun });
    console.log(JSON.stringify({ ok: true, dryRun, company: '1700', group: '09', rows,
      minimumRecoveryHours: hours, note: dryRun ? '조회만 완료; 저장 안 함' : '원본 키 대조 완료; 체크포인트 갱신 완료' }));
  } finally {
    try { if (conn) await conn.end(); } finally { release(); }
  }
}

if (require.main === module) main().catch(error => { console.error(`출입기록 복구 실패: ${error.message}`); process.exitCode = 1; });
module.exports = { main, recoveryOptions };
