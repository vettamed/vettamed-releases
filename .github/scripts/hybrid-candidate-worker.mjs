import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
const metadata=JSON.parse(fs.readFileSync('.github/protected/hybrid-candidate-source.json'))
const key=Buffer.from(process.env.HYBRID_CANDIDATE_SOURCE_KEY||'','hex'),bytes=fs.readFileSync('.github/protected/hybrid-candidate-source.enc')
assert.equal(key.length,32);assert.equal(bytes.subarray(0,8).toString(),'VTCAND01')
const folder=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'hybrid-candidate-')),base={...process.env}
for(const name of ['HYBRID_CANDIDATE_SOURCE_KEY','HYBRID_DATABASE_URL','GITHUB_TOKEN','GH_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])delete base[name]
let stage='authenticated source'
function run(command,args,env=base){const r=spawnSync(command,args,{cwd:folder,env,encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0||r.error)throw Error('worker command failed');return r.stdout}
try{
 const decrypt=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));decrypt.setAAD(Buffer.from('vettamed:hybrid-candidate-source:'+metadata.sourceHead));decrypt.setAuthTag(bytes.subarray(20,36));const archive=path.join(folder,'source.tar.gz');fs.writeFileSync(archive,Buffer.concat([decrypt.update(bytes.subarray(36)),decrypt.final()]));run('tar',['-xzf',archive,'-C',folder])
 stage='locked-scope dependencies';const packageRoot=path.join(folder,'services/pragmatic-hybrid');run('python',['-m','pip','install',packageRoot+'[dev]'])
 stage='evidence-present candidate regression';run('python',['-m','pytest',path.join(packageRoot,'tests/test_weekly_candidates.py'),'-q','-p','no:cacheprovider'])
 stage='restricted database candidate fit';assert.ok(process.env.HYBRID_DATABASE_URL);assert.equal(new URL(process.env.HYBRID_DATABASE_URL).username,'hybrid_fit.pnmwjllzifusfaflxvvv')
 const script=String.raw`
import asyncio,json,os
from sqlalchemy import text
from pragmatic_hybrid.persistence import Repository
from pragmatic_hybrid.weekly_fit import run_weekly
async def main():
    url=os.environ['HYBRID_DATABASE_URL']
    repository=Repository(url)
    try:
        async with repository.engine.connect() as connection:
            row=(await connection.execute(text("select has_table_privilege(current_user,'hybrid.items','update') as active_write, has_table_privilege(current_user,'hybrid.fit_candidates','insert') as candidate_write, has_schema_privilege(current_user,'private','usage') as payload_access"))).mappings().one()
            assert not row['active_write'] and row['candidate_write'] and not row['payload_access']
    finally:
        await repository.close()
    result=await run_weekly(url)
    assert result.get('promotionAllowed') is False and result.get('written',0)==0
    allowed=['status','reason','observations','candidates','written','promotionAllowed','runId']
    print(json.dumps({k:result[k] for k in allowed if k in result}|{'activeItemWriteAllowed':False,'privatePayloadSchemaAccessible':False}))
try:
    asyncio.run(main())
except Exception:
    raise SystemExit(1)
`
 const report=JSON.parse(run('python',['-c',script],{...base,HYBRID_DATABASE_URL:process.env.HYBRID_DATABASE_URL,HYBRID_ALLOW_PRODUCTION:'1'}));assert.equal(report.promotionAllowed,false);assert.equal(report.written||0,0)
 console.log(JSON.stringify({sourceHead:metadata.sourceHead,...report}));fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'Candidate-only job completed; active item writes and private payload access are denied. '+report.status+' / '+(report.reason||'candidate report')+'\n')
}catch{console.error('Candidate job failed during '+stage+'; no database values or source were logged.');process.exitCode=1}
finally{key.fill(0);fs.rmSync(folder,{recursive:true,force:true})}
