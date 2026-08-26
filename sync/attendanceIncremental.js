const DEFAULT_OVERLAP_MINUTES = 10;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 60;

function asValidDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatMySqlBoundary(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}${String(kst.getUTCHours()).padStart(2, '0')}${String(kst.getUTCMinutes()).padStart(2, '0')}${String(kst.getUTCSeconds()).padStart(2, '0')}`;
}

function boundaryParts(date) {
  const value = formatMySqlBoundary(date);
  return { date: value.slice(0, 8), time: value.slice(8, 14) };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function getAttendanceWindow({ supabase, companyCode, source, now = new Date(), overlapMinutes = DEFAULT_OVERLAP_MINUTES, initialLookbackMinutes = DEFAULT_INITIAL_LOOKBACK_MINUTES }) {
  const { data: checkpoints, error: checkpointError } = await supabase
    .from('db_sync_checkpoints')
    .select('last_success_at')
    .eq('company_code', companyCode)
    .eq('source', source)
    .limit(1);
  if (checkpointError) throw new Error(`동기화 체크포인트 조회 실패: ${checkpointError.message}`);

  let cursor = asValidDate(checkpoints?.[0]?.last_success_at);
  let cursorOrigin = 'checkpoint';

  // 마이그레이션 직후 기존 데이터가 있으면 기존 수집 시각을 초기 커서로 사용한다.
  // 이후부터는 반드시 체크포인트만 갱신한다.
  if (!cursor) {
    const { data: latestRows, error: latestError } = await supabase
      .from('db_attendance')
      .select('synced_at')
      .eq('source', source)
      .like('sabun', `${companyCode}%`)
      .order('synced_at', { ascending: false })
      .limit(1);
    if (latestError) throw new Error(`기존 출입기록 커서 조회 실패: ${latestError.message}`);
    cursor = asValidDate(latestRows?.[0]?.synced_at);
    cursorOrigin = cursor ? 'existing_data' : 'initial_lookback';
  }

  const fallback = new Date(now.getTime() - initialLookbackMinutes * 60 * 1000);
  const base = cursor || fallback;
  const from = new Date(base.getTime() - overlapMinutes * 60 * 1000);
  const fromParts = boundaryParts(from);
  const toParts = boundaryParts(now);
  return {
    from,
    to: now,
    fromStr: formatMySqlBoundary(from),
    toStr: formatMySqlBoundary(now),
    fromDateStr: fromParts.date,
    fromTimeStr: fromParts.time,
    toDateStr: toParts.date,
    toTimeStr: toParts.time,
    cursorOrigin,
    overlapMinutes,
  };
}

async function saveAttendanceCheckpoint({ supabase, companyCode, source, window, rowCount, queryBytes = 0, upsertBytes = 0 }) {
  const { error } = await supabase
    .from('db_sync_checkpoints')
    .upsert({
      company_code: companyCode,
      source,
      last_success_at: window.to.toISOString(),
      last_window_start: window.from.toISOString(),
      last_window_end: window.to.toISOString(),
      last_row_count: rowCount,
      last_query_bytes: queryBytes,
      last_upsert_bytes: upsertBytes,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_code,source' });
  if (error) throw new Error(`동기화 체크포인트 저장 실패: ${error.message}`);
}

module.exports = {
  DEFAULT_OVERLAP_MINUTES,
  DEFAULT_INITIAL_LOOKBACK_MINUTES,
  formatMySqlBoundary,
  formatBytes,
  getAttendanceWindow,
  saveAttendanceCheckpoint,
};
