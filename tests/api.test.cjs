'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { attach } = require('../world-archive/lib/api.cjs');
const { patchSource } = require('../world-archive/marinara-world-archive-runtime.cjs');
const TOKEN='x'.repeat(40);
function fixture(t) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wa-api-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const routes={};
  const app={ get:(p,fn)=>routes['GET '+p]=fn, post:(p,fn)=>routes['POST '+p]=fn,
    patch:(p,fn)=>routes['PATCH '+p]=fn, delete:(p,fn)=>routes['DELETE '+p]=fn, log:{ error(){} } };
  attach(app,{token:TOKEN,dataDir:tmp});
  const call=async(method,path,body={},authorization='Bearer '+TOKEN)=>{
    const response={status:200,code(n){this.status=n;return this},send(data){return data}};
    const fn=routes[method+' /api/world-archive'+path.replace(/^\/api\/world-archive/,'')];
    assert.ok(fn);
    const m=path.match(/\/worlds\/([^/]+)$/);
    return {data:await fn({headers:{authorization},body,params:{worldId:m?.[1]}},response),status:response.status};
  };
  return {call,routes};
}
test('API requires token on every route',async t=>{
  const {call}=fixture(t);
  assert.equal((await call('GET','/worlds',{},'')).status,401);
  assert.equal((await call('POST','/worlds',{name:'A'},'Bearer wrong')).status,401);
  assert.equal((await call('GET','/worlds')).status,200);
});
test('API supports CRUD and revision conflicts',async t=>{
  const {call}=fixture(t);
  const a=await call('POST','/worlds',{name:'A'});
  assert.equal(a.status,200);
  const id=a.data.worldId;
  const list=await call('GET','/worlds');
  assert.equal(list.data.worlds.length,1);
  assert.equal((await call('PATCH','/worlds/'+id,{name:'B',revision:9})).status,409);
  assert.equal((await call('PATCH','/worlds/'+id,{name:'B',revision:1})).data.name,'B');
  assert.equal((await call('DELETE','/worlds/'+id,{revision:2})).data.deleted,true);
});
test('runtime hook patches exactly one known anchor',()=>{
  const anchor='    app.decorate("db", db);';
  assert.match(patchSource('before\n'+anchor+'\nafter'),/__marinaraWorldArchive/);
  assert.equal(patchSource('different engine'),null);
  assert.equal(patchSource(anchor+'\n'+anchor),null);
});
test('too short token blocks route registration',()=>{
  const app={};
  assert.throws(()=>attach(app,{token:'short',dataDir:'/tmp'}),/at least 24/);
});
