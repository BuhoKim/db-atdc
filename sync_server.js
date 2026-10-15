// Legacy root entry point: same company-1700 worker and 10-minute schedule.
const { main } = require('./sync/index');
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
