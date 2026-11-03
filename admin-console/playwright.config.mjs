import {defineConfig} from '@playwright/test';
const port=Number(process.env.ADMIN_PREVIEW_PORT||43879);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('TEST_PORT_INVALID');
const baseURL='http://127.0.0.1:'+port;
export default defineConfig({testDir:'./browser-test',fullyParallel:false,workers:1,reporter:'list',outputDir:'generated/browser-results',use:{baseURL,viewport:{width:1440,height:1000},headless:true,launchOptions:process.env.ADMIN_TEST_CHROME_PATH?{executablePath:process.env.ADMIN_TEST_CHROME_PATH}:{}},webServer:{command:'node preview.mjs',url:baseURL+'/admin/',reuseExistingServer:false,timeout:30000}});
