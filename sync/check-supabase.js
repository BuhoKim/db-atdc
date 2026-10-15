const { createSyncSupabaseClient, COMPANY_PROJECT_REF, COMPANY_CODE } = require('./supabaseClient');
const { getAttendanceWindow } = require('./attendanceIncremental');

async function main() {
  const supabase = createSyncSupabaseClient();
  console.log(`회사 Supabase 읽기 전용 점검: ${COMPANY_PROJECT_REF} / 드림베이 1700 / CAPS 09`);
  for (const table of ['db_employees', 'db_attendance', 'db_leaves', 'db_sync_checkpoints']) {
    const { error, count, status } = await supabase.from(table).select('*', { head: true, count: 'exact' })
      .abortSignal(AbortSignal.timeout(15000));
    if (error) throw new Error(`${table} 조회 실패 (HTTP ${status}). 회사 서비스 키·테이블·네트워크를 확인하세요.`);
    console.log(`${table}: ${count}건`);
  }
  const window = await getAttendanceWindow({ supabase, companyCode: COMPANY_CODE, source: 'caps', overlapMinutes: 10 });
  console.log(`다음 CAPS 조회구간 (한국시간): ${window.fromStr} ~ ${window.toStr} / 기준 ${window.cursorOrigin}`);
  console.log('연결 확인 완료. MySQL 조회·DB 저장·메일 발송은 실행하지 않았습니다.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
