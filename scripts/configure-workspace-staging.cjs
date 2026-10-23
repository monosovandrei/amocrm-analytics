'use strict';
const fs=require('node:fs');
const root='/opt/analytics-staging-workspaces-20261023';
const file=`${root}/.env`;
let env=fs.readFileSync(file,'utf8');
const parsed=require(`${root}/node_modules/dotenv`).parse(env);
const url=new URL(parsed.DATABASE_URL);
url.pathname='/analytics_workspace_check_20261023';
const values={DATABASE_URL:url.toString(),PORT:'4100',BIND_HOST:'127.0.0.1',WEB_ORIGIN:'http://127.0.0.1:3400,http://localhost:3400',BUILD_ID:'workspace-staging-20261023',METRIC_VERSION:'2026-10-23.1',WORKER_ROLE:'verification'};
for(const [key,value] of Object.entries(values)){
  const line=`${key}=${JSON.stringify(value)}`;
  env=env.split(/\r?\n/).filter(entry=>!entry.startsWith(`${key}=`)).join('\n')+`\n${line}\n`;
}
fs.writeFileSync(file,env,{mode:0o600});
console.log('Isolated staging environment configured; credentials not printed');
