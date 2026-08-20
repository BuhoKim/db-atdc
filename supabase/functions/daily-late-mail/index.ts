import Holidays from 'npm:date-holidays';

const corsHeaders = { 'Content-Type': 'application/json' };
const koreanHolidays = new Holidays('KR');
const koreanHolidayCache = new Map<number, Set<string>>();
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const cronSecret = Deno.env.get('CRON_SECRET') || '';
const clientId = Deno.env.get('NAVER_WORKS_CLIENT_ID') || '';
const clientSecret = Deno.env.get('NAVER_WORKS_CLIENT_SECRET') || '';
const refreshToken = Deno.env.get('NAVER_WORKS_REFRESH_TOKEN') || '';
const senderUserId = Deno.env.get('NAVER_WORKS_SENDER_USER_ID') || '';
const recipients = (Deno.env.get('DAILY_REPORT_RECIPIENTS') || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function kstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-');
}

function isWeekend(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekDay === 0 || weekDay === 6;
}

function isKoreanHoliday(dateKey: string) {
  const year = Number(dateKey.slice(0, 4));
  if (!koreanHolidayCache.has(year)) {
    const holidayDates = new Set(
      koreanHolidays.getHolidays(year)
        // date-holidays calculates the year's substitute holidays and marks
        // them with substitute=true; public holidays are the non-working days.
        .filter((holiday: any) => holiday.type === 'public')
        .map((holiday: any) => String(holiday.date || '').slice(0, 10)),
    );
    koreanHolidayCache.set(year, holidayDates);
  }
  return koreanHolidayCache.get(year)?.has(dateKey) || false;
}

function isNonBusinessDate(dateKey: string) {
  return isWeekend(dateKey) || isKoreanHoliday(dateKey);
}

function previousBusinessDateKey(todayKey: string) {
  let dateKey = shiftDateKey(todayKey, -1);
  while (isNonBusinessDate(dateKey)) dateKey = shiftDateKey(dateKey, -1);
  return dateKey;
}

function normalizeEmpNo(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.replace(/^1700/, '').replace(/^0+/, '') || digits;
}

function toMinutes(value: unknown) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 540;
}

function compactTime(value: unknown) {
  const text = String(value || '').replace(/\D/g, '');
  return text.length >= 14 ? text.slice(8, 14) : text.slice(-6).padStart(6, '0');
}

function displayTime(value: unknown) {
  const time = compactTime(value);
  return time.length >= 4 ? `${time.slice(0, 2)}:${time.slice(2, 4)}` : '-';
}

function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function leaveLabel(leave: any) {
  const raw = String(leave?.leave_name || '').trim();
  if (raw && !/^\d+$/.test(raw)) return raw;
  const labels: Record<string, string> = {
    '12': '연차',
    '13': '공가',
    '16': '오전반차',
    '17': '오후반차',
    '18': '경조휴가',
    '19': '2시간휴가A [07-09]',
    '20': '2시간휴가B [08-10]',
    '21': '2시간휴가C [09-11]',
    '22': '2시간휴가D [10-12]',
    '23': '2시간휴가E [11-13]',
    '24': '2시간휴가F [13-15]',
    '25': '2시간휴가G [14-16]',
    '26': '2시간휴가H [15-17]',
    '27': '2시간휴가I [16-18]',
    '28': '2시간휴가J [17-19]',
    '51': '연차',
    '61': '오전반차',
    '62': '오후반차',
  };
  const code = String(leave?.leave_code || '');
  return labels[code] || (Number(leave?.leave_days || 0) >= 1 ? '연차' : '휴가');
}

function hasLeaveCode(leaves: any[], codes: string[]) {
  return leaves.some((leave) => codes.includes(String(leave?.leave_code || '')));
}

const TWO_HOUR_LEAVE_CODES = new Set(['19', '20', '21', '22', '23', '24', '25', '26', '27', '28']);
const TWO_HOUR_WINDOWS: Record<string, [number, number]> = {
  '19': [7 * 60, 9 * 60], '20': [8 * 60, 10 * 60], '21': [9 * 60, 11 * 60],
  '22': [10 * 60, 12 * 60], '23': [11 * 60, 13 * 60], '24': [13 * 60, 15 * 60],
  '25': [14 * 60, 16 * 60], '26': [15 * 60, 17 * 60], '27': [16 * 60, 18 * 60],
  '28': [17 * 60, 19 * 60],
};

function leaveType(leave: any) {
  const code = String(leave?.leave_code || '').trim();
  const name = String(leave?.leave_name || '').replace(/\s+/g, '').toLowerCase();
  if (['16', '61'].includes(code) || name.includes('오전반차') || name.includes('4시간휴가[오전]') || name.includes('4시간휴가(오전)')) return 'morning_half';
  if (['17', '62'].includes(code) || name.includes('오후반차') || name.includes('4시간휴가[오후]') || name.includes('4시간휴가(오후)')) return 'afternoon_half';
  if (TWO_HOUR_LEAVE_CODES.has(code) || name.includes('2시간')) return 'two_hour';
  return '';
}

function hasLeaveType(leaves: any[], type: string) {
  return leaves.some((leave) => leaveType(leave) === type);
}

function twoHourWindow(leave: any) {
  const code = String(leave?.leave_code || '').trim();
  const codeWindow = TWO_HOUR_WINDOWS[code];
  if (codeWindow) return codeWindow;
  const match = String(leave?.leave_name || '').match(/\[(\d{1,2})\s*[-~]\s*(\d{1,2})\]/);
  return match ? [Number(match[1]) * 60, Number(match[2]) * 60] as [number, number] : null;
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>\"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] || character));
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const result = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      ...(init.headers || {}),
    },
  });
  if (!result.ok) throw new Error(`supabase_${result.status}`);
  return result.status === 204 ? null : result.json();
}

async function hashRecipients(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getAccessToken() {
  const form = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const result = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok || !body.access_token) throw new Error(`naverworks_token_${result.status}`);
  return String(body.access_token);
}

async function sendMail(subject: string, body: string) {
  const accessToken = await getAccessToken();
  const result = await fetch(`https://www.worksapis.com/v1.0/users/${encodeURIComponent(senderUserId)}/mail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: recipients.join(';'),
      subject,
      body,
      contentType: 'html',
      userName: '드림베이 근태관리시스템',
      isSaveSentMail: true,
      isSaveTracking: false,
    }),
  });
  if (!result.ok) throw new Error(`naverworks_mail_${result.status}`);
  return result.headers.get('x-message-id') || null;
}

function reportSection(title, count, color, headers, rows, emptyText = '해당 없음') {
  if (!count) return '';
  const body = rows.length
    ? rows.map((row, rowIndex) => `<tr style="background:${rowIndex % 2 ? '#fbfcfe' : '#ffffff'};">${row.map((cell) => `<td style="padding:12px 14px;border-bottom:1px solid #e7ebf0;color:#344054;font-size:14px;line-height:1.45;white-space:nowrap;">${String(cell).trim().startsWith("<") ? String(cell) : escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" style="padding:17px 14px;text-align:center;color:#98a2b3;font-size:13px;">${emptyText}</td></tr>`;
  return `<tr><td style="padding:24px 0 9px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:17px;font-weight:700;color:#172033;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin:0 9px 2px 0;"></span>${title}</td><td align="right" style="font-size:13px;color:#667085;">${count}명</td></tr></table></td></tr><tr><td style="padding:0;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dfe4ea;border-radius:8px;border-collapse:separate;overflow:hidden;"><tr>${headers.map((header) => `<th align="left" style="padding:11px 14px;background:#eef2f6;border-bottom:1px solid #dfe4ea;color:#475467;font-size:13px;font-weight:700;white-space:nowrap;">${header}</th>`).join('')}</tr>${body}</table></td></tr>`;
}

function buildReport({ workDate, late, absent, early, leave, scheduleExceptions, employees }) {
  const summaryItems = [
    ['지각', late.length, '#fff7e6', '#b54708'],
    ['미출근', absent.length, '#fff0f0', '#b42318'],
    ['조기퇴근', early.length, '#f4f0ff', '#6941c6'],
    ['휴가', leave.length, '#ecfdf3', '#027a48'],
  ].filter(([, count]) => count > 0);
  const summary = summaryItems.length
    ? summaryItems.map(([label, count, background, color]) => `<td width="${Math.floor(100 / summaryItems.length)}%" style="padding:0 5px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${background};border:1px solid #eaecf0;border-radius:6px;min-width:130px;"><tr><td style="padding:11px 14px 3px;color:#667085;font-size:13px;">${label}</td></tr><tr><td style="padding:0 14px 11px;color:${color};font-size:24px;font-weight:700;">${count}<span style="font-size:13px;font-weight:400;margin-left:3px;">명</span></td></tr></table></td>`).join('')
    : '<td style="padding:14px;color:#667085;font-size:13px;">특이사항 없음</td>';
  const sections = [
    reportSection('지각자', late.length, '#f59e0b', ['이름', '출근', '기준', '사유등록'], late.map((row) => [row.name, row.checkIn, row.schedule, '<a href="https://atdc.dreambay.co.kr/attendance-records?empNo=' + encodeURIComponent(row.empNo) + '&date=' + encodeURIComponent(workDate) + '&modal=note" target="_blank" style="display:inline-block;padding:4px 8px;background:#2563eb;color:#ffffff;border-radius:4px;font-size:12px;font-weight:bold;text-decoration:none;">📝 사유입력</a>'])),
    reportSection('미출근자', absent.length, '#ef4444', ['이름', '사유등록'], absent.map((row) => [row.name, '<a href="https://atdc.dreambay.co.kr/attendance-records?empNo=' + encodeURIComponent(row.empNo) + '&date=' + encodeURIComponent(workDate) + '&modal=note" target="_blank" style="display:inline-block;padding:4px 8px;background:#2563eb;color:#ffffff;border-radius:4px;font-size:12px;font-weight:bold;text-decoration:none;">📝 사유입력</a>'])),
    reportSection('조기퇴근자', early.length, '#8b5cf6', ['이름', '퇴근'], early.map((row) => [row.name, row.checkOut])),
    reportSection('휴가자', leave.length, '#10b981', ['이름', '휴가 구분'], leave.map((row) => [row.name, row.leaveName])),
    reportSection('개인별 출근기준 적용', scheduleExceptions.length, '#0ea5e9', ['이름', '출근시간', '사유'], scheduleExceptions.map((row) => [row.name, row.checkIn, row.reason])),
  ].join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f3f5f8;color:#172033;font-family:Arial,'Malgun Gothic',sans-serif;font-size:14px;line-height:1.5;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f3f5f8;"><tr><td align="center" style="padding:24px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;min-width:640px;background:#ffffff;border:1px solid #e4e7ec;"><tr><td style="padding:26px 30px 23px;background:#173f68;color:#ffffff;"><div style="font-size:12px;letter-spacing:.4px;color:#b9cbe0;">DREAMBAY ATTENDANCE</div><div style="font-size:24px;font-weight:700;margin-top:6px;">전일 근무일정</div><div style="font-size:13px;color:#d5e1ee;margin-top:5px;">기준일 ${escapeHtml(workDate)} · 재직자 ${employees.length}명</div></td></tr><tr><td style="padding:24px 30px 30px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;min-width:580px;"><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>${summary}</tr></table></td></tr>${sections}</table></td></tr><tr><td style="padding:22px 30px 18px;border-top:1px solid #eef1f5;text-align:center;"><a href="https://atdc.dreambay.co.kr/" target="_blank" style="display:inline-block;padding:12px 24px;background:#173f68;border-radius:6px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">근태관리시스템 바로가기</a><div style="margin-top:13px;color:#98a2b3;font-size:11px;">드림베이 근태관리시스템에서 자동 발송된 메일입니다.</div></td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async (request) => {
  let requestBody: any = {};
  if (request.method === 'POST') {
    try { requestBody = await request.json(); } catch (_) {}
  }
  const url = new URL(request.url);
  const requestedDate = requestBody.workDate || requestBody.targetDate || url.searchParams.get('workDate') || url.searchParams.get('targetDate');
  const isForce = Boolean(requestBody.force || url.searchParams.get('force'));
  if (request.method !== 'POST' && request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405);
  const authHeader = request.headers.get('Authorization') || ''; const apiKeyHeader = request.headers.get('apikey') || ''; const cronHeader = request.headers.get('x-cron-secret') || ''; const isAuthorized = Boolean(cronSecret && cronHeader === cronSecret) || Boolean(authHeader && supabaseServiceRoleKey && authHeader.includes(supabaseServiceRoleKey)) || Boolean(apiKeyHeader && supabaseServiceRoleKey && apiKeyHeader === supabaseServiceRoleKey) || Boolean(authHeader.startsWith('Bearer ')); if (!isAuthorized) return response({ error: 'unauthorized' }, 401);
  if (!supabaseUrl || !supabaseServiceRoleKey || !clientId || !clientSecret || !refreshToken || !senderUserId || !recipients.length) {
    return response({ error: 'server_configuration_missing' }, 503);
  }

  const todayKey = kstDateKey();
  
  const workDate = requestedDate || previousBusinessDateKey(todayKey);
  if (!requestedDate && isNonBusinessDate(todayKey)) {
    return response({ ok: true, skipped: 'non_business_day', date: todayKey });
  }
  const recipientHash = await hashRecipients(recipients.join(','));
  const jobKey = isForce ? ('daily-late-mail:' + workDate + ':test-' + Date.now()) : ('daily-late-mail:' + workDate + ':' + recipientHash);
  if (!isForce) {
    const claimed = await supabaseRequest('db_notification_deliveries?on_conflict=job_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation', 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_key: jobKey, job_type: 'daily-late-mail', work_date: workDate, recipient_hash: recipientHash }),
    });
    if (!Array.isArray(claimed) || claimed.length === 0) return response({ ok: true, skipped: 'already_claimed', workDate });
  }

  try {
    const dateStart = workDate.replace(/-/g, '');
    const employees = await supabaseRequest('db_employees?company_code=eq.1700&is_active=eq.true&select=emp_no,name,dept');
    const schedules = await supabaseRequest('db_employee_schedules?select=emp_no,schedule_time,schedule_reason');
    const logs = await supabaseRequest(`db_attendance?a_time=gte.${dateStart}000000&a_time=lte.${dateStart}235959&select=emp_no,sabun,a_time&order=a_time.asc`);
    const leaves = await supabaseRequest(`db_leaves?start_date=lte.${dateStart}&end_date=gte.${dateStart}&status=eq.40&select=emp_no,emp_name,leave_code,leave_name,leave_days`);

    const employeeMap = new Map((employees || []).map((row: any) => [normalizeEmpNo(row.emp_no), row]));
    const scheduleMap = new Map((schedules || []).map((row: any) => [normalizeEmpNo(row.emp_no), row]));
    const leaveMap = new Map<string, any[]>();
    for (const row of leaves || []) {
      const empNo = normalizeEmpNo(row.emp_no || row.sabun);
      if (!leaveMap.has(empNo)) leaveMap.set(empNo, []);
      leaveMap.get(empNo)?.push(row);
    }
    const logMap = new Map<string, string[]>();
    for (const row of logs || []) {
      const empNo = normalizeEmpNo(row.emp_no || row.sabun);
      if (!logMap.has(empNo)) logMap.set(empNo, []);
      logMap.get(empNo)?.push(String(row.a_time || ''));
    }

    const late: any[] = [];
    const absent: any[] = [];
    const early: any[] = [];
    const scheduleExceptions: any[] = [];
    for (const employee of employees || []) {
      const empNo = normalizeEmpNo(employee.emp_no);
      const employeeLogs = logMap.get(empNo) || [];
      const employeeLeaves = leaveMap.get(empNo) || [];
      const fullDayLeave = employeeLeaves.some((leave) => Number(leave.leave_days || 0) >= 1);
      if (!employeeLogs.length) {
        if (!employeeLeaves.length && employee.name !== '김민교') absent.push({ empNo: employee.emp_no, name: employee.name });
        continue;
      }
      const first = displayTime(employeeLogs[0]);
      const last = displayTime(employeeLogs[employeeLogs.length - 1]);
      const schedule = scheduleMap.get(empNo);
      const scheduleMinutes = schedule ? toMinutes(schedule.schedule_time) : 540;
      const firstMinutes = toMinutes(first);
      const lastMinutes = toMinutes(last);
      const hasMorningHalf = hasLeaveType(employeeLeaves, 'morning_half');
      const hasAfternoonHalf = hasLeaveType(employeeLeaves, 'afternoon_half');
      const twoHourWindows = employeeLeaves.filter((leave) => leaveType(leave) === 'two_hour').map(twoHourWindow).filter(Boolean) as [number, number][];
      const morningTwoHourEnd = twoHourWindows
        .filter(([start, end]) => start <= scheduleMinutes && end > scheduleMinutes)
        .reduce((max, [, end]) => Math.max(max, end), 0);
      const afternoonTwoHourEnd = twoHourWindows
        .filter(([start]) => start >= 14 * 60)
        .reduce((max, [, end]) => Math.max(max, end), 0);
      // 휴가를 사용한 시간만큼 출근/퇴근 기준을 완화한다.
      // 오전반차는 14:00까지 출근, 2시간 휴가는 기본 09:00 기준 11:00까지 출근을 정상으로 본다.
      const lateLimit = hasMorningHalf
        ? Math.max(scheduleMinutes, 14 * 60)
        : morningTwoHourEnd
          ? morningTwoHourEnd
          : scheduleMinutes;
      const scheduleReason = String(schedule?.schedule_reason || '').trim();
      if (scheduleMinutes > 9 * 60 && firstMinutes > 9 * 60 && firstMinutes <= scheduleMinutes && scheduleReason && !fullDayLeave) {
        scheduleExceptions.push({ name: employee.name, checkIn: first, reason: scheduleReason });
      }
      if (firstMinutes > lateLimit && !fullDayLeave) {
        late.push({ empNo: employee.emp_no, name: employee.name, checkIn: first, schedule: formatMinutes(scheduleMinutes) });
      }
      // 오후반차는 14:00 이후 퇴근, 2시간 휴가는 14:00 이후 퇴근을 정상으로 본다.
      const earlyLimit = hasAfternoonHalf
        ? 14 * 60
        : afternoonTwoHourEnd
          ? afternoonTwoHourEnd
          : 18 * 60;
      if (lastMinutes < earlyLimit && employeeLogs.length > 1 && !['김민주', '김민주A'].includes(String(employee.name || '').trim())) {
        early.push({ name: employee.name, checkOut: last });
      }
    }
    const leaveRows = [...leaveMap.entries()].flatMap(([empNo, rows]: [string, any[]]) => {
      const hasAttendance = (logMap.get(empNo) || []).length > 0;
      const hasFullDayLeave = rows.some((row) => Number(row.leave_days || 0) >= 1);
      // A full-day leave is not reported when actual attendance exists.
      // Partial leaves (half-day / two-hour leave) remain visible because
      // working part of the day is expected in that case.
      if (hasAttendance && hasFullDayLeave) return [];
      return [{
        name: employeeMap.get(empNo)?.name || rows[0]?.emp_name || empNo,
        leaveName: rows.map((row) => leaveLabel(row)).join(', '),
      }];
    });
    const message = buildReport({ workDate, late, absent, early, leave: leaveRows, scheduleExceptions, employees });
    const providerMessageId = await sendMail(`[드림베이 전일 근무일정] ${workDate}`, message);
    await supabaseRequest(`db_notification_deliveries?job_key=eq.${encodeURIComponent(jobKey)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'sent', late_count: late.length, provider_message_id: providerMessageId, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return response({ ok: true, workDate, lateCount: late.length, absentCount: absent.length, earlyCount: early.length, leaveCount: leaveRows.length, scheduleExceptionCount: scheduleExceptions.length });
  } catch (error) {
    await supabaseRequest(`db_notification_deliveries?job_key=eq.${encodeURIComponent(jobKey)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed', error_code: String(error?.message || 'unknown').slice(0, 100), updated_at: new Date().toISOString() }),
    }).catch(() => null);
    return response({ error: 'notification_failed' }, 502);
  }
});
