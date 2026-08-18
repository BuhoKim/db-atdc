
const normalizeDateParam = (val) => {
  if (!val) return '';
  const text = String(val).trim();
  const match = text.match(/(\de{4})[^\d]?(\d{2})[^\d]?(\de{2})/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  return text.slice(0, 10);
};
import { supabaseAdmin } from './supabaseAdmin';
import { COMPANY_CODE, normalizeEmpNoKey } from './dashboardUtils';
import { getKstDateKey } from './kstDate';

const DATA_SOURCES = [
  { prefix: 'db', companyCode: '1700' },
  { prefix: 'sa', companyCode: '1600' },
];

export const getReadableDataSources = (includeAllCompanies = false) => (
  includeAllCompanies ? DATA_SOURCES : DATA_SOURCES.slice(0, 1)
);

export const parseScopedEmpNo = (value = '') => {
  const text = String(value || '').trim();
  const match = text.match(/^(1600|1700):(.+)$/);
  return match
    ? { companyCode: match[1], empNo: normalizeEmpNoKey(match[2]) }
    : { companyCode: null, empNo: normalizeEmpNoKey(text) };
};

export const scopeEmpNo = (value, companyCode, includeScope = false) => {
  const normalized = normalizeEmpNoKey(value);
  if (!normalized) return '';
  return includeScope ? `${companyCode}:${normalized}` : normalized;
};

/** Fetch every PostgREST page instead of silently stopping at 1,000 rows. */
export async function fetchAllRows(buildQueryFn, pageSize = 1000) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await buildQueryFn().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

const scopeRow = (row, source, includeScope, { id = false, attendanceId = false } = {}) => {
  const next = {
    ...row,
    emp_no: scopeEmpNo(row.emp_no || row.sabun, source.companyCode, includeScope),
    raw_emp_no: normalizeEmpNoKey(row.emp_no || row.sabun),
    company_code: source.companyCode,
    data_source: source.prefix,
  };
  if (id && row.id != null) next.id = includeScope ? `${source.prefix}:${row.id}` : row.id;
  if (attendanceId && row.attendance_id != null) {
    next.attendance_id = includeScope ? `${source.prefix}:${row.attendance_id}` : row.attendance_id;
  }
  return next;
};

const sourceMatchesFilter = (source, empNoFilter) => {
  const parsed = parseScopedEmpNo(empNoFilter);
  return !parsed.companyCode || parsed.companyCode === source.companyCode;
};

const mapLeaveRow = (row, source, includeScope) => ({
  empNo: scopeEmpNo(row.emp_no, source.companyCode, includeScope),
  rawEmpNo: normalizeEmpNoKey(row.emp_no),
  empName: row.emp_name,
  startDate: row.start_date,
  endDate: row.end_date,
  leaveCode: row.leave_code,
  leaveName: row.leave_name,
  leaveDays: parseFloat(row.leave_days || 1),
  status: row.status,
  companyCode: source.companyCode,
  dataSource: source.prefix,
});

async function fetchAttendanceSource(source, range, options) {
  const { prefix, companyCode } = source;
  const { fromTime, toTime, fromDateStr, toDateStr, todayStr } = range;
  const { dashboardOnly, excludeLogs, empNo, includeAllCompanies } = options;
  const parsedFilter = parseScopedEmpNo(empNo);

  if (empNo && !sourceMatchesFilter(source, empNo)) {
    return { employees: [], logs: [], leaves: [], corrections: [], overrides: [], adjustments: [] };
  }

  const employeeQuery = () => {
    let query = supabaseAdmin
      .from(`${prefix}_employees`)
      .select('emp_no,name,dept,email,login_id,company_code,is_active')
      .eq('is_active', true)
      .order('dept', { ascending: true })
      .order('name', { ascending: true });
    if (parsedFilter.empNo) query = query.eq('emp_no', parsedFilter.empNo);
    return query;
  };

  const logQuery = () => {
    let query = supabaseAdmin
      .from(`${prefix}_attendance`)
      .select('id,sabun,emp_no,a_time,log_time,eq_code,gate_name,event_type,source')
      .gte('a_time', fromTime)
      .lte('a_time', toTime)
      .order('a_time', { ascending: true });
    if (parsedFilter.empNo) query = query.eq('emp_no', parsedFilter.empNo);
    return query;
  };

  const leaveQuery = () => {
    let query = supabaseAdmin
      .from(`${prefix}_leaves`)
      .select('emp_no,emp_name,start_date,end_date,leave_code,leave_name,leave_days,status')
      .lte('start_date', toDateStr)
      .gte('end_date', fromDateStr);
    if (parsedFilter.empNo) query = query.eq('emp_no', parsedFilter.empNo);
    return query;
  };

  const optional = async (label, query) => {
    try {
      return await fetchAllRows(query);
    } catch (error) {
      console.error(`${prefix} ${label} query error:`, error);
      return [];
    }
  };

  const [employees, logs, leaves, corrections, overrides, adjustments] = await Promise.all([
    fetchAllRows(employeeQuery),
    excludeLogs ? Promise.resolve([]) : fetchAllRows(logQuery),
    fetchAllRows(leaveQuery),
    dashboardOnly
      ? Promise.resolve([])
      : optional('attendance corrections', () => supabaseAdmin
          .from(`${prefix}_attendance_corrections`)
          .select('emp_no,work_date,corrected_out_time,reason')),
    optional('schedule overrides', () => {
      let query = supabaseAdmin
        .from(`${prefix}_schedule_overrides`)
        .select('emp_no,work_date,schedule_start,schedule_end,allow_overtime,note');
      if (dashboardOnly) query = query.eq('work_date', todayStr);
      return query;
    }),
    dashboardOnly
      ? Promise.resolve([])
      : optional('log adjustments', () => supabaseAdmin
          .from(`${prefix}_attendance_log_adjustments`)
          .select('attendance_id,emp_no,work_date,adjusted_role,note')),
  ]);

  const useScope = includeAllCompanies;
  return {
    employees: employees.map((row) => ({
      ...scopeRow(row, source, useScope),
      company_code: row.company_code || companyCode,
      rank: row.rank || '',
      position: row.position || '',
    })),
    logs: logs.map((row) => scopeRow(row, source, useScope, { id: true })),
    leaves: leaves.map((row) => mapLeaveRow(row, source, useScope)),
    corrections: corrections.map((row) => scopeRow(row, source, useScope)),
    overrides: overrides.map((row) => scopeRow(row, source, useScope)),
    adjustments: adjustments.map((row) => scopeRow(row, source, useScope, { attendanceId: true })),
  };
}

export async function fetchAttendanceLogs(month, {
  dashboardOnly = false,
  excludeLogs = false,
  empNo = null,
  includeAllCompanies = false,
} = {}) {
  try {
    const todayStr = getKstDateKey();
    const todayRaw = todayStr.replace(/-/g, '');
    let fromTime;
    let toTime;
    let fromDateStr;
    let toDateStr;

    if (dashboardOnly || !month) {
      fromTime = `${todayRaw}000000`;
      toTime = `${todayRaw}235959`;
      fromDateStr = todayRaw;
      toDateStr = todayRaw;
    } else {
      const [yearStr, rawMonth] = month.split('-');
      const monthStr = rawMonth.padStart(2, '0');
      const lastDay = new Date(Number(yearStr), Number(monthStr), 0).getDate();
      fromTime = `${yearStr}${monthStr}01000000`;
      toTime = `${yearStr}${monthStr}${String(lastDay).padStart(2, '0')}235959`;
      fromDateStr = `${yearStr}${monthStr}01`;
      toDateStr = `${yearStr}${monthStr}${String(lastDay).padStart(2, '0')}`;
    }

    const range = { fromTime, toTime, fromDateStr, toDateStr, todayStr };
    const options = { dashboardOnly, excludeLogs, empNo, includeAllCompanies };
    const results = await Promise.all(
      getReadableDataSources(includeAllCompanies).map((source) => fetchAttendanceSource(source, range, options))
    );

    return {
      employees: results.flatMap((result) => result.employees),
      logs: results.flatMap((result) => result.logs),
      leaves: results.flatMap((result) => result.leaves),
      corrections: results.flatMap((result) => result.corrections),
      overrides: results.flatMap((result) => result.overrides),
      logAdjustments: results.flatMap((result) => result.adjustments),
    };
  } catch (error) {
    console.error('fetchAttendanceLogs error:', error);
    throw error;
  }
}

export async function fetchCalendarLeaves(month, { includeAllCompanies = false } = {}) {
  const match = String(month || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) return [];

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const monthText = String(monthNumber).padStart(2, '0');
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const fromDate = `${year}${monthText}01`;
  const toDate = `${year}${monthText}${String(lastDay).padStart(2, '0')}`;

  const sources = getReadableDataSources(includeAllCompanies);
  const results = await Promise.all(sources.map(async (source) => {
    const rows = await fetchAllRows(() => supabaseAdmin
      .from(`${source.prefix}_leaves`)
      .select('emp_no,emp_name,start_date,end_date,leave_code,leave_name,leave_days,status')
      .lte('start_date', toDate)
      .gte('end_date', fromDate));
    return rows.map((row) => mapLeaveRow(row, source, includeAllCompanies));
  }));

  return results.flat();
}

export async function fetchEmployeeSchedules({ includeAllCompanies = false } = {}) {
  const sources = getReadableDataSources(includeAllCompanies);
  const results = await Promise.all(sources.map(async (source) => {
    try {
      const { data, error } = await supabaseAdmin
        .from(`${source.prefix}_employee_schedules`)
        .select('emp_no,schedule_time,schedule_end_time,schedule_reason,updated_at')
        .limit(1000);
      if (error) throw error;
      return (data || []).map((row) => ({
        empNo: scopeEmpNo(row.emp_no, source.companyCode, includeAllCompanies),
        scheduleTime: row.schedule_time ? String(row.schedule_time).slice(0, 5) : '09:00',
        scheduleEndTime: row.schedule_end_time ? String(row.schedule_end_time).slice(0, 5) : '',
        scheduleReason: row.schedule_reason || '',
        companyCode: source.companyCode,
        dataSource: source.prefix,
      }));
    } catch (error) {
      console.warn(`${source.prefix} employee schedules query warning:`, error.message);
      return [];
    }
  }));
  return results.flat();
}

export async function fetchAttendanceNotes({ fromDate, toDate, empNo } = {}) {
  try {
    let query = supabaseAdmin
      .from('db_attendance_notes')
      .select('id,emp_no,work_date,note,image_url,created_at,updated_at');
    if (fromDate) query = query.gte('work_date', fromDate);
    if (toDate) query = query.lte('work_date', toDate);
    if (empNo) query = query.eq('emp_no', normalizeEmpNoKey(empNo));
    const { data, error } = await query;
    if (error) {
      console.warn('fetchAttendanceNotes query warning:', error.message);
      return [];
    }
    return Promise.all((data || []).map(async (note) => {
      const imageUrl = String(note.image_url || '');
      const marker = '/storage/v1/object/public/attendance-notes/';
      const markerIndex = imageUrl.indexOf(marker);
      if (!imageUrl || markerIndex < 0) return note;

      const filePath = decodeURIComponent(imageUrl.slice(markerIndex + marker.length));
      const { data: signed } = await supabaseAdmin.storage
        .from('attendance-notes')
        .createSignedUrl(filePath, 60 * 60);
      return { ...note, image_url: signed?.signedUrl || note.image_url };
    }));
  } catch (err) {
    console.error('fetchAttendanceNotes error:', err);
    return [];
  }
}

export async function saveAttendanceNote({ empNo, workDate, note, imageUrl } = {}) {
  const cleanEmpNo = normalizeEmpNoKey(empNo);
  const { data, error } = await supabaseAdmin
    .from('db_attendance_notes')
    .upsert({
      emp_no: cleanEmpNo,
      work_date: normalizeDateParam(workDate),
      note: note || '',
      image_url: imageUrl || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'emp_no,work_date' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAttendanceNote({ empNo, workDate } = {}) {
  const cleanEmpNo = normalizeEmpNoKey(empNo);
  const { error } = await supabaseAdmin
    .from('db_attendance_notes')
    .delete()
    .eq('emp_no', cleanEmpNo)
    .eq('work_date', normalizeDateParam(workDate));
  if (error) throw error;
  return true;
}
