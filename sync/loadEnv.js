const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadSyncEnv() {
  const cwd = process.cwd();
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '.env.local'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
    path.join(cwd, '..', '.env'),
    path.join(cwd, '..', '.env.local'),
  ];

  for (const filePath of candidates) {
    parseEnvFile(filePath);
  }
}

module.exports = { loadSyncEnv };
