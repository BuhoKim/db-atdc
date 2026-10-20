BEGIN;

-- Preserve existing rows and activation flags; MySQL sync fills these fields.
ALTER TABLE public.db_employees
  ADD COLUMN IF NOT EXISTS state_code VARCHAR(3),
  ADD COLUMN IF NOT EXISTS employment_status TEXT,
  ADD COLUMN IF NOT EXISTS state_date DATE;

ALTER TABLE public.db_employees
  ADD CONSTRAINT db_employees_hr_state_check CHECK (
    (state_code IS NULL AND employment_status IS NULL)
    OR (state_code IS NOT NULL AND employment_status IS NOT NULL AND (
      (state_code = '001' AND employment_status = 'active')
      OR (state_code = '002' AND employment_status = 'on_leave')
      OR (state_code = '999' AND employment_status = 'resigned')
    ))
  );

COMMENT ON COLUMN public.db_employees.state_code IS 'MySQL hr_employee.I_STATE_CODE: 001=재직, 002=휴직, 999=퇴직. 미확인 값은 기존 상태 보존.';
COMMENT ON COLUMN public.db_employees.employment_status IS '인사 원본 상태: active=재직, on_leave=휴직, resigned=퇴직. 수동 비활성화(is_active)와 별도.';
COMMENT ON COLUMN public.db_employees.state_date IS 'MySQL hr_employee.D_STATE_DATE 인사상태 적용일자. 동기화 실행일로 대체하지 않음.';

NOTIFY pgrst, 'reload schema';
COMMIT;
