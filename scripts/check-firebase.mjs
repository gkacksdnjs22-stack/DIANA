import { readFirebasePushOptions } from '../lib/firebase-push.mjs';

// Local validation only: no OAuth request, push, credential output or deployment.
try {
  const configured = await readFirebasePushOptions();
  console.log(JSON.stringify({ configured:configured.publicConfig.enabled,
    androidConfigValid:configured.publicConfig.enabled, serverCredentialsValid:Boolean(configured.sender),
    networkRequested:false }));
} catch (error) {
  console.error(error.code === 'FIREBASE_CONFIG' ? error.message : 'Firebase 설정을 확인하지 못했습니다.');
  process.exitCode = 1;
}
