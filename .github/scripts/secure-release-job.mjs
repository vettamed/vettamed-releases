import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {spawn,spawnSync,execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const kind=process.env.BUILD_JOB,head=process.env.EXPECTED_HEAD,asset=process.env.SOURCE_ASSET_ID
assert.ok(['windows','windows-acceptance','platform','database','web','generation','hybrid'].includes(kind))
assert.match(head,/^[a-f0-9]{40}$/);assert.match(asset,/^[0-9]+$/)
assert.equal(process.env.GITHUB_REPOSITORY,'vettamed/vettamed-releases')
const key=Buffer.from(process.env.SOURCE_KEY,'hex');assert.equal(key.length,32)
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vettamed-private-build-')),source=path.join(root,'source'),log=path.join(root,'private.log'),fd=fs.openSync(log,'w'),checks=[]
const environment={...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://placeholder.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'placeholder-anon-key',SUPABASE_URL:'https://placeholder.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'placeholder-service-role',CSC_IDENTITY_AUTO_DISCOVERY:'false'}
for(const n of ['SOURCE_KEY','GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])delete environment[n]
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
let stage='download'
function run(label,command,args=[],extra={}){stage=label;const start=Date.now();const result=spawnSync(command,args,{cwd:source,env:environment,stdio:['pipe',fd,fd],...extra});checks.push({name:label,passed:result.status===0,durationMs:Date.now()-start});if(result.error||result.status!==0)throw Error('private command failed');console.log('Completed '+label)}
function npm(label,args){run(label,process.platform==='win32'?'npm.cmd':'npm',args,{shell:process.platform==='win32'})}
function node(label,args){run(label,process.execPath,args)}
function seal(bytes,aad){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const payload=Buffer.concat([c.update(bytes),c.final()]);return Buffer.concat([Buffer.from('VTBUILD1'),iv,c.getAuthTag(),payload])}
try{
 const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset}`,{headers:{authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'}});assert.equal(response.status,200)
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,8).toString(),'VTBUILD1');const d=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));d.setAAD(Buffer.from('vettamed:release-source:'+head));d.setAuthTag(bytes.subarray(20,36));const archive=path.join(root,'source.tar.gz');fs.writeFileSync(archive,Buffer.concat([d.update(bytes.subarray(36)),d.final()]));fs.mkdirSync(source)
 run('Extract authenticated source snapshot','tar',['-xzf',archive,'-C',source])
 execFileSync('git',['-C',source,'config','core.filemode','false']);execFileSync('git',['-C',source,'config','core.autocrlf','false'])
 assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),head)
 assert.equal(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim(),'')
 if(!['hybrid'].includes(kind))npm('Install locked dependencies',['ci'])
 if(kind==='windows'){
  assert.equal(process.platform,'win32');assert.equal(process.arch,'x64')
  npm('Windows native tests',['run','test','--workspace','@vettamed/desktop'])
  npm('Windows data adapter tests',['run','test','--workspace','@vettamed/supabase'])
  node('Fresh source-bound Windows package',['scripts/package-native-app.mjs','--win','--x64','--unsigned-production','--config.extraMetadata.version=3.2.32','--config.directories.output=apps/desktop/release/final-windows'])
  const out=path.join(source,'apps/desktop/release/final-windows'),manifest=JSON.parse(fs.readFileSync(path.join(source,'.tmp-evidence/student-release-manifest.json')))
  assert.equal(manifest.sourceHead,head);assert.equal(manifest.arch,'x64');assert.equal(manifest.version,'3.2.32')
  const req=createRequire(path.join(source,'apps/desktop/package.json')),asar=req('@electron/asar'),file=path.join(out,'win-unpacked/resources/app.asar')
  const files=asar.listPackage(file).map(n=>n.replace(/^[/\\]+/,'').replaceAll('\\','/')).filter(n=>!asar.statFile(file,n).files)
  const {auditNativeInventory}=await import(pathToFileURL(path.join(source,'scripts/native-package-contract.mjs')))
  const inventory=auditNativeInventory({mode:'asar',files,read:n=>asar.extractFile(file,n),manifest})
  const exe=path.join(out,'Vettamed-3.2.32-x64.exe'),published=path.join(out,'Vettamed-3.2.32-win-x64.exe')
  fs.renameSync(exe,published);fs.renameSync(exe+'.blockmap',published+'.blockmap')
  const feed=path.join(out,'latest.yml');fs.writeFileSync(feed,fs.readFileSync(feed,'utf8').replaceAll('Vettamed-3.2.32-x64.exe','Vettamed-3.2.32-win-x64.exe'))
  const receipt={schemaVersion:1,verifiedAt:new Date().toISOString(),sourceHead:head,product:'student',version:'3.2.32',arch:'x64',unsignedOwnerWaiver:manifest.signing.waiverId,asarSha256:hash(fs.readFileSync(file)),installerSha256:hash(fs.readFileSync(published)),inventory,manifest}
  const receiptFile=path.join(root,'3.2.32-windows-artifact.json');fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n')
  const release=JSON.parse(execFileSync('gh',['release','view','v3.2.32','--repo',process.env.GITHUB_REPOSITORY,'--json','isDraft'],{encoding:'utf8'}));assert.equal(release.isDraft,true)
  execFileSync('gh',['release','upload','v3.2.32',published,published+'.blockmap',feed,'--repo',process.env.GITHUB_REPOSITORY,'--clobber'],{stdio:['ignore',fd,fd]})
  execFileSync('gh',['release','upload',process.env.BUILD_TRANSFER_TAG,receiptFile,'--repo',process.env.GITHUB_REPOSITORY,'--clobber'],{stdio:['ignore',fd,fd]})
 }
 if(kind==='windows-acceptance'){
  assert.equal(process.platform,'win32');assert.match(process.env.EXPECTED_INSTALLER_SHA,/^[a-f0-9]{64}$/);assert.match(process.env.EXPECTED_ASAR_SHA,/^[a-f0-9]{64}$/)
  node('Compile real Windows shortcut probe',['node_modules/typescript/bin/tsc','-p','apps/desktop/tsconfig.electron.json'])
  const shortcutFile=path.join(root,'shortcuts.json');run('Hold and release actual Windows shortcut table',path.join(source,'apps/desktop/node_modules/electron/dist/electron.exe'),['scripts/probe-exam-lockdown.cjs',shortcutFile])
  execFileSync('gh',['release','download','v3.2.32','--repo',process.env.GITHUB_REPOSITORY,'--pattern','Vettamed-3.2.32-win-x64.exe','--dir',root],{stdio:['ignore',fd,fd]})
  const installer=path.join(root,'Vettamed-3.2.32-win-x64.exe');assert.equal(hash(fs.readFileSync(installer)),process.env.EXPECTED_INSTALLER_SHA)
  const installed=path.join(root,'installed');run('Install exact verified Windows package',installer,['/S','/D='+installed])
  const installedAsar=path.join(installed,'resources/app.asar');for(let i=0;i<100&&!fs.existsSync(installedAsar);i++)await new Promise(r=>setTimeout(r,200));assert.equal(hash(fs.readFileSync(installedAsar)),process.env.EXPECTED_ASAR_SHA)
  const app=spawn(path.join(installed,'Vettamed.exe'),['--user-data-dir='+path.join(root,'isolated-profile')],{env:environment,stdio:['ignore',fd,fd]})
  try{await new Promise(r=>setTimeout(r,12000));assert.equal(app.exitCode,null);run('Installed application creates native window','powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id '+app.pid+' -ErrorAction Stop; if($p.MainWindowHandle -eq 0){exit 1}'])}finally{spawnSync('taskkill',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore'})}
  const receipt={sourceHead:head,verifiedAt:new Date().toISOString(),runner:process.env.ACCEPTANCE_RUNNER,installerSha256:process.env.EXPECTED_INSTALLER_SHA,installedAsarSha256:process.env.EXPECTED_ASAR_SHA,installedPayloadMatchesAuditedAsar:true,isolatedNativeWindowStarted:true,shortcutProbe:JSON.parse(fs.readFileSync(shortcutFile))}
  const file=path.join(root,'windows-acceptance-'+process.env.ACCEPTANCE_RUNNER+'.json');fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');execFileSync('gh',['release','upload',process.env.BUILD_TRANSFER_TAG,file,'--repo',process.env.GITHUB_REPOSITORY,'--clobber'],{stdio:['ignore',fd,fd]})
 }
 if(kind==='platform'){
  npm('Dependency advisories',['run','audit:dependencies']);npm('All workspace types',['run','typecheck']);npm('Release target and ledger tests',['run','test:release-target'])
  for(const name of ['domain','assessment','security','i18n','workspace','supabase','desktop'])npm('Unit tests '+name,['run','test','--workspace','@vettamed/'+name])
  node('Adaptive routing regressions',['--test','scripts/adaptive/pilot.test.mjs','scripts/adaptive/bank-readiness.test.mjs','scripts/adaptive/bank-routing.test.mjs','scripts/attach-forensic-variants.test.mjs','scripts/local-mac-release-evidence.test.mjs'])
  npm('Protected desktop build',['run','build','--workspace','@vettamed/desktop']);npm('Protected runtime inventory',['run','audit:desktop:runtime'])
  run('Display dependencies','sudo',['apt-get','update']);run('Install display shim','sudo',['apt-get','install','-y','xvfb']);npm('Dynamic protected runtime',['run','audit:desktop:dynamic'])
  for(const name of ['functions:check','functions:test','audit:entitlements','audit:privacy','audit:i18n','audit:claims'])npm(name,['run',name])
 }
 if(kind==='database'){
  run('Database package metadata','sudo',['apt-get','update'])
  run('Database dependencies','bash',['-c','sudo apt-get install -y postgresql postgresql-contrib postgresql-client; PG_MAJOR="$(psql --version | awk \'{print $3}\' | cut -d. -f1)"; sudo apt-get install -y "postgresql-${PG_MAJOR}-pgtap" "postgresql-${PG_MAJOR}-pgvector"'],{env:environment})
  run('Start disposable database','sudo',['systemctl','start','postgresql'])
  run('Disposable database roles','sudo',['-u','postgres','psql','-v','ON_ERROR_STOP=1'],{input:"alter user postgres with password 'postgres';\ncreate database vettamed_ci;\ncreate database vettamed_billing_test;\ncreate database vettamed_stripe_test;\ndo $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role login bypassrls password 'service_role'; end if; end $$;\n"})
  environment.DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vettamed_ci';environment.VETTAMED_DB_AUDIT_PSQL_ONLY='1';environment.ADAPTIVE_TEST_DATABASE_URL=environment.DATABASE_URL;environment.HYBRID_BOUNDARY_TEST_DATABASE_URL=environment.DATABASE_URL;environment.HYBRID_TEST_DATABASE_URL=environment.DATABASE_URL.replace('postgresql:','postgresql+asyncpg:')
  npm('Complete migration RLS and seed matrix',['run','db:audit']);npm('Atomic adaptive database gates',['run','test:adaptive:db']);node('Native hybrid database gates',['--test','scripts/hybrid-protected-db.test.mjs'])
  run('Python hybrid dependencies','python',['-m','pip','install','./services/pragmatic-hybrid[dev]']);run('Hybrid model and actual transaction tests','python',['-m','pytest','services/pragmatic-hybrid/tests','-q','-p','no:cacheprovider'])
  environment.VETTAMED_INSTALMENTS_TEST_DB_URL='postgresql://postgres:postgres@127.0.0.1:5432/vettamed_billing_test';environment.VETTAMED_STRIPE_ATOMIC_TEST_DB_URL='postgresql://postgres:postgres@127.0.0.1:5432/vettamed_stripe_test';npm('Invoice evidence transitions',['run','test:instalments']);node('Atomic payment access transitions',['--test','scripts/stripe-instalment-atomic.test.mjs'])
 }
 if(kind==='web'){
  run('Browser dependencies','npx',['playwright','install','chromium','--with-deps']);npm('Production web build',['run','build','--workspace','@vettamed/web']);npm('Synthetic browser smoke suite',['run','test:smoke','--workspace','@vettamed/web'])
 }
 if(kind==='generation'){
  run('Canonical Python dependencies','python',['-m','pip','install','-r','generation/requirements.txt']);run('Canonical renderer dependencies',process.platform==='win32'?'npm.cmd':'npm',['ci','--prefix','generation/.render-tools'])
  run('Protected math regressions','python',['-m','unittest','discover','-s','generation','-p','test_protected_math.py']);run('Canonical generation regressions','python',['generation/tests_smoke.py']);npm('Review manifest integrity',['run','content:review-packets:verify'])
 }
 if(kind==='hybrid'){
  run('Hybrid test dependencies','python',['-m','pip','install','./services/pragmatic-hybrid[dev]']);run('Hybrid numerical service suite','python',['-m','pytest','services/pragmatic-hybrid/tests','-q','-p','no:cacheprovider']);node('Native practice round trip',['--experimental-strip-types','--test','scripts/hybrid-practice-roundtrip.test.ts'])
 }
 fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Verified ${kind} for source ${head}. ${checks.length} command groups passed.\n`)
 console.log(JSON.stringify({job:kind,sourceHead:head,passed:true,checks}))
}catch(error){
 fs.appendFileSync(log,'\nPrivate verifier exception: '+String(error.stack||error))
 const encrypted=path.join(root,`${kind}-${process.env.GITHUB_RUN_ID}.private-log.enc`);fs.writeFileSync(encrypted,seal(fs.readFileSync(log),'vettamed:release-log:'+head+':'+kind))
 try{execFileSync('gh',['release','upload',process.env.BUILD_TRANSFER_TAG,encrypted,'--repo',process.env.GITHUB_REPOSITORY,'--clobber'],{stdio:'ignore'})}catch{}
 console.error('Verification failed during '+stage+'. Diagnostics were encrypted for the owner.');process.exitCode=1
}finally{fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true});key.fill(0)}
