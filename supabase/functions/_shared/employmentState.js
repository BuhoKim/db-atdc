// Pure presentation/report rules. No credentials or database writes.
function dateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value);
  }
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) return '';
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)) return '';
  return `${year}-${month}-${day}`;
}

export function employmentStateFields(employee = {}) {
  return { state_code: employee.state_code ?? null,
    employment_status: employee.employment_status ?? null, state_date: employee.state_date ?? null };
}

export function isEmployeeOnLeave(employee = {}, workDate = new Date()) {
  const status = String(employee?.employment_status || '').trim();
  const onLeave = status ? status === 'on_leave' : String(employee?.state_code || '').trim().padStart(3, '0') === '002';
  if (!onLeave) return false;
  const reportDate = dateKey(workDate);
  if (!reportDate) return false;
  const rawStart = employee?.state_date;
  // With no recorded effective date, honor the current HR leave status.
  if (rawStart === null || rawStart === undefined || String(rawStart).trim() === '') return true;
  const start = dateKey(rawStart);
  return Boolean(start && start <= reportDate);
}
