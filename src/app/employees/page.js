'use client';

import React, { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import AppSidebar from '../../components/AppSidebar';
import { usePersistentTheme } from '../../lib/usePersistentTheme';
import {
  Users,
  UserPlus,
  Search,
  Filter,
  KeyRound,
  Edit2,
  Trash2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Building2,
  RefreshCw,
  Download,
  X,
  Lock,
} from 'lucide-react';
import * as XLSX from 'xlsx';

const HR_STATE_LABELS = { active: '재직', on_leave: '휴직', resigned: '퇴직' };
function hrStateLabel(employee) { return HR_STATE_LABELS[employee.employment_status] || '-'; }

function EmployeesPageContent() {
  const [theme, setTheme] = usePersistentTheme('light');
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [canManageEmployees, setCanManageEmployees] = useState(false);
  const [loading, setLoading] = useState(true);

  // 검색 및 필터
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState('ALL'); // ALL, ACTIVE, INACTIVE

  // 모달 상태
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);

  // 폼 상태
  const [formData, setFormData] = useState({
    emp_no: '',
    name: '',
    dept: '경영지원팀',
    rank: '',
    position: '',
    email: '',
    login_id: '',
    password: '',
    is_admin: false,
    is_active: true,
    schedule_time: '09:00',
    schedule_reason: '',
  });

  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);

  // 데이터 로드
  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/employees');
      const data = await res.json();
      if (data.success) {
        setEmployees(data.employees || []);
        setDepartments(data.departments || []);
        setCanManageEmployees(data.canManage === true);
      }
    } catch (e) {
      console.error('Failed to fetch employees:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEmployees();
  }, [fetchEmployees]);

  // 알림 메시지 자동 제거
  const showToast = (msg, type = 'success') => {
    setActionMessage({ text: msg, type });
    setTimeout(() => setActionMessage(null), 3500);
  };

  // 필터링된 직원 목록
  const filteredEmployees = useMemo(() => {
    return employees.filter((emp) => {
      // 1. 상태 필터
      if (selectedStatus === 'ACTIVE' && !emp.is_active) return false;
      if (selectedStatus === 'INACTIVE' && emp.is_active) return false;

      // 2. 부서 필터
      if (selectedDept !== 'ALL' && emp.dept !== selectedDept) return false;

      // 3. 검색어 필터
      if (searchTerm) {
        const lower = searchTerm.toLowerCase();
        const matchName = String(emp.name || '').toLowerCase().includes(lower);
        const matchEmpNo = String(emp.emp_no || '').toLowerCase().includes(lower);
        const matchDept = String(emp.dept || '').toLowerCase().includes(lower);
        const matchEmail = String(emp.email || '').toLowerCase().includes(lower);
        return matchName || matchEmpNo || matchDept || matchEmail;
      }

      return true;
    });
  }, [employees, selectedStatus, selectedDept, searchTerm]);

  // 통계 계산
  const stats = useMemo(() => {
    const total = employees.length;
    const active = employees.filter((e) => e.is_active).length;
    const inactive = total - active;
    const admins = employees.filter((e) => e.is_admin).length;
    return { total, active, inactive, admins, deptCount: departments.length };
  }, [employees, departments]);

  // [신규 등록] 모달 열기
  const handleOpenAddModal = () => {
    setFormData({
      emp_no: '',
      name: '',
      dept: departments[0] || '경영지원팀',
      rank: '사원',
      position: '팀원',
      email: '',
      login_id: '',
      password: '',
      is_admin: false,
      is_active: true,
      schedule_time: '09:00',
      schedule_reason: '',
    });
    setIsAddModalOpen(true);
  };

  // [신규 등록] 제출
  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!formData.emp_no || !formData.name) {
      alert('사번과 이름을 입력해주세요.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        setIsAddModalOpen(false);
        fetchEmployees();
      } else {
        alert('등록 실패: ' + data.error);
      }
    } catch (err) {
      alert('오류 발생: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // [수정] 모달 열기
  const handleOpenEditModal = (emp) => {
    setSelectedEmp(emp);
    setFormData({
      emp_no: emp.emp_no,
      name: emp.name || '',
      dept: emp.dept || '경영지원팀',
      rank: emp.rank || '',
      position: emp.position || '',
      email: emp.email || '',
      login_id: emp.login_id || emp.emp_no,
      is_admin: Boolean(emp.is_admin),
      is_active: Boolean(emp.is_active),
      schedule_time: emp.schedule_time || '09:00',
      schedule_reason: emp.schedule_reason || '',
    });
    setIsEditModalOpen(true);
  };

  // [수정] 제출
  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/employees', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        setIsEditModalOpen(false);
        fetchEmployees();
      } else {
        alert('수정 실패: ' + data.error);
      }
    } catch (err) {
      alert('오류 발생: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // [비밀번호 변경] 모달 열기
  const handleOpenPasswordModal = (emp) => {
    setSelectedEmp(emp);
    setNewPassword('');
    setIsPasswordModalOpen(true);
  };

  // [비밀번호 변경] 제출
  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (!newPassword) {
      alert('새 비밀번호를 입력해주세요.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/employees', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emp_no: selectedEmp.emp_no,
          new_password: newPassword,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`${selectedEmp.name}님의 비밀번호가 성공적으로 변경되었습니다.`);
        setIsPasswordModalOpen(false);
      } else {
        alert('비밀번호 변경 실패: ' + data.error);
      }
    } catch (err) {
      alert('오류 발생: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // [삭제] 실행
  const handleDelete = async (emp) => {
    if (!confirm(`정말로 ${emp.name}(사번: ${emp.emp_no}) 직원을 삭제하시겠습니까?\n출입기록 등의 외래키 연동에 영향을 줄 수 있습니다.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/employees?emp_no=${emp.emp_no}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        fetchEmployees();
      } else {
        alert('삭제 실패: ' + data.error);
      }
    } catch (err) {
      alert('오류 발생: ' + err.message);
    }
  };

  // [엑셀 다운로드]
  const handleExportExcel = () => {
    try {
      const headers = ['사번', '성명', '부서', '직급', '직책', '이메일', '로그인ID', '재직상태', '인사상태', '상태코드', '적용일자', '관리자권한', '등록일시'];
      const rows = filteredEmployees.map((e) => [
        e.raw_emp_no || e.emp_no,
        e.name,
        e.dept,
        e.rank || '-',
        e.position || '-',
        e.email || '-',
        e.login_id || '-',
        e.is_active ? '재직' : '퇴사',
        hrStateLabel(e),
        e.state_code || '-',
        e.state_date || '-',
        e.is_admin ? '관리자' : '일반',
        e.synced_at ? e.synced_at.slice(0, 10) : '-',
      ]);

      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '드림베이_임직원명부');
      XLSX.writeFile(wb, `드림베이_임직원명부_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      alert('엑셀 다운로드 실패: ' + err.message);
    }
  };

  return (
    <div className="ga-theme" data-theme={theme}>
      <AppSidebar activeTab="EMPLOYEES" theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />

      <main className="main-content" style={{ flexGrow: 1, padding: '24px 32px', overflowY: 'auto' }}>
        {/* 알림 토스트 */}
        {actionMessage && (
          <div
            style={{
              position: 'fixed',
              top: '20px',
              right: '24px',
              zIndex: 9999,
              background: actionMessage.type === 'success' ? 'var(--blue)' : 'var(--red)',
              color: '#ffffff',
              padding: '12px 20px',
              borderRadius: '10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              fontWeight: 600,
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              animation: 'slideIn 0.25s ease',
            }}
          >
            <CheckCircle2 size={18} />
            <span>{actionMessage.text}</span>
          </div>
        )}

        {/* 상단 타이틀 및 액션 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '14px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-0.02em', margin: 0 }}>
                직원 및 계정 관리
              </h2>
              <span className="badge-status badge-blue" style={{ fontSize: '12px', padding: '3px 8px' }}>
                드림베이
              </span>
            </div>
            <p style={{ fontSize: '13.5px', color: 'var(--text-2)', marginTop: '4px', margin: 0 }}>
              드림베이 소속 임직원 명부 관리 및 웹 로그인 계정/비밀번호를 설정합니다.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={fetchEmployees}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '38px' }}
              title="새로고침"
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
              <span>새로고침</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleExportExcel}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '38px' }}
              title="명부 엑셀 다운로드"
            >
              <Download size={15} />
              <span>엑셀 다운로드</span>
            </button>

            {canManageEmployees && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleOpenAddModal}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '38px', fontWeight: 700 }}
              >
                <UserPlus size={16} />
                <span>+ 신규 직원 등록</span>
              </button>
            )}
          </div>
        </div>

        {/* 상단 통계 카드 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
          <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.12)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Users size={22} />
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-3)', fontWeight: 600 }}>총 임직원</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-1)' }}>{stats.total}명</div>
            </div>
          </div>

          <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: 'rgba(16, 185, 129, 0.12)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CheckCircle2 size={22} />
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-3)', fontWeight: 600 }}>재직 중</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-1)' }}>{stats.active}명</div>
            </div>
          </div>

          <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: 'rgba(99, 102, 241, 0.12)', color: 'var(--purple)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Building2 size={22} />
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-3)', fontWeight: 600 }}>소속 부서</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-1)' }}>{stats.deptCount}개 부서</div>
            </div>
          </div>

          <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: 'rgba(245, 158, 11, 0.12)', color: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ShieldCheck size={22} />
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-3)', fontWeight: 600 }}>관리자 계정</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-1)' }}>{stats.admins}명</div>
            </div>
          </div>
        </div>

        {/* 검색 및 필터 컨트롤 */}
        <div className="card" style={{ padding: '16px 20px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {/* 검색창 */}
            <div style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
              <input
                type="text"
                placeholder="사번, 이름, 부서, 이메일 검색..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input-field"
                style={{ width: '100%', paddingLeft: '36px', height: '38px' }}
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* 부서 필터 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12.5px', color: 'var(--text-2)', fontWeight: 600 }}>부서:</span>
              <select
                value={selectedDept}
                onChange={(e) => setSelectedDept(e.target.value)}
                className="input-field"
                style={{ height: '38px', minWidth: '130px', padding: '6px 10px' }}
              >
                <option value="ALL">전체 부서 ({employees.length})</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            {/* 상태 필터 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12.5px', color: 'var(--text-2)', fontWeight: 600 }}>상태:</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  className={`btn-filter${selectedStatus === 'ALL' ? ' active' : ''}`}
                  onClick={() => setSelectedStatus('ALL')}
                >
                  전체
                </button>
                <button
                  type="button"
                  className={`btn-filter${selectedStatus === 'ACTIVE' ? ' active' : ''}`}
                  onClick={() => setSelectedStatus('ACTIVE')}
                >
                  재직
                </button>
                <button
                  type="button"
                  className={`btn-filter${selectedStatus === 'INACTIVE' ? ' active' : ''}`}
                  onClick={() => setSelectedStatus('INACTIVE')}
                >
                  퇴사
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 직원 목록 테이블 */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '100px', textAlign: 'center' }}>사번</th>
                  <th style={{ width: '110px', textAlign: 'center' }}>성명</th>
                  <th style={{ width: '130px' }}>소속 부서</th>
                  <th style={{ width: '90px' }}>직급</th>
                  <th style={{ width: '90px' }}>직책</th>
                  <th style={{ width: '160px' }}>이메일</th>
                  <th style={{ width: '110px' }}>로그인 ID</th>
                  <th style={{ width: '105px', textAlign: 'center' }}>출근 기준</th>
                  <th style={{ width: '80px', textAlign: 'center' }}>재직상태</th>
                  <th style={{ width: '85px', textAlign: 'center' }} title="인사시스템 I_STATE_CODE">인사상태</th>
                  <th style={{ width: '110px', textAlign: 'center' }} title="인사시스템 D_STATE_DATE">적용일자</th>
                  <th style={{ width: '80px', textAlign: 'center' }}>권한</th>
                  <th style={{ width: '130px', textAlign: 'center' }}>관리 액션</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={13} style={{ textAlign: 'center', padding: '60px 16px', color: 'var(--text-3)' }}>
                      <RefreshCw size={24} className="spin" style={{ margin: '0 auto 10px', display: 'block', color: 'var(--blue)' }} />
                      직원 목록을 불러오는 중입니다...
                    </td>
                  </tr>
                ) : filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={13} style={{ textAlign: 'center', padding: '60px 16px', color: 'var(--text-3)' }}>
                      조건에 일치하는 직원이 없습니다.
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => (
                    <tr key={emp.emp_no} style={{ opacity: emp.is_active ? 1 : 0.6 }}>
                      <td style={{ textAlign: 'center', fontWeight: 700, fontFamily: 'monospace' }}>
                        {emp.raw_emp_no || emp.emp_no}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-1)' }}>
                        {emp.name}
                      </td>
                      <td style={{ color: 'var(--text-1)', fontWeight: 500 }}>
                        {emp.dept || '-'}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: '12px' }}>
                        {emp.rank || '-'}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: '12px' }}>
                        {emp.position || '-'}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: '12px' }}>
                        {emp.email || '-'}
                      </td>
                      <td style={{ color: 'var(--text-1)', fontSize: '12px', fontFamily: 'monospace' }}>
                        {emp.login_id || emp.emp_no}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          className={`badge-status ${emp.schedule_time !== '09:00' ? 'badge-purple' : ''}`}
                          title={emp.schedule_reason || '기본 출근시간'}
                        >
                          {emp.schedule_time || '09:00'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {emp.is_active ? (
                          <span className="badge-status badge-checkin">재직</span>
                        ) : (
                          <span className="badge-status badge-red">퇴사</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={`badge-status ${emp.employment_status === 'on_leave' ? 'badge-amber' : emp.employment_status === 'resigned' ? 'badge-red' : emp.employment_status === 'active' ? 'badge-checkin' : 'badge-gray'}`}
                          title={emp.state_code ? `I_STATE_CODE: ${emp.state_code}` : '직원정보 동기화 후 표시됩니다'}>
                          {hrStateLabel(emp)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center', fontSize: '12px', whiteSpace: 'nowrap' }}>{emp.state_date || '-'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {emp.is_admin ? (
                          <span className="badge-status badge-purple" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                            <ShieldCheck size={12} /> 관리자
                          </span>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>일반</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {emp.read_only ? (
                          <span className="badge-status badge-purple">조회 전용</span>
                        ) : <div style={{ display: 'inline-flex', gap: '4px' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 8px', height: '28px', fontSize: '11px' }}
                            onClick={() => handleOpenEditModal(emp)}
                            title="정보 수정"
                          >
                            <Edit2 size={12} />
                            <span>수정</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 8px', height: '28px', fontSize: '11px', color: 'var(--amber)' }}
                            onClick={() => handleOpenPasswordModal(emp)}
                            title="비밀번호 재설정"
                          >
                            <KeyRound size={12} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 6px', height: '28px', fontSize: '11px', color: 'var(--red)' }}
                            onClick={() => handleDelete(emp)}
                            title="직원 삭제"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ─── [모달 1] 신규 직원 등록 ─── */}
        {isAddModalOpen && (
          <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, backdropFilter: 'blur(3px)' }}>
            <div className="card" style={{ width: '100%', maxWidth: '480px', maxHeight: '90vh', overflowY: 'auto', padding: '24px', position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <UserPlus size={20} color="var(--blue)" />
                  신규 직원 및 로그인 계정 등록
                </h3>
                <button type="button" onClick={() => setIsAddModalOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>사번 (필수) *</label>
                    <input
                      type="text"
                      required
                      placeholder="예: 20260015"
                      value={formData.emp_no}
                      onChange={(e) => setFormData({ ...formData, emp_no: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>성명 (필수) *</label>
                    <input
                      type="text"
                      required
                      placeholder="예: 홍길동"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>소속 부서</label>
                    <input
                      type="text"
                      placeholder="부서명 입력"
                      value={formData.dept}
                      onChange={(e) => setFormData({ ...formData, dept: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>직급</label>
                    <input
                      type="text"
                      placeholder="예: 사원, 대리, 과장"
                      value={formData.rank}
                      onChange={(e) => setFormData({ ...formData, rank: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>직책</label>
                    <input
                      type="text"
                      placeholder="예: 팀원, 팀장, 실장"
                      value={formData.position}
                      onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>로그인 ID</label>
                    <input
                      type="text"
                      placeholder="미입력 시 사번 자동사용"
                      value={formData.login_id}
                      onChange={(e) => setFormData({ ...formData, login_id: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>이메일</label>
                  <input
                    type="email"
                    placeholder="example@hecto.co.kr"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="input-field"
                    style={{ width: '100%', height: '36px' }}
                  />
                </div>

                <div style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--bg-card-2)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-1)', marginBottom: '10px' }}>개인별 출근 기준</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>출근시간</label>
                      <input
                        type="time"
                        required
                        value={formData.schedule_time}
                        onChange={(e) => setFormData({ ...formData, schedule_time: e.target.value })}
                        className="input-field"
                        style={{ width: '100%', height: '36px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>지정 사유</label>
                      <input
                        type="text"
                        maxLength={500}
                        required={formData.schedule_time !== '09:00'}
                        placeholder="09:00과 다른 경우 필수"
                        value={formData.schedule_reason}
                        onChange={(e) => setFormData({ ...formData, schedule_reason: e.target.value })}
                        className="input-field"
                        style={{ width: '100%', height: '36px' }}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>초기 로그인 비밀번호</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="input-field"
                    style={{ width: '100%', height: '36px' }}
                  />
                  <small style={{ color: 'var(--text-3)', fontSize: '11px', marginTop: '2px', display: 'block' }}>8자 이상, 영문·숫자·특수문자 조합으로 입력하세요.</small>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
                  <input
                    type="checkbox"
                    id="is_admin_check"
                    checked={formData.is_admin}
                    onChange={(e) => setFormData({ ...formData, is_admin: e.target.checked })}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="is_admin_check" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-1)', cursor: 'pointer' }}>
                    관리자 권한 부여 (직원 관리 및 전체 설정 가능)
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setIsAddModalOpen(false)}>
                    취소
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? '등록 중...' : '직원 및 계정 생성'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ─── [모달 2] 직원 정보 수정 ─── */}
        {isEditModalOpen && selectedEmp && (
          <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, backdropFilter: 'blur(3px)' }}>
            <div className="card" style={{ width: '100%', maxWidth: '480px', maxHeight: '90vh', overflowY: 'auto', padding: '24px', position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Edit2 size={18} color="var(--blue)" />
                  직원 정보 수정 ({selectedEmp.name})
                </h3>
                <button type="button" onClick={() => setIsEditModalOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>사번 (고유)</label>
                    <input
                      type="text"
                      disabled
                      value={formData.emp_no}
                      className="input-field"
                      style={{ width: '100%', height: '36px', opacity: 0.6, background: 'var(--bg-card-2)' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>성명</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>소속 부서</label>
                    <input
                      type="text"
                      value={formData.dept}
                      onChange={(e) => setFormData({ ...formData, dept: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>직급</label>
                    <input
                      type="text"
                      value={formData.rank}
                      onChange={(e) => setFormData({ ...formData, rank: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>직책</label>
                    <input
                      type="text"
                      value={formData.position}
                      onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>로그인 ID</label>
                    <input
                      type="text"
                      value={formData.login_id}
                      onChange={(e) => setFormData({ ...formData, login_id: e.target.value })}
                      className="input-field"
                      style={{ width: '100%', height: '36px' }}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>이메일</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="input-field"
                    style={{ width: '100%', height: '36px' }}
                  />
                </div>

                <div style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--bg-card-2)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-1)', marginBottom: '10px' }}>개인별 출근 기준</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>출근시간</label>
                      <input
                        type="time"
                        required
                        value={formData.schedule_time}
                        onChange={(e) => setFormData({ ...formData, schedule_time: e.target.value })}
                        className="input-field"
                        style={{ width: '100%', height: '36px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>지정 사유</label>
                      <input
                        type="text"
                        maxLength={500}
                        required={formData.schedule_time !== '09:00'}
                        placeholder="예: 육아기 단축근무, 시차출퇴근"
                        value={formData.schedule_reason}
                        onChange={(e) => setFormData({ ...formData, schedule_reason: e.target.value })}
                        className="input-field"
                        style={{ width: '100%', height: '36px' }}
                      />
                    </div>
                  </div>
                  <div style={{ marginTop: '7px', fontSize: '11px', color: 'var(--text-3)', lineHeight: 1.4 }}>
                    지정한 시간이 해당 직원의 기본 지각 판정 기준이 됩니다. 날짜별 스케줄 변경이 있으면 날짜별 설정이 우선합니다.
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '6px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="edit_is_active"
                      checked={formData.is_active}
                      onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    <label htmlFor="edit_is_active" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-1)', cursor: 'pointer' }}>
                      재직 상태 (체크 해제 시 퇴사 처리)
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="edit_is_admin"
                      checked={formData.is_admin}
                      onChange={(e) => setFormData({ ...formData, is_admin: e.target.checked })}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    <label htmlFor="edit_is_admin" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-1)', cursor: 'pointer' }}>
                      관리자 권한 부여
                    </label>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setIsEditModalOpen(false)}>
                    취소
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? '저장 중...' : '변경사항 저장'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ─── [모달 3] 비밀번호 즉시 재설정 ─── */}
        {isPasswordModalOpen && selectedEmp && (
          <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, backdropFilter: 'blur(3px)' }}>
            <div className="card" style={{ width: '100%', maxWidth: '400px', padding: '24px', position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <KeyRound size={18} color="var(--amber)" />
                  비밀번호 재설정
                </h3>
                <button type="button" onClick={() => setIsPasswordModalOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ padding: '10px 14px', background: 'var(--bg-card-2)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-3)' }}>대상 직원</div>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-1)', marginTop: '2px' }}>
                    {selectedEmp.name} <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-2)' }}>({selectedEmp.dept} / {selectedEmp.emp_no})</span>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: '4px' }}>새 비밀번호 입력 *</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    placeholder="새 비밀번호"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input-field"
                    style={{ width: '100%', height: '38px', fontSize: '14px', fontWeight: 600 }}
                  />
                  <small style={{ color: 'var(--text-3)', fontSize: '11px', marginTop: '4px', display: 'block' }}>
                    변경 후 해당 직원은 로그인하여 새 비밀번호를 한 번 더 변경해야 합니다.
                  </small>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setIsPasswordModalOpen(false)}>
                    취소
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting} style={{ background: 'var(--amber)', borderColor: 'var(--amber)' }}>
                    {submitting ? '변경 중...' : '비밀번호 변경'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <Suspense fallback={<div className="loading-spinner">직원 관리 화면 로딩 중...</div>}>
      <EmployeesPageContent />
    </Suspense>
  );
}
