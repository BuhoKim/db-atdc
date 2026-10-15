const { createClient } = require('@supabase/supabase-js');
const { loadSyncEnv } = require('./loadEnv');

const COMPANY_PROJECT_REF = 'qcpqcuzvirmbjzqjzapt';
const COMPANY_SUPABASE_URL = `https://${COMPANY_PROJECT_REF}.supabase.co`;
const COMPANY_CODE = '1700';
const CAPS_GROUP = '09';

function getCompanySupabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  if (url !== COMPANY_SUPABASE_URL) {
    throw new Error(`SUPABASE_URL을 회사 DB ${COMPANY_SUPABASE_URL}로 설정하세요. PM2에 남은 이전 환경값도 확인하세요.`);
  }
  for (const [name, expected] of Object.entries({ MY_COMPANY_CODE: COMPANY_CODE, COMPANY_CODE, CAPS_E_GROUP: CAPS_GROUP })) {
    if (env[name] && String(env[name]).trim() !== expected) {
      throw new Error(`db-atdc 전용 설정 오류: ${name}은 ${expected}이어야 합니다.`);
    }
  }
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY에 회사 DB의 서버 전용 키를 설정하세요.');
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) {
    let claims;
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw new Error();
      claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    } catch {
      throw new Error('서버 키 형식 오류: 회사 DB의 secret 또는 service_role 키를 사용하세요.');
    }
    // Configuration guard only. Supabase verifies the key itself on every request.
    if (claims.role !== 'service_role' || claims.ref !== COMPANY_PROJECT_REF) {
      throw new Error('이전 DB 또는 브라우저용 키는 사용할 수 없습니다. 회사 DB의 서버 키와 PM2 환경변수를 확인하세요.');
    }
  }
  return { url, key };
}

function createSyncSupabaseClient() {
  loadSyncEnv();
  const { url, key } = getCompanySupabaseConfig();
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

module.exports = { COMPANY_PROJECT_REF, COMPANY_SUPABASE_URL, COMPANY_CODE, CAPS_GROUP,
  getCompanySupabaseConfig, createSyncSupabaseClient };
