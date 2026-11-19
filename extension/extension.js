/* Marinara World Archive (세계관 설정집) — personal extension UI. Talks only to /api/world-archive on the same server. */
(() => {
  'use strict';
  if (document.getElementById('marinara-world-archive-root')) return;
  const BASE = '/api/world-archive';
  const TYPES = [
    ['person', '인물'],
    ['place', '장소'],
    ['group', '집단'],
    ['rule', '규칙'],
    ['schedule', '일정'],
    ['custom', '기타'],
  ];
  const TYPE_LABEL = Object.fromEntries(TYPES);

  const host = document.createElement('div');
  host.id = 'marinara-world-archive-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Pretendard','Noto Sans KR','Malgun Gothic',sans-serif;font-size:14px;--bg:#1d2030;--card:#262a3d;--line:#3b4160;--ink:#eef0f7;--sub:#a9afc6;--accent:#8fb4ff;--warn:#ffb4a8;color:var(--ink)}
    @media (prefers-color-scheme: light){:host{--bg:#fbfaf7;--card:#ffffff;--line:#dedad0;--ink:#26262b;--sub:#6d6c73;--accent:#3a63c9;--warn:#b2402e}}
    *{box-sizing:border-box} button,input,textarea,select,p,div,span,label,b{font-family:inherit;color:inherit} button,input,textarea,select{font-size:inherit}
    button{cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:6px 11px}
    button.primary{background:var(--accent);border-color:var(--accent);color:#fff} button.ghost{background:none;border-color:transparent;color:var(--sub)}
    button.danger{color:var(--warn)} button:disabled{opacity:.5;cursor:default}
    input,textarea,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
    textarea{min-height:72px;resize:vertical;line-height:1.5}
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .launcher{position:fixed;right:16px;bottom:96px;z-index:2147483000;width:44px;height:44px;border-radius:50%;padding:0;display:grid;place-items:center;background:var(--card);box-shadow:0 4px 16px #0004}
    .launcher svg{width:22px;height:22px;stroke:var(--accent);fill:none;stroke-width:1.7}
    .panel{position:fixed;right:16px;bottom:150px;z-index:2147483000;width:min(440px,calc(100vw - 24px));max-height:min(78vh,760px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 44px #0006;overflow:hidden}
    .panel[hidden]{display:none}
    @media (max-width:600px){.panel{inset:auto 0 0 0;width:100vw;max-height:88vh;border-radius:16px 16px 0 0}}
    header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
    header h2{flex:1;margin:0;font-size:16px;font-weight:650}
    nav{display:flex;gap:4px;padding:8px 10px 0}
    nav button{border:0;border-radius:8px 8px 0 0;background:none;color:var(--sub);padding:8px 12px}
    nav button[aria-selected=true]{background:var(--card);color:var(--ink);font-weight:600}
    main{overflow:auto;padding:14px;background:var(--card);flex:1}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .row>*{flex:0 0 auto} .grow{flex:1 1 160px!important}
    .sub{color:var(--sub);font-size:12.5px;line-height:1.5} .msg{color:var(--warn);font-size:13px;white-space:pre-wrap;margin:0 0 8px}
    .msg.ok{color:var(--accent)}
    label{display:block;font-size:12.5px;color:var(--sub);margin:10px 0 4px}
    .box{border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 12px;background:var(--bg)}
    .box h3{margin:0 0 8px;font-size:14px}
    pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 ui-monospace,Menlo,monospace;margin:8px 0 0;max-height:260px;overflow:auto;background:var(--card);border-radius:8px;padding:10px}
    .world{display:flex;gap:8px;align-items:center;padding:9px 4px;border-top:1px solid var(--line)} .world:first-child{border-top:0}
    .world .name{flex:1;min-width:0;overflow-wrap:anywhere} .tag{font-size:11.5px;color:var(--accent);border:1px solid var(--accent);border-radius:99px;padding:0 7px}
    .ent{border-top:1px solid var(--line);padding:9px 2px} .ent:first-of-type{border-top:0}
    .ent .head{display:flex;gap:6px;align-items:center} .ent .head b{flex:1;min-width:0;overflow-wrap:anywhere}
    .ent p{margin:4px 0 0;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
    .group{font-size:12px;color:var(--sub);margin:14px 0 2px;font-weight:600}
    .check{display:flex;gap:6px;align-items:center;margin-top:10px;font-size:13px;color:var(--ink)} .check input{width:auto}
  </style>
  <button class="launcher" type="button" aria-label="세계관 설정집 열기" aria-expanded="false"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z"/></svg></button>
  <section class="panel" hidden aria-label="세계관 설정집">
    <header><h2>세계관 설정집</h2><button class="ghost close" type="button" aria-label="닫기">닫기</button></header>
    <nav role="tablist"></nav>
    <main></main>
  </section>`;
  (document.body || document.documentElement).append(host);

  const $ = (s) => root.querySelector(s);
  const launcher = $('.launcher');
  const panel = $('.panel');
  const nav = $('nav');
  const main = $('main');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const state = {
    tab: 'room',
    worlds: [],
    room: null, // { roomId, worldId }
    roomName: '',
    preview: null,
    worldId: null, // world being edited in the 세계관 tab
    entities: [],
    editing: null, // entityId being edited, or 'new'
    message: '',
    ok: false,
    busy: false,
  };

  const activeChatId = () => {
    try {
      return localStorage.getItem('marinara-active-chat-id') || '';
    } catch {
      return '';
    }
  };

  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { 'x-marinara-csrf': '1' } };
    if (method !== 'GET') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path.startsWith('/api/') ? path : BASE + path, init);
    } catch {
      throw Error('서버에 연결하지 못했어. 마리나라가 다시 켜지는 중이면 잠깐 뒤에 다시 해 줘.');
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (res.status === 404 && path.startsWith('/status')) throw Error('서버에 World Archive 모듈이 없거나 꺼져 있어. 서버 쪽 설치부터 확인해 줘.');
    if (res.status === 401) throw Error('마리나라 로그인이 끝났어. 페이지를 새로 고쳐 다시 로그인해 줘.');
    if (!res.ok) throw Error(data?.error || `서버 오류 (${res.status})`);
    return data;
  }

  async function run(fn, okText) {
    if (state.busy) return;
    state.busy = true;
    state.message = '';
    try {
      await fn();
      if (okText) (state.message = okText), (state.ok = true);
    } catch (e) {
      state.message = e?.message || String(e);
      state.ok = false;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function loadRoom() {
    const id = activeChatId();
    state.room = null;
    state.preview = null;
    state.roomName = '';
    if (!id) return;
    state.room = await api('GET', `/rooms/${encodeURIComponent(id)}`);
    if (state.room.worldId) state.preview = await api('GET', `/rooms/${encodeURIComponent(id)}/preview`);
    try {
      const chat = await api('GET', `/api/chats/${encodeURIComponent(id)}`);
      state.roomName = chat?.name || '';
    } catch {}
  }
  async function loadWorlds() {
    state.worlds = (await api('GET', '/worlds')).worlds || [];
    if (state.worldId && !state.worlds.some((w) => w.worldId === state.worldId)) state.worldId = null;
  }
  async function loadEntities() {
    state.entities = state.worldId ? (await api('GET', `/worlds/${state.worldId}/entities`)).entities || [] : [];
  }
  async function loadAll() {
    await api('GET', '/status');
    await loadWorlds();
    await Promise.all([loadRoom(), loadEntities()]);
  }

  // ------------------------------------------------------------------ views

  function viewRoom() {
    const id = activeChatId();
    if (!id) return '<p class="sub">채팅방을 하나 열고 다시 눌러 줘.</p>';
    const linked = state.room?.worldId;
    const options = state.worlds
      .map((w) => `<option value="${esc(w.worldId)}" ${w.worldId === linked ? 'selected' : ''}>${esc(w.name)}</option>`)
      .join('');
    const p = state.preview;
    return `
      <div class="box">
        <h3>${esc(state.roomName || '지금 채팅방')}</h3>
        ${state.worlds.length ? `
        <label for="wa-link">이 방이 읽을 세계관</label>
        <div class="row"><select id="wa-link" class="grow"><option value="">(연결 안 함)</option>${options}</select>
        <button class="primary" data-act="link" type="button">저장</button></div>`
        : '<p class="sub">아직 세계관이 없어. 「세계관」 탭에서 먼저 하나 만들어 줘.</p>'}
        <p class="sub">프리셋에 <b>{{세계}}</b>(또는 {{world}})를 넣은 자리에 연결한 세계관 설정이 들어가.</p>
      </div>
      ${linked && p ? `
      <div class="box">
        <h3>이번 답변에 들어갈 내용</h3>
        <p class="sub">${p.chars.toLocaleString()} / ${p.budget.toLocaleString()}자 · 설정 ${p.included.length}개${p.omitted.length ? ` · <b>길이 때문에 ${p.omitted.length}개 빠짐</b> (고정한 설정이 먼저 들어가)` : ''}</p>
        <pre>${esc(p.text) || '(비어 있음)'}</pre>
        <div class="row" style="margin-top:8px"><button data-act="edit-linked" type="button">이 세계관 고치기</button><button class="ghost" data-act="refresh" type="button">새로 보기</button></div>
      </div>` : ''}`;
  }

  function entityForm(e) {
    const t = e?.type || 'person';
    return `
      <div class="box" data-form="${esc(e?.entityId || 'new')}">
        <h3>${e ? '설정 고치기' : '새 설정'}</h3>
        <div class="row"><div class="grow"><label>종류</label><select name="type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === t ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="grow"><label>이름</label><input name="name" maxlength="120" value="${esc(e?.name || '')}"></div></div>
        <label>다른 이름 (쉼표로 나눠)</label><input name="aliases" value="${esc((e?.aliases || []).join(', '))}">
        <label>설명</label><textarea name="description" maxlength="4000">${esc(e?.description || '')}</textarea>
        <label class="check"><input type="checkbox" name="pinned" ${e?.pinned ? 'checked' : ''}> 늘 먼저 넣기 (고정)</label>
        <div class="row" style="margin-top:10px"><button class="primary" data-act="save-entity" type="button">저장</button><button class="ghost" data-act="cancel" type="button">취소</button></div>
      </div>`;
  }

  function viewWorlds() {
    const w = state.worlds.find((x) => x.worldId === state.worldId);
    if (!w) {
      const linked = state.room?.worldId;
      return `
        <div class="row" style="margin-bottom:10px"><span class="grow sub">세계관 ${state.worlds.length}개</span><button class="primary" data-act="new-world" type="button">새 세계관</button></div>
        <div class="box">${state.worlds.length ? state.worlds.map((x) => `
          <div class="world"><span class="name">${esc(x.name)}</span>${x.worldId === linked ? '<span class="tag">이 방</span>' : ''}<button data-act="open-world" data-id="${esc(x.worldId)}" type="button">열기</button></div>`).join('')
          : '<p class="sub">아직 없어. 「새 세계관」으로 만들어 줘.</p>'}</div>`;
    }
    const groups = TYPES.map(([type, label]) => {
      const list = state.entities.filter((e) => e.type === type);
      if (!list.length) return '';
      return `<div class="group">${label} ${list.length}</div>` + list.map((e) => state.editing === e.entityId ? entityForm(e) : `
        <div class="ent"><div class="head"><b>${esc(e.name)}</b>${e.pinned ? '<span class="tag">고정</span>' : ''}
        <button class="ghost" data-act="edit-entity" data-id="${esc(e.entityId)}" type="button">고치기</button>
        <button class="ghost danger" data-act="delete-entity" data-id="${esc(e.entityId)}" type="button">지우기</button></div>
        ${e.aliases.length ? `<div class="sub">다른 이름: ${esc(e.aliases.join(', '))}</div>` : ''}
        ${e.description ? `<p>${esc(e.description)}</p>` : ''}</div>`).join('');
    }).join('');
    return `
      <div class="row" style="margin-bottom:10px"><button class="ghost" data-act="back" type="button">‹ 목록</button></div>
      <div class="box">
        <h3>세계관</h3>
        <label>이름</label><input id="wa-wname" maxlength="120" value="${esc(w.name)}">
        <label>시대·배경 설명 (맨 앞에 들어가)</label><textarea id="wa-wdesc" maxlength="4000">${esc(w.description)}</textarea>
        <label>프롬프트에 넣을 최대 글자 수</label><input id="wa-wbudget" type="number" min="300" max="20000" step="100" value="${w.injectChars}">
        <div class="row" style="margin-top:10px"><button class="primary" data-act="save-world" type="button">저장</button><span class="grow"></span><button class="danger" data-act="delete-world" type="button">세계관 지우기</button></div>
      </div>
      <div class="row" style="margin:4px 0 6px"><span class="grow sub">설정 ${state.entities.length}개</span>${state.editing === 'new' ? '' : '<button class="primary" data-act="new-entity" type="button">새 설정</button>'}</div>
      ${state.editing === 'new' ? entityForm(null) : ''}
      <div>${groups || (state.editing === 'new' ? '' : '<p class="sub">아직 설정이 없어. 인물·장소·규칙 같은 걸 손으로 넣어 줘.</p>')}</div>`;
  }

  let lastView = '';
  function render() {
    nav.innerHTML = [['room', '이 방'], ['worlds', '세계관']]
      .map(([k, l]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`)
      .join('');
    const msg = state.message ? `<p class="msg ${state.ok ? 'ok' : ''}" role="status">${esc(state.message)}</p>` : '';
    const view = `${state.tab}|${state.worldId}|${state.editing}`;
    main.innerHTML = msg + (state.tab === 'room' ? viewRoom() : viewWorlds());
    // A new screen (tab, world, form) starts at the top; the same screen keeps its scroll.
    if (view !== lastView) main.scrollTop = 0;
    lastView = view;
    root.querySelectorAll('button').forEach((b) => (b.disabled = state.busy && !b.classList.contains('close')));
  }

  // ------------------------------------------------------------------ actions

  const formValue = (box) => ({
    type: box.querySelector('[name=type]').value,
    name: box.querySelector('[name=name]').value,
    aliases: box.querySelector('[name=aliases]').value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
    description: box.querySelector('[name=description]').value,
    pinned: box.querySelector('[name=pinned]').checked,
  });

  const actions = {
    link: () => run(async () => {
      const id = activeChatId();
      const worldId = root.getElementById('wa-link').value || null;
      await api('PUT', `/rooms/${encodeURIComponent(id)}`, { worldId });
      await loadRoom();
    }, '저장했어.'),
    refresh: () => run(loadAll),
    'edit-linked': () => run(async () => {
      state.tab = 'worlds';
      state.worldId = state.room.worldId;
      state.editing = null;
      await loadEntities();
    }),
    'new-world': () => run(async () => {
      const name = prompt('새 세계관 이름');
      if (!name) return;
      const w = await api('POST', '/worlds', { name });
      await loadWorlds();
      state.worldId = w.worldId;
      await loadEntities();
    }, '만들었어.'),
    'open-world': (b) => run(async () => {
      state.worldId = b.dataset.id;
      state.editing = null;
      await loadEntities();
    }),
    back: () => run(async () => {
      state.worldId = null;
      state.editing = null;
      await loadWorlds();
    }),
    'save-world': () => run(async () => {
      const w = state.worlds.find((x) => x.worldId === state.worldId);
      await api('PATCH', `/worlds/${w.worldId}`, {
        name: root.getElementById('wa-wname').value,
        description: root.getElementById('wa-wdesc').value,
        injectChars: Number(root.getElementById('wa-wbudget').value),
        revision: w.revision,
      });
      await loadWorlds();
      await loadRoom();
    }, '저장했어.'),
    'delete-world': () => run(async () => {
      const w = state.worlds.find((x) => x.worldId === state.worldId);
      if (!confirm(`세계관 「${w.name}」과 그 안의 설정 ${state.entities.length}개를 지울까?\n연결된 방들은 연결이 끊겨. (서버의 trash 폴더에 사본이 남아)`)) return;
      await api('DELETE', `/worlds/${w.worldId}`, { revision: w.revision });
      state.worldId = null;
      await loadWorlds();
      await loadRoom();
    }, '지웠어.'),
    'new-entity': () => ((state.editing = 'new'), (state.message = ''), render()),
    'edit-entity': (b) => ((state.editing = b.dataset.id), (state.message = ''), render()),
    cancel: () => ((state.editing = null), render()),
    'save-entity': (b) => run(async () => {
      const box = b.closest('[data-form]');
      const id = box.dataset.form;
      const v = formValue(box);
      if (id === 'new') await api('POST', `/worlds/${state.worldId}/entities`, v);
      else {
        const e = state.entities.find((x) => x.entityId === id);
        await api('PATCH', `/worlds/${state.worldId}/entities/${id}`, { ...v, revision: e.revision });
      }
      state.editing = null;
      await loadEntities();
      await loadRoom();
    }, '저장했어.'),
    'delete-entity': (b) => run(async () => {
      const e = state.entities.find((x) => x.entityId === b.dataset.id);
      if (!confirm(`「${e.name}」 설정을 지울까?`)) return;
      await api('DELETE', `/worlds/${state.worldId}/entities/${e.entityId}`, { revision: e.revision });
      await loadEntities();
      await loadRoom();
    }, '지웠어.'),
  };

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b === launcher) return toggle();
    if (b.classList.contains('close')) return toggle(false);
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      state.message = '';
      return run(state.tab === 'room' ? loadRoom : loadWorlds);
    }
    actions[b.dataset.act]?.(b);
  });

  let lastChat = '';
  let watch = null;
  function toggle(open = panel.hidden) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    clearInterval(watch);
    if (!open) return;
    lastChat = activeChatId();
    run(loadAll);
    // Marinara keeps the open chat in localStorage; follow it while the panel is open.
    watch = setInterval(() => {
      const now = activeChatId();
      if (now !== lastChat && !state.busy) {
        lastChat = now;
        run(loadRoom);
      }
    }, 1000);
  }
  render();
})();
