process.env.TZ = 'Asia/Seoul';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/apiAuth';
import { fetchAttendanceLogs, fetchCalendarLeaves, fetchEmployeeSchedules, fetchAttendanceNotes } from '@/lib/supabaseDb';
import { getLeaveMeta } from '@/lib/leaveRules';
import { getKstDateKey, shiftKstDateKey } from '@/lib/kstDate';
import { normalizeEmpNoKey, formatTimeString } from '@/lib/dashboardUtils';
import { employmentStateFields } from '@/lib/employmentState';
import {
  toMinutes,
  normalizeTime,
  getLateCheckinLimit,
  isOvernightSchedule,
} from '@/lib/attendanceCalculations';
import {
  buildEmployeeScheduleMap,
  buildScheduleOverrideMap,
  buildTeamSchedulePatternMap,
  resolveSchedulePairForDate,
} from '@/lib/scheduleResolver';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const auth = await requireApiSession(request);
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month') || undefined;
    const dashboardOnly = !month || searchParams.get('dashboardOnly') === 'true';
    const excludeLogs = searchParams.get('excludeLogs') === 'true';
    const empNoFilter = searchParams.get('empNo') || null;
    const calendarMonth = searchParams.get('calendarMonth') || '';
    // This deployment is the DreamBay (1700) system. Account authority never
    // broadens the tenant selected by the site/domain.
    const includeAllCompanies = false;

    let [attendanceNotes, attendanceData, employeeSchedules, calendarLeaves] = await Promise.all([
      fetchAttendanceNotes({ fromDate: month ? month + '-01' : shiftKstDateKey(getKstDateKey(), -7), toDate: month ? month + '-31' : shiftKstDateKey(getKstDateKey(), 1), empNo: empNoFilter }),
      fetchAttendanceLogs(month, { dashboardOnly, excludeLogs, empNo: empNoFilter, includeAllCompanies }),
      fetchEmployeeSchedules({ includeAllCompanies }),
      dashboardOnly && calendarMonth
        ? fetchCalendarLeaves(calendarMonth, { includeAllCompanies })
        : Promise.resolve([]),
    ]);

    let {
      employees = [],
      logs: rawLogs = [],
      leaves: attendanceLeaves = [],
      corrections = [],
      overrides = [],
      logAdjustments = [],
    } = attendanceData;

    // kmk remains a valid login account, but is excluded from dashboard
    // presentation and counts. Monthly reports and authentication are unchanged.
    if (dashboardOnly) {
      const hiddenEmpKeys = new Set(
        employees
          .filter((employee) => String(employee.login_id || '').toLowerCase() === 'kmk')
          .map((employee) => normalizeEmpNoKey(employee.emp_no))
      );
      const isHidden = (empNo) => hiddenEmpKeys.has(normalizeEmpNoKey(empNo));
      employees = employees.filter((employee) => !isHidden(employee.emp_no));
      rawLogs = rawLogs.filter((log) => !isHidden(log.emp_no));
      attendanceLeaves = attendanceLeaves.filter((leave) => !isHidden(leave.empNo));
      calendarLeaves = calendarLeaves.filter((leave) => !isHidden(leave.empNo));
    }

    const leaveMap = new Map();
    [...attendanceLeaves, ...calendarLeaves].forEach((leave) => {
      const key = [
        leave.empNo,
        leave.startDate,
        leave.endDate,
        leave.leaveCode,
        leave.leaveName,
        leave.status,
      ].join('|');
      leaveMap.set(key, leave);
    });
    const employmentByEmpNo = new Map(employees.map(employee => [normalizeEmpNoKey(employee.emp_no), employee]));
    const leaves = Array.from(leaveMap.values()).map(leave => ({ ...leave,
      ...employmentStateFields(employmentByEmpNo.get(normalizeEmpNoKey(leave.empNo))),
    }));

    const employeeScheduleMap = buildEmployeeScheduleMap(employeeSchedules);
    const overrideMap = buildScheduleOverrideMap(overrides);
    const noteMap = new Map();
    (attendanceNotes || []).forEach(n => noteMap.set(normalizeEmpNoKey(n.emp_no) + '_' + n.work_date, n));

    // 날짜별/사원별 연차 헬퍼
    const getEmployeeLeaveForDate = (empNo, dateStrCompat) => {
      const empKey = normalizeEmpNoKey(empNo);
      return leaves.find(
        (l) => normalizeEmpNoKey(l.empNo) === empKey && dateStrCompat >= l.startDate && dateStrCompat <= l.endDate
      );
    };

    const getSchedulePairForDate = (empNo, dept, dateStr) => {
      const empKey = normalizeEmpNoKey(empNo);
      const override = overrideMap.get(`${empKey}_${dateStr}`) || null;
      const baseSchedule = employeeScheduleMap.get(empKey) || {};
      return resolveSchedulePairForDate({
        dept,
        dateStr,
        baseStart: baseSchedule.start || '09:00',
        baseEnd: baseSchedule.end || '',
        overrideLookup: overrideMap,
      });
    };

    // rawLogs의 a_time (예: "20260810080054") -> "2026-08-10 08:00:54" 변환
    const adjustmentMap = new Map();
    (logAdjustments || []).forEach((adj) => {
      adjustmentMap.set(`${normalizeEmpNoKey(adj.emp_no)}_${adj.a_time}`, adj);
    });

    const parsedLogs = (rawLogs || []).map((log) => {
      const aTime = String(log.a_time || '').trim();
      const digits = aTime.replace(/\D/g, '');
      let datePart = '';
      let timePart = '';
      if (digits.length >= 14) {
        datePart = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        timePart = `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
      } else if (aTime.includes(' ')) {
        const [d, t] = aTime.split(' ');
        datePart = d;
        timePart = t;
      } else {
        datePart = getKstDateKey();
        timePart = aTime;
      }

      const logTime = `${datePart} ${timePart}`.trim();
      const empKey = normalizeEmpNoKey(log.emp_no);
      const adj = adjustmentMap.get(`${empKey}_${aTime}`) || null;

      return {
        empNo: empKey,
        name: log.name,
        logTime,
        a_time: aTime,
        gate: log.gate_name || log.e_name || (log.e_group && log.e_node ? `${log.e_group}/${log.e_node}` : '-'),
        companyCode: log.company_code || '',
        dataSource: log.data_source || 'db',
        adjustedRole: adj?.role || null,
        adjustedTime: adj?.custom_time || null,
      };
    });

    // 사원/일자별 그룹핑
    const employeeDayMap = new Map();

    parsedLogs.forEach((log) => {
      const empKey = log.empNo;
      const dateStr = log.logTime.split(' ')[0];
      if (!empKey || !dateStr) return;

      const groupKey = `${empKey}_${dateStr}`;
      if (!employeeDayMap.has(groupKey)) {
        employeeDayMap.set(groupKey, []);
      }
      employeeDayMap.get(groupKey).push(log);
    });

    const todayStr = getKstDateKey();
    const todayCompact = todayStr.replace(/-/g, '');

    // 오늘 대시보드 상태 집계
    const employeeStatuses = employees.map((emp) => {
      const empKey = normalizeEmpNoKey(emp.emp_no);
      const todayLogs = employeeDayMap.get(`${empKey}_${todayStr}`) || [];
      const schedule = getSchedulePairForDate(empKey, emp.dept, todayStr);
      const todayLeave = getEmployeeLeaveForDate(empKey, todayCompact);

      // 로그 정렬 (시간순)
      todayLogs.sort((a, b) => a.logTime.localeCompare(b.logTime));

      let checkIn = '';
      let checkOut = '';

      if (todayLogs.length > 0) {
        checkIn = todayLogs[0].logTime.split(' ')[1].slice(0, 5); // "08:00"
        if (todayLogs.length > 1) {
          checkOut = todayLogs[todayLogs.length - 1].logTime.split(' ')[1].slice(0, 5);
        }
      }

      // 지각 판정
      let isLate = false;
      if (checkIn) {
        const lateLimit = getLateCheckinLimit(todayLeave, schedule.start || '09:00');
        const lateLimitMinutes = toMinutes(lateLimit);
        const checkInMinutes = toMinutes(checkIn);
        if (checkInMinutes > lateLimitMinutes) {
          isLate = true;
        }
      }

      // 상태 문자열
      let status = '미출근';
      if (todayLeave) {
        status = todayLeave.leaveName || '연차';
      } else if (checkOut && checkOut !== checkIn) {
        status = '근무완료';
      } else if (checkIn) {
        status = '근무중';
      }

      return {
        empNo: emp.emp_no,
        rawEmpNo: emp.raw_emp_no || emp.emp_no,
        name: emp.name,
        ...employmentStateFields(emp),
        dept: emp.dept,
        companyCode: emp.company_code || '1700',
        dataSource: emp.data_source || 'db',
        rank: emp.rank || '',
        scheduleTime: schedule.start || '09:00',
        scheduleEndTime: schedule.end || '18:00',
        checkIn: checkIn || '-',
        checkOut: checkOut || '-',
        isLate,
        status,
        todayLeave: todayLeave ? { ...todayLeave, leaveName: todayLeave.leaveName } : null,
        note: noteMap.get(empKey + '_' + todayStr)?.note || '',
        noteImageUrl: noteMap.get(empKey + '_' + todayStr)?.image_url || null,
      };
    });

    // 월간 그리드 데이터
    const gridData = {};
    employees.forEach((emp) => {
      gridData[emp.emp_no] = {};
    });

    employeeDayMap.forEach((logs, groupKey) => {
      const [empKey, dateStr] = groupKey.split('_');
      if (!gridData[empKey]) gridData[empKey] = {};

      logs.sort((a, b) => a.logTime.localeCompare(b.logTime));
      const inTime = logs[0].logTime.split(' ')[1].slice(0, 5);
      const outTime = logs.length > 1 ? logs[logs.length - 1].logTime.split(' ')[1].slice(0, 5) : '';

      const emp = employees.find((e) => normalizeEmpNoKey(e.emp_no) === empKey);
      const schedule = getSchedulePairForDate(empKey, emp?.dept || '', dateStr);
      const dateCompact = dateStr.replace(/-/g, '');
      const leave = getEmployeeLeaveForDate(empKey, dateCompact);

      let isLate = false;
      if (inTime) {
        const lateLimit = getLateCheckinLimit(leave, schedule.start || '09:00');
        if (toMinutes(inTime) > toMinutes(lateLimit)) {
          isLate = true;
        }
      }

      gridData[empKey][dateStr] = {
        in: inTime,
        out: outTime,
        isLate,
        note: noteMap.get(empKey + '_' + dateStr)?.note || '',
        noteImageUrl: noteMap.get(empKey + '_' + dateStr)?.image_url || null,
      };
    });

    // 부서별 통계
    const deptMap = new Map();
    employees.forEach((emp) => {
      const dept = emp.dept || '기타';
      if (!deptMap.has(dept)) {
        deptMap.set(dept, { name: dept, total: 0, present: 0 });
      }
      const item = deptMap.get(dept);
      item.total += 1;
      const status = employeeStatuses.find((s) => s.empNo === emp.emp_no);
      if (status && status.checkIn && status.checkIn !== '-') {
        item.present += 1;
      }
    });

    const deptData = Array.from(deptMap.values());

    const formattedEmployees = employees.map((e) => ({
      empNo: e.emp_no,
      rawEmpNo: e.raw_emp_no || e.emp_no,
      name: e.name,
      ...employmentStateFields(e),
      dept: e.dept,
      companyCode: e.company_code || '1700',
      dataSource: e.data_source || 'db',
      scheduleTime: employeeScheduleMap.get(normalizeEmpNoKey(e.emp_no))?.start || '09:00',
      scheduleEndTime: employeeScheduleMap.get(normalizeEmpNoKey(e.emp_no))?.end || '18:00',
    }));

    const responsePayload = {
      success: true,
      employees: formattedEmployees,
      allEmployees: formattedEmployees,
      employeeStatuses,
      gridData,
      deptData,
      leaves,
      overrides,
      notes: attendanceNotes || [],
      allLogs: parsedLogs,
    };

    return NextResponse.json(responsePayload, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('attendance API error:', error);
    return NextResponse.json({
      success: false,
      error: '근태 데이터를 불러오지 못했습니다.',
      detail: process.env.NODE_ENV === 'production' ? undefined : error.message,
    }, { status: 500 });
  }
}
