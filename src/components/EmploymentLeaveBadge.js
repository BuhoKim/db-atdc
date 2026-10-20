import { isEmployeeOnLeave } from '../lib/employmentState';

export default function EmploymentLeaveBadge({ employee, date }) {
  if (!isEmployeeOnLeave(employee, date)) return null;
  return (
    <span className="badge-status badge-amber"
      title={employee?.state_date ? `휴직 적용일: ${employee.state_date}` : '인사시스템 휴직 상태'}
      style={{ marginLeft: 6, padding: '2px 6px', fontSize: 11, lineHeight: 1.3, whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
      휴직
    </span>
  );
}
