const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const context = vm.createContext({ Date, Intl });
vm.runInContext(read('supabase/functions/_shared/employmentState.js').replace(/export /g, ''), context);
const isOnLeave = context.isEmployeeOnLeave;

test('same shared rule is used by the website and the mail function', () => {
  assert.match(read('src/lib/employmentState.js'), /supabase\/functions\/_shared\/employmentState\.js/);
  assert.match(read('supabase/functions/daily-late-mail/index.ts'), /from '\.\.\/_shared\/employmentState\.js'/);
  assert.match(read('src/components/EmploymentLeaveBadge.js'), /isEmployeeOnLeave\(employee, date\)/);
});

test('leave status applies inclusively from state_date, not retroactively', () => {
  const employee = { employment_status: 'on_leave', state_code: '002', state_date: '2026-10-20' };
  assert.equal(isOnLeave(employee, '2026-10-19'), false);
  assert.equal(isOnLeave(employee, '2026-10-20'), true);
  assert.equal(isOnLeave(employee, '2026-10-21'), true);
  assert.equal(isOnLeave(employee, '20261020'), true);
  assert.equal(isOnLeave(employee, new Date('2026-10-19T15:00:00Z')), true);
});

test('fallback status and missing/invalid dates never invent an effective date', () => {
  assert.equal(isOnLeave({ state_code: '002', state_date: '2026-10-20' }, '2026-10-20'), true);
  assert.equal(isOnLeave({ employment_status: 'on_leave', state_date: null }, '2026-10-20'), true);
  assert.equal(isOnLeave({ employment_status: 'on_leave', state_date: '2026-02-30' }, '2026-10-20'), false);
  for (const employee of [null, undefined, {}, { employment_status: 'active' }, { employment_status: 'resigned' }]) {
    assert.equal(isOnLeave(employee, '2026-10-20'), false);
  }
});

test('real badge renderer shows leave beside a name without changing stored employee name', () => {
  // Next's JSX transform, using the same transpiler bundled with the installed app.
  const ts = require('next/dist/compiled/babel/core');
  const transformed = ts.transformSync(read('src/components/EmploymentLeaveBadge.js'), {
    filename: 'EmploymentLeaveBadge.js', babelrc: false, configFile: false,
    presets: [require.resolve('next/babel')],
  });
  const componentContext = vm.createContext({ exports: {}, require: name => {
    if (name.includes('employmentState')) return { isEmployeeOnLeave: isOnLeave };
    if (name.startsWith('@babel/runtime/')) return require('next/dist/compiled/' + name);
    return require(name);
  }, process });
  vm.runInContext(transformed.code, componentContext);
  const Badge = componentContext.exports.default;
  const employee = { name: 'FixtureLeave', employment_status: 'on_leave', state_date: '2026-10-20' };
  const element = Badge({ employee, date: '2026-10-20' });
  assert.equal(element.props.children, '휴직');
  assert.equal(element.props.title, '휴직 적용일: 2026-10-20');
  assert.equal(employee.name, 'FixtureLeave');
  assert.equal(Badge({ employee, date: '2026-10-19' }), null);
});

test('employment fields survive both attendance API projections and every main employee view', () => {
  for (const file of ['src/app/api/attendance/route.js', 'src/app/api/attendance-records/route.js']) {
    assert.match(read(file), /employmentStateFields\(/);
  }
  for (const file of ['src/app/employees/page.js', 'src/components/tabs/DashboardTab.js',
    'src/components/tabs/MonthlyTab.js', 'src/app/attendance-records/page.js', 'src/components/DashboardCalendarWidget.js']) {
    assert.match(read(file), /<EmploymentLeaveBadge employee=\{/);
  }
});
