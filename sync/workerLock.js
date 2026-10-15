const fs = require('fs');
const path = require('path');

function acquireWorkerLock(file = path.join(__dirname, '.sync-worker.lock')) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try {
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      process.once('exit', release);
      return () => { process.removeListener('exit', release); release(); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('동기화 잠금파일이 올바르지 않습니다. 실행 중인 프로세스를 확인하세요.');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if (probeError.code === 'ESRCH') { fs.unlinkSync(file); continue; }
        throw probeError;
      }
      throw new Error(`이미 db-atdc 동기화가 실행 중입니다 (PID ${pid}). 중복 실행을 중지한 뒤 다시 실행하세요.`);
    }
  }
  throw new Error('동기화 실행 잠금을 확보하지 못했습니다.');
}

module.exports = { acquireWorkerLock };
