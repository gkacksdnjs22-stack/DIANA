import { createControlServer } from './lib/control.mjs';
import { resolve } from 'node:path';
const port = Number(process.env.PORT || 3410);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT를 확인하세요.');
const server = createControlServer({ userToken: process.env.USER_TOKEN, agentToken: process.env.AGENT_TOKEN,
  gatewayToken: process.env.GATEWAY_TOKEN, deviceId: process.env.DEVICE_ID || 'home-pc',
  appOrigin: process.env.APP_ORIGIN, dbPath: resolve('.local/control.sqlite') });
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`원격비서 제어 화면: http://127.0.0.1:${port}`));
