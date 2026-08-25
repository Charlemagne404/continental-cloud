import { loadConfig } from './server/config.js';
import { createCloudServer } from './server/server.js';

const config = loadConfig();
const app = createCloudServer(config);
await app.initialize();
app.server.listen(config.port, config.host, () => console.log(`Continental Cloud ${config.appVersion} listening on http://${config.host}:${config.port}`));
async function stop() { await app.close(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
