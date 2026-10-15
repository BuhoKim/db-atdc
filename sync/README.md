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
