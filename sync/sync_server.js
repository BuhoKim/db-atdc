// Legacy sync-folder entry point. Do not run alongside index.js.
const { main } = require('./index');
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
