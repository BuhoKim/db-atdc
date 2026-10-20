// HR source fields are independent from a locally disabled employee account.
const EMPLOYMENT_STATES = Object.freeze({ '001': 'active', '002': 'on_leave', '999': 'resigned' });

function normalizeStateCode(value) {
  const raw = String(value ?? '').trim();
  return /^\d{1,3}$/.test(raw) ? raw.padStart(3, '0') : '';
}

function normalizeStateDate(value) {
  if (value === null || value === undefined || value === '') return null;
  let text;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // MySQL DATE/DATETIME is an HR calendar date, not a UTC instant.
    text = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  } else {
    text = String(value).trim();
  }
  const match = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:$|[ T])/)
    || text.match(/^(\d{4})(\d{2})(\d{2})\d{6}$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function mapEmployeeState(row, existing = null) {
  const code = normalizeStateCode(row.state_code ?? row.I_STATE_CODE);
  const status = EMPLOYMENT_STATES[code];
  const state = status ? {
    state_code: code,
    employment_status: status,
    state_date: normalizeStateDate(row.state_date ?? row.D_STATE_DATE),
  } : {
    // An empty/unknown source value must not reset an already confirmed state.
    state_code: existing?.state_code ?? null,
    employment_status: existing?.employment_status ?? null,
    state_date: existing?.state_date ?? null,
  };
  const retired = status ? status === 'resigned'
    : String(row.retire_yn ?? row.I_RETIRE_YN ?? '').trim() === '1';
  return { ...state, is_active: retired ? false : (existing ? existing.is_active !== false : true) };
}

module.exports = { EMPLOYMENT_STATES, normalizeStateCode, normalizeStateDate, mapEmployeeState };
