'use client';

import React, { useMemo } from 'react';
import {
  getHolidayName,
  sortCalendarLeaves,
  getLeaveMeta,
  getLeaveDisplayName,
} from '../lib/leaveRules';
import MonthSearchPicker from './MonthSearchPicker';
import EmploymentLeaveBadge from './EmploymentLeaveBadge';
import { getMonthRangeList } from '../lib/dashboardUtils';
import useHolidayCalendar from '../lib/useHolidayCalendar';

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const LEGEND_PRIORITY = {
  연차: 0,
  공가: 1,
  '공가 [오전]': 2,
  '4시간휴가 [오전]': 3,
  '4시간휴가 [오후]': 4,
  '2시간휴가B [08-10]': 5,
  '2시간휴가D [10-12]': 6,
  '2시간휴가G [14-16]': 7,
  '2시간휴가H [15-17]': 8,
  '2시간휴가J [17-19]': 9,
};

const getLeaveVariantClass = (meta) => String(meta?.variantClassName || '').trim();

const buildCalendarLegends = (calendarLeaves = []) => {
  const seen = new Map();
  (calendarLeaves || []).forEach((leave) => {
    const meta = getLeaveMeta(leave);
    const label = String(meta.rawLabel || meta.label || '').trim();
    if (!label || seen.has(label)) return;
    seen.set(label, {
      label,
      color: meta.color || '#64748B',
      priority: LEGEND_PRIORITY[meta.rawLabel || meta.label || meta.leaveType] ?? 99,
    });
  });
  return Array.from(seen.values()).sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label, 'ko'));
};

const formatMonthLabel = (yearMonthStr) => {
  const [year, month] = String(yearMonthStr || '').split('-').map(Number);
  if (!year || !month) return '';
  return `${year}년 ${month}월`;
};

export const getCalendarCells = (yearMonthStr) => {
  if (!yearMonthStr) return [];
  const [year, month] = yearMonthStr.split('-').map(Number);
  const day = new Date(year, month - 1, 1).getDay();
  const firstDayIndex = day === 0 ? 6 : day - 1;
  const totalDays = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDayIndex; i += 1) cells.push({ empty: true });
  for (let d = 1; d <= totalDays; d += 1) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ empty: false, dayNum: d, dateStr });
  }
  return cells;
};

export const formatLocalDateStr = (date = new Date()) => {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60 * 1000).toISOString().split('T')[0];
};

export default function DashboardCalendarWidget({
  calendarMonth,
  setCalendarMonth,
  calendarLeaves,
  employeeNameLookup,
  selectedCalendarDate,
  setSelectedCalendarDate,
  eyebrow = '오늘의 미니 캘린더',
  hideSelectedDetail = false,
  compact = false,
  hideLegend = false,
  bare = false,
}) {
  const todayStr = formatLocalDateStr();
  useHolidayCalendar(calendarMonth);
  const cells = getCalendarCells(calendarMonth);
  const CALENDAR_LEGENDS = buildCalendarLegends(calendarLeaves);
  const monthOptions = useMemo(() => getMonthRangeList(240, 240), []);

  const moveMonth = (delta) => {
    const [y, m] = calendarMonth.split('-').map(Number);
    const next = new Date(y, m - 1 + delta, 1);
    setSelectedCalendarDate(null);
    setCalendarMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  const renderSelectedDetail = () => {
    if (!selectedCalendarDate) return null;

    const dc = selectedCalendarDate.replace(/-/g, '');
    const dayLeaves = sortCalendarLeaves(
      calendarLeaves.filter((l) => dc >= l.startDate && dc <= l.endDate),
      employeeNameLookup
    );
    const holidayName = getHolidayName(selectedCalendarDate);

    return (
      <div className="calendar-detail">
        <div className="calendar-detail__title">
          <span className="calendar-detail__date">{selectedCalendarDate}</span>
          {holidayName && <span className="calendar-detail__holiday">공휴일: {holidayName}</span>}
        </div>

        {dayLeaves.length === 0 ? (
          <div className="calendar-detail__empty">해당 날짜에는 등록된 휴가가 없습니다.</div>
        ) : (
          <div className="calendar-detail__grid">
            {Object.values(
              dayLeaves.reduce((acc, leave, index) => {
                const meta = getLeaveMeta(leave);
                const key = meta.label;
                if (!acc[key]) acc[key] = { meta, leaves: [] };
                acc[key].leaves.push({ leave, index });
                return acc;
              }, {})
            ).map(({ meta, leaves }) => (
              <div
                key={`${meta.label}-${leaves.length}-${leaves[0]?.leave?.empNo || leaves[0]?.leave?.leaveName || 'group'}`}
                className={`calendar-detail__panel ${getLeaveVariantClass(meta)}`.trim()}
                style={{ background: meta.bg, borderColor: meta.border }}
              >
                <div className="calendar-detail__panel-head">
                  <div className="calendar-detail__panel-title" style={{ color: meta.color }}>
                    {meta.label}
                  </div>
                  <div className="calendar-detail__panel-count">{leaves.length}명</div>
                </div>
                <div className="calendar-detail__panel-body">
                  {leaves.map(({ leave, index }) => (
                    <span
                      key={`${String(leave.empNo || leave.empName || '')}-${String(leave.startDate || '')}-${String(leave.leaveName || '')}-${index}`}
                      className="calendar-detail__name-chip"
                    >
                      {getLeaveDisplayName(leave, employeeNameLookup)}
                      <EmploymentLeaveBadge employee={leave} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`calendar-widget-shell${bare ? ' is-bare' : ''}`} style={bare ? { padding: 0, background: 'transparent', border: 'none', boxShadow: 'none' } : { padding: '16px' }}>
      <div className={`calendar-widget${compact ? ' is-compact' : ''}`}>
        <div className="calendar-widget__header">
          <div>
            <div className="calendar-widget__eyebrow">{eyebrow}</div>
            <div className="calendar-widget__title">{formatMonthLabel(calendarMonth)} 달력</div>
          </div>
          <MonthSearchPicker
            label=""
            value={calendarMonth}
            onChange={(month) => {
              setSelectedCalendarDate(null);
              setCalendarMonth(month);
            }}
            monthOptions={monthOptions}
            onPrev={() => moveMonth(-1)}
            onNext={() => moveMonth(1)}
            placeholder="YYYY-MM 검색"
            className="calendar-widget__month-picker"
          />
        </div>

        {!hideLegend && (
          <div className="calendar-widget__legend">
            {CALENDAR_LEGENDS.map((item, idx) => (
              <div
                key={`${item.label}-${idx}`}
                className={`calendar-widget__legend-item ${item.label === '연차' ? 'is-annual' : ''}`}
              >
                <span className="calendar-widget__legend-swatch" style={{ background: item.color }} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="calendar-widget__weekday-grid">
          {WEEKDAYS.map((day, idx) => (
            <div
              key={`weekday-${idx}`}
              className={`calendar-widget__weekday ${idx === 6 ? 'is-sun' : idx === 5 ? 'is-sat' : ''}`}
            >
              {day}
            </div>
          ))}
        </div>

        <div className="calendar-widget__grid">
          {cells.map((cell, idx) => {
            if (cell.empty) {
              return <div key={`empty-${idx}`} className="calendar-widget__spacer" />;
            }

            const dow = idx % 7;
            const isSun = dow === 6;
            const isSat = dow === 5;
            const holidayName = getHolidayName(cell.dateStr);
            const isToday = cell.dateStr === todayStr;
            const isSelected = selectedCalendarDate === cell.dateStr;
            const isHoliday = isSun || isSat || !!holidayName;
            const dayLeaves = sortCalendarLeaves(
              calendarLeaves.filter((l) => {
                const dc = cell.dateStr.replace(/-/g, '');
                return dc >= l.startDate && dc <= l.endDate;
              }),
              employeeNameLookup
            );

            return (
              <button
                key={cell.dateStr}
                type="button"
                className={[
                  'calendar-day',
                  isSun ? 'is-sun' : '',
                  isSat ? 'is-sat' : '',
                  isHoliday ? 'is-holiday' : '',
                  isToday ? 'is-today' : '',
                  isSelected ? 'is-selected' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setSelectedCalendarDate(isSelected ? null : cell.dateStr)}
                title={holidayName || cell.dateStr}
                style={{
                  background: 'transparent',
                  borderColor: isToday
                    ? 'var(--blue)'
                    : isSelected
                      ? 'rgba(99, 102, 241, 0.5)'
                      : isHoliday
                        ? 'var(--border)'
                        : 'transparent',
                  boxShadow: isToday
                    ? 'inset 0 0 0 1px var(--blue)'
                    : isSelected
                      ? 'inset 0 0 0 1px rgba(99, 102, 241, 0.45)'
                      : 'none',
                }}
              >
                <div className="calendar-day__top">
                  <span
                    className="calendar-day__number"
                    style={{
                      color: isToday
                        ? 'var(--blue)'
                        : isSun || !!holidayName
                          ? 'var(--red)'
                          : isSat
                            ? 'var(--blue)'
                            : 'var(--text-1)',
                      fontWeight: isToday ? 900 : 800,
                    }}
                  >
                    {cell.dayNum}
                  </span>
                  {holidayName && <span className="calendar-day__holiday">{holidayName}</span>}
                </div>

                <div className="calendar-day__leave-list">
                  {dayLeaves.slice(0, 3).map((leave, li) => {
                    const meta = getLeaveMeta(leave);
                    return (
                      <span
                        key={`${String(leave.empNo || leave.empName || '')}-${String(leave.startDate || '')}-${String(leave.leaveName || '')}-${li}`}
                        className="calendar-day__leave-pill"
                        style={{ background: meta.bg, borderColor: meta.border, color: meta.color }}
                        title={`${String(getLeaveDisplayName(leave, employeeNameLookup) || '')} · ${String(meta.label || '')}`}
                      >
                        {getLeaveDisplayName(leave, employeeNameLookup)}
                        <EmploymentLeaveBadge employee={leave} />
                      </span>
                    );
                  })}
                  {dayLeaves.length > 3 && (
                    <span className="calendar-day__leave-more">+{dayLeaves.length - 3}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {!hideSelectedDetail && renderSelectedDetail()}
      </div>
    </div>
  );
}
