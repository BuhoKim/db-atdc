'use client';

import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { RefreshCw, Download } from 'lucide-react';
import MonthSearchPicker from '../MonthSearchPicker';
import AttendanceNoteModal from '../AttendanceNoteModal';
import EmploymentLeaveBadge from '../EmploymentLeaveBadge';
import { getHolidayName, getLeaveMeta } from '../../lib/leaveRules';
import { clampToHalfHourSteps, formatHalfHourSteps, getMonthRangeList, normalizeDeptName, normalizeEmpNoKey, formatTimeString } from '../../lib/dashboardUtils';
import { MONTHLY_DEFAULT_NOTE, buildScheduleOverrideMap, resolveSchedulePairForDate } from '../../lib/scheduleResolver';
import useHolidayCalendar from '../../lib/useHolidayCalendar';
import { getKstDateKey, shiftMonthKey } from '../../lib/kstDate';
import { toMinutes, getAdjustmentMinutes } from '../../lib/scheduleUtils';
import * as XLSX from 'xlsx';

const getLeaveVariantClass = (meta) => {
  return String(meta?.variantClassName || '').trim();
};

const getDaysInMonth = (yearMonthStr) => {
  if (!yearMonthStr) return [];
  const [year, month] = yearMonthStr.split('-').map(Number);
  const date = new Date(year, month - 1, 1);
  const days = [];
  while (date.getMonth() === month - 1) {
    const dayNum = date.getDate();
    const dayOfWeek = date.toLocaleDateString('ko-KR', { weekday: 'short' });
    days.push({
      dateStr: `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
      formatted: `${month}/${dayNum}(${dayOfWeek})`,
      dayOfWeek,
      dayNum,
    });
    date.setDate(date.getDate() + 1);
  }
  return days;
};

function MonthlyTab({
  monthlyLoading = false,
  selectedMonth,
  setSelectedMonth,
  visibleMonthlyEmployees = [],
  monthlyData = {},
  refreshData = () => {},
}) {
  const monthOptions = useMemo(() => getMonthRangeList(240, 240), []);
  useHolidayCalendar(selectedMonth);
  useHolidayCalendar(shiftMonthKey(selectedMonth, -1));
  useHolidayCalendar(shiftMonthKey(selectedMonth, 1));

  const days = useMemo(() => getDaysInMonth(selectedMonth), [selectedMonth]);
  const todayStr = getKstDateKey();
  const tableScrollRef = useRef(null);
  const todayHeaderRef = useRef(null);
  const allEmps = visibleMonthlyEmployees;
  const gridData = monthlyData?.gridData || {};
  const [noteModal, setNoteModal] = useState({ isOpen: false, empNo: '', empName: '', dept: '', workDate: '', note: '', imageUrl: null });
  const overrideLookup = useMemo(() => buildScheduleOverrideMap(monthlyData?.overrides || []), [monthlyData?.overrides]);

  const handleExportExcel = () => {
    try {
      const headers = ['사번', '이름', '부서', ...days.map((d) => `${d.dayNum}일(${d.dayOfWeek})`)];
      const rows = allEmps.map((emp) => {
        const row = [emp.rawEmpNo || emp.empNo || emp.emp_no, emp.name, emp.dept];
        days.forEach((d) => {
          const dateCompact = d.dateStr.replace(/-/g, '');
          const leave = (monthlyData?.leaves || []).find(
            (l) => normalizeEmpNoKey(l.empNo) === normalizeEmpNoKey(emp.empNo) && dateCompact >= l.startDate && dateCompact <= l.endDate
          );
          const dayStats = gridData[emp.empNo]?.[d.dateStr];
          if (leave) {
            row.push(leave.leaveName || '휴가');
          } else if (dayStats?.in || dayStats?.out) {
            row.push(`${dayStats.in || '-'} ~ ${dayStats.out || '-'}`);
          } else {
            row.push('-');
          }
        });
        return row;
      });

      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${selectedMonth} 근태현황`);
      XLSX.writeFile(wb, `월간근태현황_${selectedMonth}.xlsx`);
    } catch (e) {
      alert('엑셀 다운로드 실패: ' + e.message);
    }
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h3 className="card-title">월간 출근 현황표</h3>
          <p className="card-subtitle">선택 월의 일자별 임직원 출퇴근 상세 데이터 그리드</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <MonthSearchPicker
            label="선택 월"
            value={selectedMonth}
            onChange={setSelectedMonth}
            monthOptions={monthOptions}
            onPrev={() => {
              const idx = monthOptions.indexOf(selectedMonth);
              setSelectedMonth(monthOptions[Math.max(idx - 1, 0)] || selectedMonth);
            }}
            onNext={() => {
              const idx = monthOptions.indexOf(selectedMonth);
              setSelectedMonth(monthOptions[Math.min(idx + 1, monthOptions.length - 1)] || selectedMonth);
            }}
            placeholder="YYYY-MM 검색"
          />

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExportExcel}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600 }}
          >
            <Download size={15} />
            엑셀 다운로드
          </button>
        </div>
      </div>

      {monthlyLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 360, flexDirection: 'column', gap: '12px' }}>
          <RefreshCw style={{ width: 26, height: 26, color: 'var(--blue)', animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 14, color: 'var(--text-2)' }}>월간 보고서를 구성 중입니다...</span>
        </div>
      ) : (
        <div
          className="table-wrapper"
          ref={tableScrollRef}
          style={{ maxHeight: '720px', overflow: 'auto', outline: 'none' }}
        >
          <table className="table" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
            <colgroup>
              <col style={{ width: '130px' }} />
              {days.map((d) => (
                <col key={d.dateStr} style={{ width: '105px' }} />
              ))}
            </colgroup>
            <thead style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-card)' }}>
              <tr>
                <th
                  style={{
                    position: 'sticky',
                    top: 0,
                    left: 0,
                    background: 'var(--bg-card)',
                    zIndex: 30,
                    minWidth: '130px',
                    width: '130px',
                    textAlign: 'center',
                    boxShadow: '6px 0 14px -14px rgba(15, 23, 42, 0.28)',
                    borderRight: '1px solid var(--border)',
                  }}
                >
                  임직원
                </th>
                {days.map((d) => {
                  const holidayName = getHolidayName(d.dateStr);
                  const isWE = d.dayOfWeek === '일' || d.dayOfWeek === '토' || !!holidayName;
                  const isTodayColumn = d.dateStr === todayStr;
                  return (
                    <th
                      key={d.dateStr}
                      ref={isTodayColumn ? todayHeaderRef : null}
                      style={{
                        minWidth: '105px',
                        textAlign: 'center',
                        color: d.dayOfWeek === '일' || !!holidayName ? 'var(--red)' : d.dayOfWeek === '토' ? 'var(--blue)' : 'var(--text-1)',
                        background: isTodayColumn
                          ? 'linear-gradient(180deg, rgba(59, 130, 246, 0.18), rgba(59, 130, 246, 0.08))'
                          : isWE
                            ? 'rgba(239, 68, 68, 0.04)'
                            : 'transparent',
                        position: 'sticky',
                        top: 0,
                        zIndex: isTodayColumn ? 24 : 21,
                        boxShadow: isTodayColumn ? 'inset 0 0 0 1px rgba(59, 130, 246, 0.38)' : undefined,
                        borderRadius: isTodayColumn ? '8px 8px 0 0' : undefined,
                      }}
                    >
                      {d.formatted.split('(')[0]}<br />
                      <small style={{ opacity: 0.8 }}>({d.dayOfWeek})</small>
                      {holidayName && (
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--red)', marginTop: '2px', lineHeight: 1.2 }}>
                          {holidayName}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {allEmps.length === 0 ? (
                <tr>
                  <td colSpan={days.length + 1} style={{ textAlign: 'center', padding: '60px 16px', color: 'var(--text-3)' }}>
                    조회할 임직원 데이터가 없습니다.
                  </td>
                </tr>
              ) : (
                allEmps.map((emp) => {
                  const empKey = normalizeEmpNoKey(emp.empNo || emp.emp_no);
                  return (
                    <tr key={emp.empNo || emp.emp_no}>
                      <td
                        style={{
                          position: 'sticky',
                          left: 0,
                          background: 'var(--bg-card)',
                          zIndex: 12,
                          fontWeight: 700,
                          borderRight: '1px solid var(--border)',
                          boxShadow: '6px 0 14px -14px rgba(15, 23, 42, 0.28)',
                          padding: '10px 8px',
                          textAlign: 'center',
                        }}
                      >
                        <div style={{ display: 'grid', justifyItems: 'center', gap: '2px', lineHeight: 1.15 }}>
                          <span style={{ color: 'var(--text-1)', fontSize: 13.5, fontWeight: 700 }}>{emp.name}<EmploymentLeaveBadge employee={emp} /></span>
                          <small style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 11.5 }}>({emp.dept})</small>
                        </div>
                      </td>

                      {days.map((d) => {
                        const dayStats = gridData[emp.empNo || emp.emp_no]?.[d.dateStr];
                        const holidayName = getHolidayName(d.dateStr);
                        const isWE = d.dayOfWeek === '일' || d.dayOfWeek === '토' || !!holidayName;
                        const isTodayColumn = d.dateStr === todayStr;

                        const dateCompact = d.dateStr.replace(/-/g, '');
                        const leave = (monthlyData?.leaves || []).find(
                          (l) => normalizeEmpNoKey(l.empNo) === empKey && dateCompact >= l.startDate && dateCompact <= l.endDate
                        );
                        const leaveMeta = leave ? getLeaveMeta(leave, dayStats) : null;
                        const inFormatted = formatTimeString(dayStats?.in, false);
                        const outFormatted = formatTimeString(dayStats?.out, false);
                        const timeText = inFormatted !== '-' || outFormatted !== '-' ? `${inFormatted !== '-' ? inFormatted : '-'}\n${outFormatted !== '-' ? outFormatted : '-'}` : '';

                        return (
                          <td
                            key={d.dateStr}
                            style={{
                              textAlign: 'center',
                              fontSize: '12px',
                              whiteSpace: 'pre-line',
                              padding: '8px 4px',
                              background: isTodayColumn
                                ? 'linear-gradient(180deg, rgba(59, 130, 246, 0.10), rgba(59, 130, 246, 0.04))'
                                : dayStats?.isLate
                                  ? 'rgba(245, 158, 11, 0.12)'
                                  : isWE
                                    ? 'rgba(239, 68, 68, 0.04)'
                                    : 'transparent',
                              color: dayStats?.isLate ? 'var(--amber)' : 'var(--text-1)',
                              boxShadow: isTodayColumn ? 'inset 0 0 0 1px rgba(59, 130, 246, 0.26)' : undefined,
                            }}
                          >
                            {leave ? (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                                <span
                                  className={`calendar-detail__name-chip ${getLeaveVariantClass(leaveMeta)}`.trim()}
                                  style={{
                                    display: 'block',
                                    maxWidth: '100%',
                                    paddingInline: 8,
                                    paddingBlock: 3,
                                    borderRadius: '999px',
                                    background: leaveMeta.bg,
                                    color: leaveMeta.color,
                                    border: '1px solid',
                                    borderColor: leaveMeta.border || 'transparent',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    fontWeight: 600,
                                    fontSize: 9.5,
                                    lineHeight: 1.1,
                                  }}
                                >
                                  {leaveMeta.label}
                                </span>
                                {timeText ? (
                                  <span style={{ fontSize: '11px', color: dayStats?.isLate ? 'var(--amber)' : 'var(--text-1)', fontWeight: 600, lineHeight: 1.25 }}>
                                    {timeText}
                                  </span>
                                ) : null}
                                {dayStats?.note ? (
                                  <button
                                    type='button'
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setNoteModal({
                                        isOpen: true,
                                        empNo: emp.empNo || emp.emp_no,
                                        empName: emp.name,
                                        dept: emp.dept,
                                        workDate: d.dateStr,
                                        note: dayStats.note,
                                        imageUrl: dayStats.noteImageUrl || null,
                                      });
                                    }}
                                    style={{ marginTop: 2, padding: '1px 4px', fontSize: '9.5px', borderRadius: 4, border: '1px solid rgba(37,99,235,0.4)', backgroundColor: 'rgba(37,99,235,0.1)', color: 'var(--blue)', cursor: 'pointer' }}
                                    title={'사유: ' + (dayStats.note || '')}
                                  >
                                    📝 사유
                                  </button>
                                ) : null}
                              </div>
                            ) : timeText ? (
                              <span style={{ fontSize: '11.5px', color: dayStats?.isLate ? 'var(--amber)' : 'var(--text-1)', fontWeight: 600, lineHeight: 1.3 }}>
                                {timeText}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-3)', fontSize: '12px', opacity: 0.4 }}>-</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
<AttendanceNoteModal
        isOpen={noteModal.isOpen}
        onClose={() => setNoteModal((prev) => ({ ...prev, isOpen: false }))}
        empNo={noteModal.empNo}
        empName={noteModal.empName}
        dept={noteModal.dept}
        workDate={noteModal.workDate}
        initialNote={noteModal.note}
        initialImageUrl={noteModal.imageUrl}
        onSaved={() => refreshData()}
      />
    </div>
  );
}

export default memo(MonthlyTab);
