'use strict';
// Run every API test in fresh, sequential processes. ts-jest must not retain
// the complete generated Prisma type graph across the whole suite on an 8 GB host.
const {execFileSync,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),jest=path.join(root,'node_modules/jest/bin/jest.js'),config=path.join(root,'apps/api/jest.config.js');
const listed=execFileSync(process.execPath,['--max-old-space-size=256',jest,'--listTests','--json','--runInBand','--config',config],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit']});
const tests=JSON.parse(listed).sort();if(!tests.length)throw new Error('No API tests discovered');
const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-api-tests-'));
let suites=0,passed=0,failed=0,failedSuites=0;
for(let offset=0;offset<tests.length;offset+=10){
  const file=path.join(evidence,`${offset}.json`),batch=tests.slice(offset,offset+10);
  const child=spawnSync(process.execPath,['--max-old-space-size=768',jest,'--runInBand','--config',config,'--json','--outputFile',file,'--runTestsByPath',...batch],{cwd:root,stdio:'inherit'});
  if(!fs.existsSync(file)){console.error(JSON.stringify({status:'failed',batch:offset/10+1,reason:'Test process did not complete',exitCode:child.status}));process.exit(1);}
  const result=JSON.parse(fs.readFileSync(file,'utf8'));suites+=result.numTotalTestSuites;passed+=result.numPassedTests;failed+=result.numFailedTests;failedSuites+=result.numFailedTestSuites;
  console.log(JSON.stringify({batch:offset/10+1,suites:result.numTotalTestSuites,passed:result.numPassedTests,failed:result.numFailedTests}));
  if(child.status!==0&&!result.numFailedTestSuites)failedSuites++;
}
const status=failed===0&&failedSuites===0&&suites===tests.length?'passed':'failed';
console.log(JSON.stringify({status,discoveredSuites:tests.length,suites,passedTests:passed,failedTests:failed,failedSuites,evidenceDirectory:evidence}));if(status!=='passed')process.exitCode=1;
