# db-atdc 동기화 데몬 (서버PC 전용)

신규 법인(`1700`) 및 캡스 그룹(`09`) 전용 동기화 워커입니다.
AWS MySQL(`whr`)에서 데이터를 읽어와 Supabase의 `db_*` 테이블에 적재합니다.

## 설치 및 설정

```bash
cd sync
npm install
# .env.example 참고: 실제 .env에는 회사 DB 주소·서버 키와 기존 MySQL 설정 필요
```

## 실행

```bash
# 통합 주기적 동기화
npm start

# 개별 동기화 테스트
npm run sync:caps
npm run sync:emp
npm run sync:leaves

# 회사 DB 읽기 전용 연결 검사 (출입/휴가/직원 데이터를 쓰지 않음)
npm run check:supabase

# 중단 구간 CAPS만 일회성 복구 (기본 최소 24시간, 더 오래된 체크포인트도 보존)
npm run recover:attendance -- --dry-run
npm run recover:attendance
```

## PM2 등록 예시

```bash
pm2 start index.js --name db-atdc-sync
pm2 save
```

직원은 한국시간 오전 8시 이후 하루 한 번, 출입기록·휴가는 10분마다 동기화합니다.
`index.js`, 루트 `sync_server.js`, `sync/sync_server.js`는 모두 같은 드림베이 워커입니다.
하나만 실행하세요. 실행 잠금으로 같은 저장소에서 중복 데몬·복구 실행을 차단합니다.
헥토큐앤엠(1600/08) 워커는 다른 저장소에서 별도로 운영합니다.

### 인사상태와 적용일자

직원 동기화 시 `hr_employee.I_STATE_CODE`를 다음과 같이 저장합니다.

| MySQL 상태값 | 인사상태 | 저장값 (`employment_status`) |
| --- | --- | --- |
| `001` | 재직 | `active` |
| `002` | 휴직 | `on_leave` |
| `999` | 퇴직 | `resigned` |

원본 코드는 `db_employees.state_code`에 선행 0을 유지해 저장하고,
`D_STATE_DATE`는 `state_date`(적용일자)에 `YYYY-MM-DD`로 저장합니다.
적용일자는 동기화 실행일로 대체하지 않습니다. 원본 날짜가 없거나 유효하지 않으면 NULL입니다.
인사 상태·적용일자는 원본 값을 가져오는 것으로, 미래 적용일 예약 작업을 만들거나
과거 상태 이력을 추정해 만들지 않습니다.

확인된 상태코드가 기존 퇴사 플래그보다 우선하며, `999`는 비활성화합니다.
`002`를 퇴직으로 처리하지 않습니다. 기존 수동 비활성화는 `001`/`002` 동기화로
되살리지 않으며, 빈 값·미확인 코드는 기존 인사상태를 보존합니다.
코드가 미확인일 때만 기존 `I_RETIRE_YN` 처리를 사용합니다.
출입기록·연차 조회, 근태 집계·메일 제외 규칙은 이 변경으로 바꾸지 않습니다.

DB에 `20261020052522_employee_hr_state.sql`을 먼저 적용한 뒤 서버PC에서
아래 명령으로 오늘 이미 실행한 직원 동기화도 한 번 즉시 갱신할 수 있습니다.

```powershell
cd C:\db-atdc\sync
npm run sync:emp
```

직원관리 화면·엑셀의 인사상태/적용일자는 이 동기화가 성공한 이후 채워집니다.

## 회사 계정 이전 후 서버PC 업데이트

```powershell
cd C:\db-atdc
git remote set-url origin https://github.com/BuhoKim/db-atdc.git
git pull --ff-only origin main
cd sync
npm ci
```

`sync/.env`의 `SUPABASE_URL`은 `https://qcpqcuzvirmbjzqjzapt.supabase.co`로,
`SUPABASE_SERVICE_ROLE_KEY`는 해당 회사 프로젝트의 서버용 키로 변경하세요.
기존 MySQL 접속값은 유지합니다. 이전 프로젝트의 URL·키나 1600/08 설정이면 쓰기 전에 중단합니다.
서버 키를 Git·채팅·명령행 인수에 넣지 마세요.

PM2의 실제 이름은 `pm2 list`로 확인합니다. 아래 `db-atdc-sync`는 등록 예시입니다.

```powershell
pm2 stop db-atdc-sync
npm run check:supabase
npm run recover:attendance -- --dry-run
npm run recover:attendance
pm2 restart db-atdc-sync --update-env
pm2 logs db-atdc-sync --lines 60
pm2 save
```

PM2에 이전 `SUPABASE_URL`/키가 남아 있으면 `.env`보다 우선합니다.
이 경우 해당 드림베이 프로세스만 재등록하고 다른 회사 워커는 건드리지 마세요.
명시적인 실행 위치를 지정하면 서버 재시작 후에도 같은 `.env`를 읽습니다.

```powershell
pm2 delete db-atdc-sync
pm2 start C:\db-atdc\sync\index.js --name db-atdc-sync --cwd C:\db-atdc\sync
pm2 save
```

복구는 마지막 성공 시각에서 10분 겹쳐 현재까지 조회합니다. 기본 24시간 보충 범위보다
체크포인트가 더 오래됐으면 그 시각부터 모두 조회합니다. 저장 후 원본 사번·출입시각을
페이지 단위로 전수 대조하고 누락 0건일 때만 체크포인트를 전진시킵니다.
실패 시 기존 체크포인트를 유지하므로 같은 명령을 다시 실행할 수 있습니다.
휴가 유무로 출입기록을 만들거나 제외하지 않으며, 복구 명령은 직원·휴가를 변경하지 않습니다.

## 직원 원본 전체 컬럼 조회 (휴직 정보 점검)

서버PC에서 기존 MySQL 환경설정으로 일회성 실행합니다. Supabase 키는 필요하지 않습니다.

```powershell
cd C:\db-atdc\sync
npm run inspect:employee
# 모든 회사의 테이블 전체 행까지 필요한 경우에만:
npm run inspect:employee -- --all-companies
```

기본은 회사 1700의 전체 직원이며 퇴사자도 포함합니다. 전체 컬럼과 값을 생략 없이
`sync/exports/hr_employee_1700_실행시각_고유값/`에 저장합니다.

- `hr_employee.json`: 전체 원본 행·컬럼 (NULL, 빈 문자열, 사번·날짜 문자열 유지)
- `schema.json`: 컬럼 타입·설명과 휴직/복직/재직상태 후보 컬럼
- `employment_status.json`: 사번·이름과 상태 후보 컬럼의 실제 값

읽기 전용 트랜잭션으로 조회하며 DB·동기화 상태는 변경하지 않습니다. 같은 명령을
다시 실행해도 기존 결과를 덮어쓰지 않습니다. 결과 폴더는 Git에서 제외됩니다.
개인정보가 포함되므로 원본 전체를 채팅·공유 저장소에 올리지 마세요. 휴직 여부 분석은
우선 개인정보 행이 없는 `schema.json`을 확인하고 필요한 상태 컬럼만 공유하세요.

### I_STATE_CODE 상태값 설명 조회

```powershell
npm run inspect:employee -- --state-codes
```

`I_STATE_CODE`의 타입·컬럼 설명, 회사 1700의 코드별 인원수, 외래키 연결,
기존 진단에서 사용한 공통코드 테이블 `tong_code`의 재직·휴직·복직 관련 명칭 후보를
`sync/exports/state_codes_1700_고유값/state_codes.json`에 저장합니다.
직원별 행·이름은 저장하지 않습니다. 명칭 검색 결과는 후보일 뿐이며, 실제 코드 그룹과
직원 상태값의 연결을 확인하기 전에는 휴직/재직 의미를 확정하지 않습니다.
후보 조회는 200행, 관련 그룹은 20개/1000행까지이며 생략 여부를 파일에 표시합니다.
