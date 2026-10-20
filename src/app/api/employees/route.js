import { requireApiSession, privateJson, internalError } from '@/lib/apiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getReadableDataSources, scopeEmpNo } from '@/lib/supabaseDb';

export const dynamic = 'force-dynamic';
const COMPANY_CODE = '1700';

function validPassword(value, empNo = '', loginId = '') {
  const password = String(value || '');
  if (password.length < 8 || password.length > 128) return false;
  if ([empNo, loginId, '1234', 'password'].filter(Boolean).some((v) => password.toLowerCase().includes(String(v).toLowerCase()))) return false;
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((p) => p.test(password)).length >= 3;
}

function cleanEmployeeInput(body) {
  const empNo = String(body.emp_no || '').trim();
  const name = String(body.name || '').trim();
  const dept = String(body.dept || '소속미지정').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const loginId = String(body.login_id || empNo).trim();

  if (!/^\d{4,20}$/.test(empNo)) throw new Error('사번은 4~20자리 숫자여야 합니다.');
  if (!name || name.length > 100) throw new Error('성명 형식이 올바르지 않습니다.');
  if (!dept || dept.length > 100) throw new Error('부서 형식이 올바르지 않습니다.');
  if (!/^[A-Za-z0-9._-]{2,100}$/.test(loginId)) throw new Error('로그인 ID 형식이 올바르지 않습니다.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('유효한 이메일이 필요합니다.');

  return { empNo, name, dept, email, loginId };
}

function cleanScheduleInput(body) {
  const scheduleTime = String(body.schedule_time ?? '09:00').trim();
  const scheduleReason = String(body.schedule_reason ?? '').trim();
  const match = scheduleTime.match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('출근시간은 HH:MM 형식으로 입력해 주세요.');
  }
  if (scheduleReason.length > 500) {
    throw new Error('출근시간 지정 사유는 500자 이내로 입력해 주세요.');
  }
  if (scheduleTime !== '09:00' && !scheduleReason) {
    throw new Error('기본 출근시간이 09:00과 다르면 지정 사유를 입력해 주세요.');
  }
  return { scheduleTime, scheduleReason };
}

export async function GET(request) {
  try {
    const auth = await requireApiSession(request, { roles: ['authenticated'] });
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const search = String(searchParams.get('q') || '').trim().slice(0, 100);
    const dept = String(searchParams.get('dept') || 'ALL').slice(0, 100);
    const status = searchParams.get('status') || 'ALL';

    const includeAllCompanies = false;
    const sourceResults = await Promise.all(getReadableDataSources(includeAllCompanies).map(async (source) => {
      let query = supabaseAdmin
        .from(`${source.prefix}_employees`)
        .select('emp_no,name,dept,email,login_id,company_code,is_active,synced_at,state_code,employment_status,state_date')
        .order('is_active', { ascending: false })
        .order('dept', { ascending: true })
        .order('name', { ascending: true });

      if (status === 'ACTIVE') query = query.eq('is_active', true);
      else if (status === 'INACTIVE') query = query.eq('is_active', false);
      if (dept !== 'ALL') query = query.eq('dept', dept);

      const [
        { data: employees, error: employeeError },
        { data: profiles, error: profileError },
        { data: schedules, error: scheduleError },
      ] = await Promise.all([
        query,
        supabaseAdmin.from(`${source.prefix}_profiles`).select('emp_no,is_admin,rank,position,must_change_password'),
        supabaseAdmin.from(`${source.prefix}_employee_schedules`).select('emp_no,schedule_time,schedule_reason'),
      ]);
      if (employeeError) throw employeeError;
      if (profileError) throw profileError;
      if (scheduleError) throw scheduleError;
      return { source, employees: employees || [], profiles: profiles || [], schedules: schedules || [] };
    }));

    let results = sourceResults.flatMap(({ source, employees, profiles, schedules }) => {
      const profileMap = new Map(profiles.map((profile) => [String(profile.emp_no), profile]));
      const scheduleMap = new Map(schedules.map((schedule) => [String(schedule.emp_no), schedule]));
      return employees.map((employee) => {
        const profile = profileMap.get(String(employee.emp_no));
        const schedule = scheduleMap.get(String(employee.emp_no));
        return {
          ...employee,
          raw_emp_no: employee.emp_no,
          emp_no: scopeEmpNo(employee.emp_no, source.companyCode, includeAllCompanies),
          company_code: employee.company_code || source.companyCode,
          data_source: source.prefix,
          read_only: source.prefix === 'sa',
          is_admin: profile?.is_admin === true,
          rank: profile?.rank || '',
          position: profile?.position || '',
          must_change_password: profile?.must_change_password === true,
          schedule_time: schedule?.schedule_time ? String(schedule.schedule_time).slice(0, 5) : '09:00',
          schedule_reason: schedule?.schedule_reason || '',
        };
      });
    });

    // kmk is a functional login account, but is intentionally hidden from the
    // employee-management directory. This does not affect authentication or
    // any data access performed after login.
    results = results.filter((employee) => String(employee.login_id || '').toLowerCase() !== 'kmk');

    if (search) {
      const lower = search.toLowerCase();
      results = results.filter((employee) => [employee.name, employee.emp_no, employee.dept, employee.email, employee.login_id]
        .some((value) => String(value || '').toLowerCase().includes(lower)));
    }

    const departments = [...new Set(results.map((employee) => employee.dept).filter(Boolean))].sort();
    return privateJson({
      success: true,
      employees: results,
      totalCount: results.length,
      departments,
      canManage: true,
    });
  } catch (error) {
    return internalError('employees GET error:', error, '직원 목록을 불러오지 못했습니다.');
  }
}

export async function POST(request) {
  try {
    const auth = await requireApiSession(request, { roles: ['authenticated'], mutation: true });
    if (auth.response) return auth.response;

    const body = await request.json().catch(() => ({}));
    let clean;
    let schedule;
    try {
      clean = cleanEmployeeInput(body);
      schedule = cleanScheduleInput(body);
    } catch (error) {
      return privateJson({ success: false, error: error.message }, { status: 400 });
    }

    if (!validPassword(body.password, clean.empNo, clean.loginId)) {
      return privateJson({ success: false, error: '초기 비밀번호는 8자 이상이며 3종 이상의 문자 조합이어야 합니다.' }, { status: 400 });
    }

    const { data: existing } = await supabaseAdmin.from('db_employees').select('emp_no').eq('emp_no', clean.empNo).maybeSingle();
    if (existing) return privateJson({ success: false, error: '이미 등록된 사번입니다.' }, { status: 409 });

    const { data: authResult, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: clean.email,
      password: String(body.password),
      email_confirm: true,
      user_metadata: { name: clean.name, emp_no: clean.empNo, login_id: clean.loginId },
    });
    if (authError || !authResult?.user?.id) throw authError || new Error('인증 계정을 생성하지 못했습니다.');

    const employee = {
      emp_no: clean.empNo,
      name: clean.name,
      dept: clean.dept,
      email: clean.email,
      login_id: clean.loginId,
      company_code: COMPANY_CODE,
      is_active: true,
      synced_at: new Date().toISOString(),
    };

    const { error: employeeError } = await supabaseAdmin.from('db_employees').insert(employee);
    if (employeeError) {
      await supabaseAdmin.auth.admin.deleteUser(authResult.user.id).catch(() => null);
      throw employeeError;
    }

    const { error: profileError } = await supabaseAdmin.from('db_profiles').insert({
      id: authResult.user.id,
      emp_no: clean.empNo,
      dept: clean.dept,
      rank: String(body.rank || '').trim().slice(0, 50),
      position: String(body.position || '').trim().slice(0, 50),
      is_admin: body.is_admin === true,
      must_change_password: true,
    });
    if (profileError) throw profileError;

    const { error: scheduleError } = await supabaseAdmin.from('db_employee_schedules').upsert({
      emp_no: clean.empNo,
      schedule_time: schedule.scheduleTime,
      schedule_reason: schedule.scheduleReason || null,
      updated_by: auth.session.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'emp_no' });
    if (scheduleError) throw scheduleError;

    return privateJson({ success: true, message: `${clean.name}(${clean.empNo}) 직원이 등록되었습니다.` }, { status: 201 });
  } catch (error) {
    return internalError('employees POST error:', error, '직원을 등록하지 못했습니다.');
  }
}

export async function PUT(request) {
  try {
    const auth = await requireApiSession(request, { roles: ['authenticated'], mutation: true });
    if (auth.response) return auth.response;

    const body = await request.json().catch(() => ({}));
    const empNo = String(body.emp_no || '').trim();
    if (!/^\d{4,20}$/.test(empNo)) return privateJson({ success: false, error: '유효한 사번이 필요합니다.' }, { status: 400 });
    if (empNo === auth.session.empNo && (body.is_admin === false || body.is_active === false)) {
      return privateJson({ success: false, error: '현재 로그인한 관리자 자신의 권한이나 재직 상태는 해제할 수 없습니다.' }, { status: 400 });
    }

    let schedule = null;
    if (body.schedule_time !== undefined || body.schedule_reason !== undefined) {
      try {
        schedule = cleanScheduleInput(body);
      } catch (error) {
        return privateJson({ success: false, error: error.message }, { status: 400 });
      }
    }

    const updatePayload = { synced_at: new Date().toISOString() };
    if (body.name !== undefined) updatePayload.name = String(body.name).trim().slice(0, 100);
    if (body.dept !== undefined) updatePayload.dept = String(body.dept).trim().slice(0, 100);
    if (body.email !== undefined) updatePayload.email = String(body.email).trim().toLowerCase();
    if (body.login_id !== undefined) updatePayload.login_id = String(body.login_id).trim().slice(0, 100);
    if (body.is_active !== undefined) updatePayload.is_active = body.is_active === true;

    const { error: employeeError } = await supabaseAdmin.from('db_employees').update(updatePayload).eq('emp_no', empNo);
    if (employeeError) throw employeeError;

    const profilePayload = { updated_at: new Date().toISOString() };
    if (body.is_admin !== undefined) profilePayload.is_admin = body.is_admin === true;
    if (body.rank !== undefined) profilePayload.rank = String(body.rank).trim().slice(0, 50);
    if (body.position !== undefined) profilePayload.position = String(body.position).trim().slice(0, 50);
    if (body.dept !== undefined) profilePayload.dept = String(body.dept).trim().slice(0, 100);

    if (Object.keys(profilePayload).length > 1) {
      const { error: profileError } = await supabaseAdmin.from('db_profiles').update(profilePayload).eq('emp_no', empNo);
      if (profileError) throw profileError;
    }

    if (schedule) {
      const { error: scheduleError } = await supabaseAdmin.from('db_employee_schedules').upsert({
        emp_no: empNo,
        schedule_time: schedule.scheduleTime,
        schedule_reason: schedule.scheduleReason || null,
        updated_by: auth.session.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'emp_no' });
      if (scheduleError) throw scheduleError;
    }

    if (body.new_password !== undefined) {
      const loginId = String(body.login_id || empNo);
      if (!validPassword(body.new_password, empNo, loginId)) {
        return privateJson({ success: false, error: '새 비밀번호는 8자 이상이며 3종 이상의 문자 조합이어야 합니다.' }, { status: 400 });
      }
      const { data: profile } = await supabaseAdmin.from('db_profiles').select('id').eq('emp_no', empNo).maybeSingle();
      if (!profile?.id) return privateJson({ success: false, error: '연결된 인증 계정이 없습니다.' }, { status: 404 });
      const { error: passwordError } = await supabaseAdmin.auth.admin.updateUserById(profile.id, { password: String(body.new_password) });
      if (passwordError) throw passwordError;
      await supabaseAdmin.from('db_profiles').update({ must_change_password: true, updated_at: new Date().toISOString() }).eq('id', profile.id);
    }

    return privateJson({ success: true, message: `${empNo} 직원 정보가 수정되었습니다.` });
  } catch (error) {
    return internalError('employees PUT error:', error, '직원 정보를 수정하지 못했습니다.');
  }
}

export async function DELETE(request) {
  try {
    const auth = await requireApiSession(request, { roles: ['authenticated'], mutation: true });
    if (auth.response) return auth.response;

    const empNo = String(new URL(request.url).searchParams.get('emp_no') || '').trim();
    if (!/^\d{4,20}$/.test(empNo)) return privateJson({ success: false, error: '유효한 사번이 필요합니다.' }, { status: 400 });
    if (empNo === auth.session.empNo) return privateJson({ success: false, error: '현재 로그인한 관리자 계정은 삭제할 수 없습니다.' }, { status: 400 });

    const { data: profile } = await supabaseAdmin.from('db_profiles').select('id').eq('emp_no', empNo).maybeSingle();
    if (profile?.id) {
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(profile.id);
      if (authError) throw authError;
    } else {
      await supabaseAdmin.from('db_profiles').delete().eq('emp_no', empNo);
    }

    const { error: employeeError } = await supabaseAdmin.from('db_employees').delete().eq('emp_no', empNo);
    if (employeeError) throw employeeError;
    return privateJson({ success: true, message: `사번 ${empNo} 직원이 삭제되었습니다.` });
  } catch (error) {
    return internalError('employees DELETE error:', error, '직원을 삭제하지 못했습니다.');
  }
}
