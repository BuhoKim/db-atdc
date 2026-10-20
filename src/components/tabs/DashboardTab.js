'use client';

import React, { memo, useMemo, useState } from 'react';
import { CircleUserRound, Moon, Search, Sun } from 'lucide-react';
import DashboardCalendarWidget from '../DashboardCalendarWidget';
import AttendanceNoteModal from '../AttendanceNoteModal';
import EmploymentLeaveBadge from '../EmploymentLeaveBadge';
import { getKstDateKey } from '../../lib/kstDate';
import { getStatusBadgeMeta } from '../../lib/leaveRules';
import { matchesDeptFilter, normalizeDeptName, formatTimeString } from '../../lib/dashboardUtils';

const koDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

function formatDeptLabel(value) {
  const normalized = normalizeDeptName(value);
  if (!normalized || normalized === 'ALL') return '전체 부서';
  return normalized;
}

function isLeaveStatus(emp) {
  if (!emp) return false;
  if (emp.todayLeave) return true;

  const status = String(emp.status || '').trim();
  if (!status) return false;

  return (
    [
      '연차',
      '공가',
      '오전반차',
      '오후반차',
      '오전반반차',
      '오후반반차',
      '기타휴가',
      '경조휴가',
      '휴가',
    ].includes(status) ||
    status.endsWith('휴가') ||
    status.endsWith('반차') ||
    status.endsWith('반일')
  );
}

function StatCard({ label, value, colorClass, active, onClick, loading = false }) {
  return (
    <button
      type="button"
      className={`kpi-card kpi-card--${colorClass}${active ? ' is-active' : ''}`}
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        padding: '25px 18px 12px',
        minHeight: '136px',
      }}
    >
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value kpi-value--${colorClass}`} style={{ marginTop: '8px' }}>
        {loading ? (
          <span style={{ display: 'inline-block', width: 36, height: 32, borderRadius: 6, background: 'var(--border-soft)', opacity: 0.6, animation: 'pulse 1.5s infinite ease-in-out' }} />
        ) : (
          <>
            {value}
            <small style={{ fontSize: 13, color: 'var(--text-3)' }}>명</small>
          </>
        )}
      </div>
    </button>
  );
}

const AVATAR_TONES = [
  { bg: 'rgba(59, 130, 246, 0.14)', fg: 'var(--blue)' },
  { bg: 'rgba(95, 169, 113, 0.14)', fg: 'var(--green)' },
  { bg: 'rgba(201, 150, 75, 0.14)', fg: 'var(--amber)' },
  { bg: 'rgba(157, 123, 216, 0.14)', fg: 'var(--purple)' },
  { bg: 'rgba(232, 94, 175, 0.14)', fg: 'var(--pink)' },
  { bg: 'rgba(57, 160, 173, 0.14)', fg: 'var(--teal)' },
];

function getAvatarTone(seed) {
  const text = String(seed || '').trim() || 'avatar';
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function DashboardTab({
  data,
  loading = false,
  viewDeptFilter = 'ALL',
  myDept = '전체 부서',
  calendarMonth,
  setCalendarMonth,
  selectedCalendarDate,
  setSelectedCalendarDate,
  visibleDashboardLeaves = [],
  calendarEmployeeNameLookup = new Map(),
  resolvedDeptFilterValue = 'ALL',
  deptOptions = [],
  hasFullAccess = true,
  time = '',
  theme = 'dark',
  toggleTheme = () => {},
  setViewDeptFilter = () => {},
}) {
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const deptFilterValue = normalizeDeptName(resolvedDeptFilterValue || viewDeptFilter) || 'ALL';
  const todayLabel = koDateFormatter.format(new Date());

  const deptFilteredStatuses = useMemo(() => {
    const employees = Array.isArray(data?.employeeStatuses) ? data.employeeStatuses : [];
    return employees.filter((emp) => matchesDeptFilter(emp?.dept, deptFilterValue));
  }, [data?.employeeStatuses, deptFilterValue]);

  const hasActiveCheckIn = (emp) => String(emp?.checkIn || '').trim() && String(emp?.checkIn || '').trim() !== '-';

  const visibleStatuses = useMemo(() => {
    const search = searchQuery.trim();
    return deptFilteredStatuses.filter((emp) => {
      const name = String(emp?.name || '').trim();
      const empNo = String(emp?.empNo || emp?.emp_no || '').trim();
      const dept = String(emp?.dept || '').trim();
      const statusText = String(emp?.status || '').trim();
      const searchMatch = !search || [name, empNo, dept].some((text) => text.includes(search));
      if (!searchMatch) return false;
      if (statusFilter === 'PRESENT') return hasActiveCheckIn(emp);
      if (statusFilter === 'ABSENT') return statusText.includes('미출근') || statusText === 'ABSENT';
      if (statusFilter === 'LATE') return !!emp?.isLate;
      if (statusFilter === 'LEAVE') return isLeaveStatus(emp);
      return true;
    });
  }, [deptFilteredStatuses, searchQuery, statusFilter]);

  const stats = useMemo(() => {
    return deptFilteredStatuses.reduce(
      (acc, emp) => {
        acc.total += 1;
        if (hasActiveCheckIn(emp)) acc.present += 1;
        if (emp?.isLate) acc.late += 1;
        if (isLeaveStatus(emp)) acc.leave += 1;
        if (hasActiveCheckIn(emp)) acc.workingNow += 1;
        return acc;
      },
      {
        total: 0,
        present: 0,
        late: 0,
        leave: 0,
        workingNow: 0,
      }
    );
  }, [deptFilteredStatuses]);

  const deptGroups = useMemo(() => {
    const groupMap = new Map();

    visibleStatuses.forEach((emp) => {
      const dept = String(emp?.dept || emp?.team || '미분류').trim() || '미분류';
      if (!groupMap.has(dept)) {
        groupMap.set(dept, {
          dept,
          total: 0,
          present: 0,
          late: 0,
          employees: [],
        });
      }

      const group = groupMap.get(dept);
      group.total += 1;
      if (hasActiveCheckIn(emp)) group.present += 1;
      if (emp?.isLate) group.late += 1;
      group.employees.push(emp);
    });

    return Array.from(groupMap.values()).sort((a, b) => a.dept.localeCompare(b.dept, 'ko-KR'));
  }, [visibleStatuses]);

  const deptDistribution = useMemo(() => {
    const source = Array.isArray(data?.deptData) ? data.deptData : [];
    return source
      .filter((dept) => matchesDeptFilter(dept?.name, deptFilterValue))
      .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'ko-KR'));
  }, [data?.deptData, deptFilterValue]);

  const dashboardLeaves = useMemo(() => visibleDashboardLeaves || [], [visibleDashboardLeaves]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="dashboard-hero" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 4 }}>{todayLabel}</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.03em', color: 'var(--text-1)', margin: 0 }}>
            실시간 직원 상태 모니터링
          </h1>
          <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)' }}>
            오늘 기준 출근, 부서 현황, 실시간 직원 상태를 집계합니다.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <div className="db-indicator" style={{ minWidth: 108 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--green)' }} />
            <span className="db-name">{time || '--:--:--'}</span>
          </div>

          {hasFullAccess ? (
            <select
              className="ui-select"
              value={deptFilterValue}
              onChange={(e) => setViewDeptFilter(e.target.value)}
              aria-label="부서 선택"
            >
              {deptOptions.map((dept) => (
                <option key={dept} value={dept}>
                  {dept === 'ALL' ? '전체 부서' : dept}
                </option>
              ))}
            </select>
          ) : (
            <div className="db-indicator" style={{ minWidth: 108 }}>
              <span className="db-name">{formatDeptLabel(myDept)}</span>
            </div>
          )}

          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
            aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          >
            {theme === 'dark' ? <Sun style={{ width: 15, height: 15 }} /> : <Moon style={{ width: 15, height: 15 }} />}
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <StatCard
          label="전체 재직 인원"
          value={stats.total}
          colorClass="blue"
          active={statusFilter === 'ALL'}
          onClick={() => setStatusFilter('ALL')}
          loading={loading}
        />
        <StatCard
          label="오늘 정상 근무"
          value={stats.present}
          colorClass="green"
          active={statusFilter === 'PRESENT'}
          onClick={() => setStatusFilter('PRESENT')}
          loading={loading}
        />
        <StatCard
          label="오늘 지각 발생"
          value={stats.late}
          colorClass="amber"
          active={statusFilter === 'LATE'}
          onClick={() => setStatusFilter('LATE')}
          loading={loading}
        />
        <StatCard
          label="오늘 휴가/연차"
          value={stats.leave}
          colorClass="purple"
          active={statusFilter === 'LEAVE'}
          onClick={() => setStatusFilter('LEAVE')}
          loading={loading}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 0.9fr)', gap: 20, alignItems: 'start' }}>
        <div className="card dashboard-main-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header" style={{ padding: '16px 18px 10px' }}>
            <div>
              <h3 className="card-title">실시간 임직원 근태 목록</h3>
              <p className="card-subtitle">오늘 기준 전체 직원의 상태와 출퇴근 기록</p>
            </div>
            <div style={{ position: 'relative', minWidth: 220 }}>
              <Search style={{ position: 'absolute', left: 11, top: 10, width: 14, height: 14, color: 'var(--text-3)' }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="이름/사번/부서 검색"
                className="search-input"
                style={{ paddingLeft: 32 }}
              />
            </div>
          </div>

          <div className="table-wrapper status-table-wrapper">
            <table className="table status-table dashboard-status-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '22%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '14%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>사원 정보</th>
                  <th>부서</th>
                  <th>기준 출근</th>
                  <th>출근</th>
                  <th>현재 상태</th>
                  <th style={{ textAlign: 'center' }}>사유 / 메모</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, idx) => (
                    <tr key={`skel-row-${idx}`}>
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 32, height: 32, borderRadius: 10, background: 'var(--border-soft)', opacity: 0.6, animation: 'pulse 1.5s infinite ease-in-out' }} />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <div style={{ width: 55, height: 13, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.6, animation: 'pulse 1.5s infinite ease-in-out' }} />
                            <div style={{ width: 45, height: 10, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.4, animation: 'pulse 1.5s infinite ease-in-out' }} />
                          </div>
                        </div>
                      </td>
                      <td><div style={{ width: 60, height: 12, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} /></td>
                      <td><div style={{ width: 40, height: 12, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} /></td>
                      <td><div style={{ width: 40, height: 12, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} /></td>
                      <td><div style={{ width: 50, height: 22, borderRadius: 6, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} /></td>
                    </tr>
                  ))
                ) : deptGroups.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: '40px 16px' }}>
                      조건에 맞는 직원이 없습니다.
                    </td>
                  </tr>
                ) : (
                  deptGroups.map((group) => {
                    const ratio = group.total > 0 ? Math.round((group.present / group.total) * 100) : 0;
                    return (
                      <React.Fragment key={group.dept}>
                        <tr className="dashboard-group-row">
                          <td colSpan={6} style={{ padding: '0' }}>
                            <div className="dashboard-group-header">
                              <div className="dashboard-group-topline">
                                <div className="dashboard-group-title">
                                  <span>{group.dept}</span>
                                  <span className="dashboard-group-count">{group.present}/{group.total}명 출근</span>
                                </div>
                                <div className="dashboard-group-rate">{ratio}%</div>
                              </div>
                              <div className="dashboard-group-bar">
                                <span style={{ width: `${Math.max(10, ratio)}%` }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                        {group.employees.map((emp) => {
                          const displayStatus = emp.todayLeave?.leaveName || (hasActiveCheckIn(emp) ? '근무중' : emp.status);
                          const badgeMeta = getStatusBadgeMeta(displayStatus, emp.todayLeave || emp);
                          const isLate = !!emp.isLate;
                          const avatarTone = getAvatarTone(emp.empNo || emp.emp_no || emp.name);
                          const formattedCheckIn = formatTimeString(emp.checkIn, false);

                          return (
                            <tr key={`${emp.empNo || emp.emp_no || emp.name}-${emp.dept || ''}`}>
                              <td>
                                <div className="dashboard-emp-cell">
                                  <div className="dashboard-avatar" style={{ background: avatarTone.bg, color: avatarTone.fg }}>
                                    <CircleUserRound size={17} strokeWidth={1.8} />
                                  </div>
                                  <div className="dashboard-emp-meta">
                                    <div className="dashboard-emp-name">
                                      {emp.name}
                                      <EmploymentLeaveBadge employee={emp} />
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="dashboard-dept-cell">{emp.dept}</td>
                              <td className="dashboard-time-cell" style={{ textAlign: 'center' }}>{emp.scheduleTime || '-'}</td>
                              <td className="dashboard-time-cell" style={{ textAlign: 'center', color: isLate ? 'var(--amber)' : 'var(--green)', fontWeight: 600 }}>
                                {formattedCheckIn || '-'}
                                {isLate ? <span className="status-dot amber" style={{ marginLeft: 6 }} title="지각" /> : null}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span className={`badge ${badgeMeta.className || 'gray'}`} style={badgeMeta.style}>
                                  {badgeMeta.label}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dashboard-side-stack" style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'stretch' }}>
          <div className="dashboard-calendar-shell">
            <DashboardCalendarWidget
              calendarMonth={calendarMonth}
              setCalendarMonth={setCalendarMonth}
              calendarLeaves={dashboardLeaves}
              employeeNameLookup={calendarEmployeeNameLookup}
              selectedCalendarDate={selectedCalendarDate}
              setSelectedCalendarDate={setSelectedCalendarDate}
              eyebrow="오늘의 미니 캘린더"
              compact
              hideLegend
              bare
            />
          </div>

          <div className="card dashboard-side-card is-compact" style={{ padding: 16 }}>
            <div className="card-header" style={{ padding: 0, marginBottom: 12 }}>
              <div>
                <h3 className="card-title">부서별 출근 현황</h3>
                <p className="card-subtitle">현재 선택된 부서 기준 출근 비율</p>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {loading ? (
                Array.from({ length: 4 }).map((_, idx) => (
                  <div key={`dept-skel-${idx}`} style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ width: 80, height: 13, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} />
                      <div style={{ width: 40, height: 12, borderRadius: 4, background: 'var(--border-soft)', opacity: 0.4, animation: 'pulse 1.5s infinite ease-in-out' }} />
                    </div>
                    <div style={{ height: 6, borderRadius: 999, background: 'var(--border-soft)', opacity: 0.5, animation: 'pulse 1.5s infinite ease-in-out' }} />
                  </div>
                ))
              ) : deptDistribution.length === 0 ? (
                <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '10px 2px' }}>
                  표시할 부서 정보가 없습니다.
                </div>
              ) : (
                deptDistribution.map((dept) => (
                  <div key={dept.name} style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 600 }}>{dept.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        {dept.present}/{dept.total}명
                      </div>
                    </div>
                    <div style={{ height: 6, borderRadius: 999, background: 'var(--border-soft)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${dept.total > 0 ? Math.round((dept.present / dept.total) * 100) : 0}%`,
                          height: '100%',
                          borderRadius: 999,
                          background: 'linear-gradient(90deg, var(--green), var(--blue))',
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(DashboardTab);
