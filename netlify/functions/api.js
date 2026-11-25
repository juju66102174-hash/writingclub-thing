// 우리 사이엔 글이 있다 — Netlify 함수 (Supabase 연결)
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY, TEACHER_CODE
'use strict';

const enc = encodeURIComponent;
const now = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

// ---------- DB (Supabase REST) ----------
async function rq(method, path, body, prefer) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url.startsWith('http') || !key) throw Object.assign(new Error('서버에 SUPABASE_URL / SUPABASE_SERVICE_KEY가 설정되지 않았어요'), { db: true });
  const r = await fetch(url, {
    method,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw Object.assign(new Error('DB 오류 ' + r.status + ' ' + t.slice(0, 200)), { db: true, status: r.status });
  return t ? JSON.parse(t) : null;
}
const norm = r => { const o = {}; for (const k in r) o[k] = r[k] === null ? '' : r[k];
  if ('chars' in o) o.chars = +o.chars || 0; if ('rd' in o) o.rd = +o.rd || 0; return o; };
const sel = async (t, filter = '', cols = '*') => (await rq('GET', `${t}?select=${enc(cols)}${filter}`)).map(norm);
const ins = (t, rows) => rq('POST', t, rows, 'return=minimal');
const upd = (t, filter, obj) => rq('PATCH', `${t}?${filter}`, obj, 'return=minimal');
const del = (t, filter) => rq('DELETE', `${t}?${filter}`, undefined, 'return=minimal');
const inList = ids => 'in.(' + ids.map(x => '"' + String(x).replace(/"/g, '') + '"').join(',') + ')';

// ---------- 도우미 ----------
function pub(l) {
  if (!l) return null;
  let av = {}; try { av = JSON.parse(l.avatar); } catch (e) {}
  return { id: l.id, cls: l.cls || '', nick: l.nick, avatar: av, title: l.title || '', nickChanged: !!l.nickChanged,
           text: l.text, status: l.status, savedAt: l.savedAt, sentAt: l.sentAt, partner: l.partner || '' };
}
const byId = async id => (await sel('letters', '&id=eq.' + enc(id)))[0];
const topic = async () => { const r = await sel('config', '&key=eq.topic'); return r[0] ? String(r[0].value) : ''; };
const folders = async () => {
  const m = {};
  (await sel('archive', '', 'rd,topic')).forEach(r => { (m[r.rd] = m[r.rd] || { rd: r.rd, topic: String(r.topic), count: 0 }).count++; });
  return Object.values(m).sort((x, y) => y.rd - x.rd);
};
const saveTopic = t => rq('POST', 'config', { key: 'topic', value: String(t || '') }, 'resolution=merge-duplicates,return=minimal');
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const RESET = { text: '', chars: 0, status: 'new', savedAt: '', sentAt: '', group: '', partner: '', title: '', nickChanged: '' };

// ---------- 요청 처리 ----------
async function handle(q) {
  const A = q.action;
  const auth = async () => {
    const l = await byId(String(q.id || ''));
    if (!l || String(l.pin) !== String(q.pin)) throw new Error('비밀번호가 맞지 않아요');
    return l;
  };

  // ----- 학생 -----
  if (A === 'login') {
    const nk = String(q.nick || '').trim().slice(0, 10);
    if (!/^\d{4}$/.test(String(q.pin)) || !nk) throw new Error('입력을 확인해 주세요');
    let ex = (await sel('letters', '&nick=eq.' + enc(nk)))[0], cur, returning = !!ex;
    if (!ex) {
      cur = { id: 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3), cls: '', nick: nk, pin: String(q.pin),
              name: String(q.name || '').slice(0, 20), avatar: JSON.stringify(q.avatar || {}), text: '', chars: 0, status: 'new' };
      try { await ins('letters', [cur]); }
      catch (e) { ex = (await sel('letters', '&nick=eq.' + enc(nk)))[0]; if (!ex) throw e; returning = true; }   // 동시에 같은 닉네임을 만든 경우
    }
    if (ex) {
      if (String(ex.pin) !== String(q.pin)) throw new Error('이미 있는 닉네임이에요. 비밀번호를 확인하거나 다른 닉네임을 써요');
      cur = ex;
      if (q.name && !ex.name) { cur = { ...ex, name: String(q.name).slice(0, 20) }; await upd('letters', 'id=eq.' + enc(ex.id), { name: cur.name }); }
    }
    const [tp, fo] = await Promise.all([topic(), folders()]);
    return { letter: pub(cur), topic: tp, returning, archiveCount: fo.length };
  }
  if (A === 'me') {
    const [l, tp, fo] = await Promise.all([auth(), topic(), folders()]);
    return { letter: pub(l), topic: tp, archiveCount: fo.length };
  }
  if (A === 'changeNick') {
    const l = await auth(), nk = String(q.newNick || '').trim().slice(0, 10);
    if (!nk) throw new Error('새 닉네임을 입력해 주세요');
    if (l.nickChanged) throw new Error('이번 주제에서는 이미 닉네임을 바꿨어요. 다음 주제에 다시 바꿀 수 있어요');
    if ((await sel('letters', '&nick=eq.' + enc(nk) + '&id=neq.' + enc(l.id))).length) throw new Error('이미 쓰고 있는 닉네임이에요. 다른 닉네임을 써요');
    try { await upd('letters', 'id=eq.' + enc(l.id), { nick: nk, nickChanged: '1' }); }
    catch (e) { if (e.status === 409) throw new Error('이미 쓰고 있는 닉네임이에요. 다른 닉네임을 써요'); throw e; }
    await upd('replies', 'id=eq.' + enc(l.id), { nick: nk });
    return { letter: pub({ ...l, nick: nk, nickChanged: '1' }) };
  }
  if (A === 'saveAvatar') { const l = await auth(); await upd('letters', 'id=eq.' + enc(l.id), { avatar: JSON.stringify(q.avatar) }); return { ok: true }; }
  if (A === 'saveLetter') {
    const l = await auth();
    if (l.status === 'sent') throw new Error('이미 보낸 글이에요');
    const text = String(q.text || '').slice(0, 5000), t = now();
    const o = { title: String(q.title || '').slice(0, 40), text, chars: text.length, status: q.status === 'sent' ? 'sent' : 'draft',
                savedAt: t, avatar: JSON.stringify(q.avatar || {}) };
    if (o.status === 'sent') o.sentAt = t;
    await upd('letters', 'id=eq.' + enc(l.id), o);
    return { letter: pub({ ...l, ...o }) };
  }
  if (A === 'partner') {
    const me = await auth();
    if (!me.partner) return {};
    const [p, pr, mine] = await Promise.all([byId(me.partner),
      sel('replies', '&id=eq.' + enc(me.partner) + '&status=eq.sent'), sel('replies', '&id=eq.' + enc(me.id))]);
    const rp = r => r && { text: r.text, status: r.status, sentAt: r.sentAt };
    return { partner: pub(p), partnerReply: rp(pr[0]), myReply: rp(mine[0]) };
  }
  if (A === 'saveReply') {
    const me = await auth();
    if (!me.partner) throw new Error('아직 짝꿍이 없어요');
    const ex = (await sel('replies', '&id=eq.' + enc(me.id)))[0];
    if (ex && ex.status === 'sent') throw new Error('이미 보낸 답장이에요');
    const t = now(), o = { to: me.partner, nick: me.nick, text: String(q.text || '').slice(0, 5000),
                           status: q.status === 'sent' ? 'sent' : 'draft', savedAt: t, sentAt: '' };
    if (o.status === 'sent') o.sentAt = t;
    if (ex) await upd('replies', 'id=eq.' + enc(me.id), o); else await ins('replies', [{ id: me.id, ...o }]);
    return { reply: { text: o.text, status: o.status, sentAt: o.sentAt } };
  }
  if (A === 'archive') { await auth(); return { folders: await folders() }; }
  if (A === 'archiveRound') {
    await auth();
    const items = (await sel('archive', '&rd=eq.' + enc(q.rd))).map(r => ({
      id: r.id, cls: r.cls, nick: r.nick, title: r.title, text: r.text, sentAt: r.sentAt, replyNick: r.replyNick, replyText: r.replyText, topic: String(r.topic) }));
    return { items };
  }

  // ----- 교사 (코드 필요) -----
  const TC = process.env.TEACHER_CODE;
  if (!TC) throw new Error('서버에 TEACHER_CODE가 설정되지 않았어요');
  if (String(q.code) !== TC) throw new Error('코드가 틀렸어요');
  if (A === 'tCheck') return { ok: true };
  if (A === 'tAll') {
    const [ls, rs, tp, fo] = await Promise.all([sel('letters', '&order=createdAt.asc'), sel('replies'), topic(), folders()]);
    ls.forEach(r => { delete r.pin; delete r.avatar; });
    return { letters: ls, replies: rs, topic: tp, folders: fo };
  }
  if (A === 'tArchive') {
    return { items: (await sel('archive', '&order=aid.asc')).map(r => ({ rd: r.rd, topic: String(r.topic), id: r.id, cls: r.cls, nick: r.nick, title: r.title, chars: String(r.text || '').length, sentAt: r.sentAt })) };
  }
  if (A === 'setTopic') { await saveTopic(q.topic); return { ok: true }; }
  if (A === 'newTopic') {      // 지금까지의 글을 주제 폴더로 보관하고 모두 새로 쓸 수 있게 초기화
    const [all, rep, tp0, old] = await Promise.all([sel('letters'), sel('replies'), topic(), sel('archive', '', 'rd')]);
    const sent = all.filter(r => r.status === 'sent');
    if (sent.length) {
      const rd = 1 + Math.max(0, ...old.map(r => r.rd)), t = now(), tp = tp0 || '(주제 없음)';
      await ins('archive', sent.map(r => { const rp = rep.find(x => String(x.to) === r.id && x.status === 'sent');
        return { rd, topic: tp, id: r.id, cls: r.cls, nick: r.nick, title: r.title, text: r.text, sentAt: r.sentAt,
                 replyNick: rp ? rp.nick : '', replyText: rp ? rp.text : '', archivedAt: t }; }));
    }
    await Promise.all([upd('letters', 'id=not.is.null', RESET), del('replies', 'id=not.is.null')]);
    await saveTopic(q.topic);
    return { archived: sent.length };
  }
  if (A === 'tDeleteRound') { await del('archive', 'rd=eq.' + enc(q.rd)); return { ok: true }; }
  if (A === 'tDeleteArchived') { await del('archive', 'rd=eq.' + enc(q.rd) + '&id=eq.' + enc(q.id)); return { ok: true }; }
  if (A === 'setGroup') {
    await upd('letters', 'id=eq.' + enc(q.id), { group: ['짧은 글', '긴 글'].includes(q.group) ? q.group : '' });
    return { ok: true };
  }
  if (A === 'autoGroup') {
    const sent = (await sel('letters', '&status=eq.sent')).sort((x, y) => x.chars - y.chars), half = Math.ceil(sent.length / 2);
    const sh = sent.slice(0, half).map(r => r.id), lo = sent.slice(half).map(r => r.id);
    await Promise.all([sh.length && upd('letters', 'id=' + enc(inList(sh)), { group: '짧은 글' }), lo.length && upd('letters', 'id=' + enc(inList(lo)), { group: '긴 글' })]);
    return { n: sent.length };
  }
  if (A === 'assign') {      // 같은 그룹 안에서 반 상관없이 완전 무작위 짝
    const sent = await sel('letters', '&status=eq.sent');
    await upd('letters', 'id=not.is.null', { partner: '' });
    const groups = {}; sent.forEach(r => (groups[r.group || ''] = groups[r.group || ''] || []).push(r));
    let pairs = 0, alone = 0; const jobs = [];
    Object.keys(groups).forEach(k => {
      const m = shuffle(groups[k]);
      while (m.length > 1) { const x = m.pop(), y = m.pop();
        jobs.push(upd('letters', 'id=eq.' + enc(x.id), { partner: y.id }), upd('letters', 'id=eq.' + enc(y.id), { partner: x.id })); pairs++; }
      alone += m.length;
    });
    await Promise.all(jobs);
    return { pairs, alone };
  }
  if (A === 'tDelete') {
    const ids = (q.ids || []).map(String);
    if (!ids.length) return { deleted: 0 };
    const L = enc(inList(ids));
    await upd('letters', 'partner=' + L, { group: '', partner: '' });   // 짝꿍이 삭제된 사람의 배정은 비움
    await Promise.all([del('letters', 'id=' + L), del('replies', 'id=' + L), del('replies', 'to=' + L), del('archive', 'id=' + L)]);
    return { deleted: ids.length };
  }
  throw new Error('알 수 없는 요청');
}

exports.handler = async (event) => {
  const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    const q = JSON.parse(event.body || '{}');
    return { statusCode: 200, headers: H, body: JSON.stringify(await handle(q)) };
  } catch (e) {
    if (e.db) return { statusCode: 503, headers: H, body: JSON.stringify({ error: '잠시 연결이 불안정해요. 다시 시도해 주세요.', detail: String(e.message).slice(0, 200) }) };
    return { statusCode: 200, headers: H, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
exports._handle = handle;
