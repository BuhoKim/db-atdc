import { requireApiSession, privateJson, internalError } from '@/lib/apiAuth';
import { getKstDateKey, shiftKstDateKey } from '@/lib/kstDate';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  fetchAllRows,
  getReadableDataSources,
  parseScopedEmpNo,
  scopeEmpNo,
  fetchAttendanceNotes,
} from '@/lib/supabaseDb';
import { normalizeEmpNoKey } from '@/lib/dashboardUtils';
import { employmentStateFields } from '@/lib/employmentState';

export const dynamic = 'force-dynamic';

const parseDateInput = (value, fallback) => {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
};

const formatAttendanceLogTime = (row = {}) => {
  const value = String(row.a_time || '').trim();
  if (/^\d{14}/.test(value)) {
    return (
      value.slice(0, 4) +
      '-' +
      value.slice(4, 6) +
      '-' +
      value.slice(6, 8) +
      ' ' +
      value.slice(8, 10) +
      ':' +
      value.slice(10, 12) +
      ':' +
      value.slice(12, 14)
    );
  }
  return String(row.log_time || value || '-');
};

export async function GET(request) {
  try {
    const auth = await requireApiSession(request);
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const requestedEmpNo = String(searchParams.get('empNo') || searchParams.get('emp_no') || '').trim();
    const parsedEmpNo = parseScopedEmpNo(requestedEmpNo);
    const today = getKstDateKey();
    const from = parseDateInput(searchParams.get('from') || searchParams.get('date'), shiftKstDateKey(today, -1));
    const to = parseDateInput(searchParams.get('to') || searchParams.get('date'), today);
    const dept = String(searchParams.get('dept') || 'ALL').trim().slice(0, 100);
    const fromTime = from.replace(/-/g, '') + '000000';
    const toTime = shiftKstDateKey(to, 1).replace(/-/g, '') + '060000';
    const includeAllCompanies = false;

    const allNotes = await fetchAttendanceNotes({ fromDate: from, toDate: to, empNo: requestedEmpNo !== 'ALL' ? requestedEmpNo : null });
    const noteMap = new Map((allNotes || []).map((n) => [normalizeEmpNoKey(n.emp_no) + ':' + n.work_date, n]));

    const sources = getReadableDataSources(includeAllCompanies)
      .filter((source) => !parsedEmpNo.companyCode || source.companyCode === parsedEmpNo.companyCode);

    const sourceResults = await Promise.all(sources.map(async (source) => {
      const employeeQuery = () => {
        let query = supabaseAdmin
          .from(source.prefix + '_employees')
          .select('emp_no,name,dept,company_code,is_active' + (source.prefix === 'db' ? ',employment_status,state_code,state_date' : ''))
          .eq('is_active', true)
          .order('dept', { ascending: true })
          .order('name', { ascending: true });
        if (dept && dept !== 'ALL') query = query.eq('dept', dept);
        return query;
      };

      const logQuery = () => {
        let query = supabaseAdmin
          .from(source.prefix + '_attendance')
          .select('id,emp_no,a_time,log_time,gate_name,sabun')
          .gte('a_time', fromTime)
          .lte('a_time', toTime)
          .order('a_time', { ascending: false });
        if (requestedEmpNo && requestedEmpNo !== 'ALL' && parsedEmpNo.empNo) {
          const raw = parsedEmpNo.empNo;
          const full = source.companyCode + raw;
          query = query.or('emp_no.eq.' + raw + ',sabun.eq.' + raw + ',emp_no.eq.' + full + ',sabun.eq.' + full);
        }
        return query;
      };

      const [employees, logs] = await Promise.all([
        fetchAllRows(employeeQuery),
        fetchAllRows(logQuery),
      ]);
      return { source, employees, logs };
    }));

    const employees = sourceResults.flatMap(({ source, employees: rows }) => rows.map((row) => ({
      ...row,
      raw_emp_no: row.emp_no,
      emp_no: scopeEmpNo(row.emp_no, source.companyCode, includeAllCompanies),
      company_code: row.company_code || source.companyCode,
      data_source: source.prefix,
      read_only: source.prefix === 'sa',
    })));

    const employeeMap = new Map(employees.map((employee) => [employee.emp_no, employee]));
    const records = sourceResults.flatMap(({ source, logs }) => logs.map((row) => {
      const scopedEmpNo = scopeEmpNo(row.emp_no || row.sabun, source.companyCode, includeAllCompanies);
      const employee = employeeMap.get(scopedEmpNo) || {};
      const logDateRaw = String(row.a_time || '').slice(0, 8);
      const fmtDate = logDateRaw.length === 8 ? logDateRaw.slice(0, 4) + '-' + logDateRaw.slice(4, 6) + '-' + logDateRaw.slice(6, 8) : from;
      const noteItem = noteMap.get(normalizeEmpNoKey(scopedEmpNo) + ':' + fmtDate);

      return {
        id: includeAllCompanies ? source.prefix + ':' + row.id : row.id,
        emp_no: scopedEmpNo,
        empNo: scopedEmpNo,
        raw_emp_no: employee.raw_emp_no || parsedEmpNo.empNo || '',
        name: employee.name || '-',
        ...employmentStateFields(employee),
        dept: employee.dept || '부서미지정',
        company_code: source.companyCode,
        data_source: source.prefix,
        read_only: source.prefix === 'sa',
        event_time: formatAttendanceLogTime(row),
        gate_name: row.gate_name || '출입',
        source: 'caps',
        a_time: row.a_time,
        note: noteItem ? (noteItem.note || '') : '',
        noteImageUrl: noteItem ? (noteItem.image_url || null) : null,
        memo: noteItem ? (noteItem.note || '') : '',
      };
    }));

    return privateJson({ records, logs: records, totalCount: records.length, employees });
  } catch (error) {
    return internalError('attendance-records GET error:', error, '출입기록을 불러오지 못했습니다.');
  }
}
