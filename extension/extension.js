/* Marinara World Archive — phase 1 UI prototype (no model calls) */
(() => {
  'use strict';
  if (document.getElementById('marinara-world-archive-root')) return;
  const host = document.createElement('div');
  host.id = 'marinara-world-archive-root';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { font-family: system-ui, sans-serif; color:#e9e9ef }
    button,input,textarea {font:inherit} button {cursor:pointer}
    .launcher { position:fixed; right:20px; bottom:20px; z-index:2147483000; border:0; border-radius:100px; padding:12px 16px; background:#353d5f; color:#fff; box-shadow:0 4px 18px #0005 }
    .panel {position:fixed; right:20px; bottom:76px; width:min(420px,calc(100vw - 28px)); max-height:75vh; overflow:auto; box-sizing:border-box; z-index:2147483000; padding:18px; border:1px solid #555c75; border-radius:16px; background:#202437; color:#f6f7fa; box-shadow:0 8px 40px #0008 }
    .panel[hidden] {display:none} .head {display:flex;align-items:center;justify-content:space-between;gap:8px}
    h2 {font-size:19px;margin:0 0 12px} label {display:block;font-size:13px;margin:12px 0 5px}
    input,textarea {box-sizing:border-box;width:100%;padding:9px;border-radius:7px;border:1px solid #767d96;background:#111624;color:white}
    .actions {display:flex;gap:7px;margin:12px 0;flex-wrap:wrap} .actions button,.entry button {padding:7px 11px;border-radius:7px;border:1px solid #8588a4;background:#333b58;color:#fff}
    .entry {display:flex;align-items:center;gap:7px;border-top:1px solid #4e5467;padding:10px 0}
    .entry span {flex:1;min-width:0;overflow-wrap:anywhere}
    .selected {background:#435c83!important} .muted {color:#aeb4c8;font-size:12px}
    .error {color:#ffb3b3;white-space:pre-wrap} :focus-visible {outline:2px solid #e9c46a;outline-offset:2px}
  `;
  root.append(style);
  const launcher = document.createElement('button'); launcher.className='launcher'; launcher.textContent='세계관 설정집';
  launcher.type='button'; launcher.setAttribute('aria-expanded','false');
  const panel = document.createElement('section'); panel.className='panel'; panel.hidden=true; panel.setAttribute('aria-label','세계관 설정집');
  const heading = document.createElement('div'); heading.className='head';
  const title = document.createElement('h2'); title.textContent='세계관 설정집 · 개발판';
  const close = document.createElement('button'); close.type='button'; close.textContent='닫기';
  heading.append(title, close); panel.append(heading);
  const warning = document.createElement('p'); warning.className='muted'; warning.textContent='1단계: 세계관 목록만 관리해. 서버에 WORLD_ARCHIVE_ENABLE과 관리자 토큰 설정이 필요해.';
  panel.append(warning);
  const tokenLabel=document.createElement('label'); tokenLabel.textContent='월드 아카이브 전용 관리자 토큰';
  const tokenInput=document.createElement('input'); tokenInput.type='password'; tokenInput.autocomplete='off'; tokenInput.placeholder='이 화면에서만 보관돼';
  panel.append(tokenLabel,tokenInput);
  const actions=document.createElement('div'); actions.className='actions';
  const refresh=document.createElement('button'); refresh.textContent='목록 새로 고침';
  const add=document.createElement('button'); add.textContent='새 세계관';
  actions.append(refresh,add); panel.append(actions);
  const msg=document.createElement('p'); msg.setAttribute('role','status'); msg.className='error'; panel.append(msg);
  const list=document.createElement('div'); panel.append(list);
  root.append(launcher,panel);
  (document.body||document.documentElement).append(host);
  let selected=null, worlds=[], busy=false;
  const setMessage=t=>{msg.textContent=t||'';};
  const request=async(method,url,body)=>{
    if(!tokenInput.value.trim()) throw new Error('관리자 토큰을 입력해.');
    const response=await fetch(url,{method,headers:{'Authorization':'Bearer '+tokenInput.value.trim(),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json()}catch{throw new Error('서버 응답을 읽지 못했어.')}
    if(!response.ok)throw new Error(data.error||'서버 오류 '+response.status);
    return data;
  };
  const run=async fn=>{
    if(busy)return;busy=true;setMessage('');
    try{await fn()}catch(e){setMessage(e.message||String(e))}finally{busy=false}
  };
  const draw=()=>{
    list.replaceChildren();
    for(const w of worlds){
      const row=document.createElement('div');row.className='entry';
      const name=document.createElement('span');name.textContent=w.name+(selected===w.worldId?' · 선택됨':'');
      const choose=document.createElement('button');choose.textContent='선택';choose.className=selected===w.worldId?'selected':'';
      choose.onclick=()=>{selected=w.worldId;draw()};
      const rename=document.createElement('button');rename.textContent='이름 변경';
      rename.onclick=()=>run(async()=>{const next=prompt('세계관 이름',w.name);if(next===null)return;await request('PATCH','/api/world-archive/worlds/'+encodeURIComponent(w.worldId),{name:next,revision:w.revision});await load()});
      const del=document.createElement('button');del.textContent='삭제';
      del.onclick=()=>run(async()=>{if(!confirm('세계관 '+w.name+'을 삭제할까? 이 1단계에서는 삭제 취소 기능이 없어.'))return;await request('DELETE','/api/world-archive/worlds/'+encodeURIComponent(w.worldId),{revision:w.revision});if(selected===w.worldId)selected=null;await load()});
      row.append(name,choose,rename,del);list.append(row);
    }
    if(!worlds.length){const p=document.createElement('p');p.className='muted';p.textContent='아직 세계관이 없어.';list.append(p)}
  };
  const load=async()=>{const data=await request('GET','/api/world-archive/worlds');worlds=data.worlds||[];draw()};
  launcher.onclick=()=>{panel.hidden=!panel.hidden;launcher.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden&&tokenInput.value)run(load)};
  close.onclick=()=>{panel.hidden=true;launcher.setAttribute('aria-expanded','false')};
  refresh.onclick=()=>run(load);
  add.onclick=()=>run(async()=>{const name=prompt('새 세계관 이름');if(name===null)return;const w=await request('POST','/api/world-archive/worlds',{name});selected=w.worldId;await load()});
  tokenInput.addEventListener('keydown',e=>{if(e.key==='Enter')run(load)});
})();
