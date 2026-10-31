import * as K from './core.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const HOURLY = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'relative_humidity_2m', 'visibility', 'precipitation'];
const LS_KEY = 'noeul.loc.v1';
const AFTER_SUNSET_S = 600; // 해 진 뒤 10분 예보로 계산
const DAYS = 7;
const STALE_MS = 30 * 60000;

const $ = (id) => document.getElementById(id);
const state = { loc: null, model: null, sel: 0, req: 0, locating: false };

/* ---------------- 시작 (실행은 파일 맨 끝에서: 아래 const들이 다 준비된 뒤) ---------------- */

function start() {
  const q = new URLSearchParams(location.search);
  const la = parseFloat(q.get('lat'));
  const lo = parseFloat(q.get('lon'));
  if (validLL(la, lo)) {
    const name = (q.get('name') || '').trim().slice(0, 20) || '지정 위치';
    setLoc({ kind: 'custom', name, lat: la, lon: lo }, { persist: false });
    return;
  }
  const saved = readSaved();
  if (saved) {
    setLoc(saved, { persist: false }); // 지난번 내 위치로 먼저 보여 주고
    locate({ quiet: true }); // GPS로 다시 잡는다
    return;
  }
  setLoc({ ...K.MINSAGO }, { persist: false });
}

function bind() {
  $('loc').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    clearQuery();
    if (b.dataset.loc === 'gps') locate({ quiet: false });
    else {
      state.locating = false;
      setLoc({ ...K.MINSAGO });
    }
  });
  $('days').addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (b) select(Number(b.dataset.i));
  });
  $('days').addEventListener('keydown', (e) => {
    if (!state.model) return;
    const n = state.model.days.length;
    let i = state.sel;
    if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else return;
    e.preventDefault();
    select(i);
    $('days').querySelector(`[data-i="${i}"]`)?.focus();
  });
  $('meta').addEventListener('click', (e) => {
    if (e.target.closest('#retry')) load({ keepSel: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.model && Date.now() - state.model.fetchedAt > STALE_MS) load({ keepSel: true });
  });
}

/* ---------------- 위치 ---------------- */

function clearQuery() {
  if (!location.search) return;
  try {
    history.replaceState(null, '', location.pathname + location.hash);
  } catch {
    /* 무시 */
  }
}

function validLL(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function readSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (v && v.kind === 'gps' && validLL(v.lat, v.lon)) return { kind: 'gps', name: '내 위치', lat: v.lat, lon: v.lon };
  } catch {
    /* 저장소를 못 쓰면 민사고로 */
  }
  return null;
}

function persist(loc) {
  try {
    if (loc.kind === 'gps') localStorage.setItem(LS_KEY, JSON.stringify({ kind: 'gps', lat: loc.lat, lon: loc.lon }));
    else if (loc.kind === 'minsago') localStorage.removeItem(LS_KEY);
  } catch {
    /* 무시 */
  }
}

function setLoc(loc, { persist: doSave = true } = {}) {
  state.loc = loc;
  if (doSave) persist(loc);
  renderLoc();
  load({ keepSel: false });
}

function locate({ quiet }) {
  if (state.locating) return;
  if (!('geolocation' in navigator)) {
    if (!quiet) toast('위치 기능을 쓸 수 없어요');
    return;
  }
  state.locating = true;
  renderLoc();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (!state.locating) return; // 그사이 민사고를 눌렀으면 무시
      state.locating = false;
      const lat = Math.round(pos.coords.latitude * 10000) / 10000;
      const lon = Math.round(pos.coords.longitude * 10000) / 10000;
      const cur = state.loc;
      // 같은 곳(2km 안)이면 다시 받지 않는다
      if (cur && cur.kind === 'gps' && K.haversine(cur.lat, cur.lon, lat, lon) < 2 && state.model) {
        persist({ kind: 'gps', lat, lon });
        renderLoc();
        return;
      }
      setLoc({ kind: 'gps', name: '내 위치', lat, lon });
    },
    (err) => {
      if (!state.locating) return;
      state.locating = false;
      renderLoc();
      if (!quiet || state.loc?.kind === 'gps') toast(err && err.code === 1 ? '위치 권한이 꺼져 있어요' : '위치를 찾지 못했어요');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000 },
  );
}

/* ---------------- 예보 받기 ---------------- */

async function getJSON(url, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    let j = null;
    try {
      j = await r.json();
    } catch {
      /* 아래에서 처리 */
    }
    if (!r.ok || (j && j.error)) throw new Error((j && j.reason) || `HTTP ${r.status}`);
    if (j == null) throw new Error('빈 응답');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchModel(loc) {
  const now = Date.now();
  // 표본 방향은 대략의 오늘 일몰 방위로 정한다 (며칠 사이 1~2°밖에 안 바뀜)
  const approxOff = Math.round(loc.lon / 15) * 3600;
  const ev0 = K.sunEventTime(K.localYMD(now, null, approxOff), loc.lat, loc.lon, approxOff, 'set');
  const az = ev0.t ? ev0.az : 270;
  const pts = K.DISTANCES.map((d) => (d === 0 ? { lat: loc.lat, lon: loc.lon } : K.destination(loc.lat, loc.lon, az, d)));
  const f4 = (v) => v.toFixed(4);

  const fcUrl = `${FORECAST}?${new URLSearchParams({
    latitude: pts.map((p) => f4(p.lat)).join(','),
    longitude: pts.map((p) => f4(p.lon)).join(','),
    hourly: HOURLY.join(','),
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '8',
  })}`;
  const aqUrl = `${AIR}?${new URLSearchParams({
    latitude: f4(loc.lat),
    longitude: f4(loc.lon),
    hourly: 'aerosol_optical_depth',
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '7',
  })}`;

  const [fcR, aqR] = await Promise.allSettled([getJSON(fcUrl), getJSON(aqUrl)]);
  if (fcR.status === 'rejected') throw fcR.reason;
  const arr = Array.isArray(fcR.value) ? fcR.value : [fcR.value];
  if (arr.length !== pts.length || !arr.every((a) => Array.isArray(a?.hourly?.time))) throw new Error('응답 형식 오류');
  const obs = arr[0];
  const aq = aqR.status === 'fulfilled' && Array.isArray(aqR.value?.hourly?.time) ? aqR.value : null;
  const tz = obs.timezone;
  const off = Number.isFinite(obs.utc_offset_seconds) ? obs.utc_offset_seconds : approxOff;
  const today = K.localYMD(now, tz, off);

  const days = [];
  for (let k = 0; k < DAYS; k++) {
    const ymd = K.addDays(today, k);
    const base = { idx: k, ymd, wd: K.weekdayKo(ymd) };
    const ev = K.sunEventTime(ymd, loc.lat, loc.lon, off, 'set');
    if (!ev.t) {
      days.push({ ...base, polar: ev.polar });
      continue;
    }
    const tS = Math.round(ev.t / 1000) + AFTER_SUNSET_S;
    const at = (a, key) => K.interpAt(a.hourly.time, a.hourly[key], tS);
    const res = K.scoreSunset({
      low: arr.map((a) => at(a, 'cloud_cover_low')),
      mid: arr.map((a) => at(a, 'cloud_cover_mid')),
      high: arr.map((a) => at(a, 'cloud_cover_high')),
      rh: at(obs, 'relative_humidity_2m'),
      vis: at(obs, 'visibility'),
      precip: at(obs, 'precipitation'),
      aod: aq ? at(aq, 'aerosol_optical_depth') : null,
    });
    days.push({ ...base, sunset: ev.t, res });
  }
  return { loc, tz, off, days, fetchedAt: now };
}

async function load({ keepSel }) {
  const my = ++state.req;
  if (!keepSel) state.sel = 0;
  const fresh = !state.model || state.model.loc !== state.loc;
  if (fresh) renderEmpty();
  try {
    const model = await fetchModel(state.loc);
    if (my !== state.req) return;
    state.model = model;
    state.sel = Math.min(state.sel, model.days.length - 1);
    render();
  } catch (e) {
    if (my !== state.req) return;
    console.error(e);
    if (fresh) renderError();
    else toast('새 예보를 받지 못했어요');
  }
}

function select(i) {
  if (!state.model || !Number.isInteger(i) || i < 0 || i >= state.model.days.length) return;
  state.sel = i;
  render();
}

/* ---------------- 그리기 ---------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ms, tz, off) {
  ms = Math.round(ms / 60000) * 60000; // 초는 반올림 (17:30:59 → 17:31)
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  } catch {
    const d = new Date(ms + (off || 0) * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}

function renderLoc() {
  const loc = state.loc;
  const custom = loc?.kind === 'custom' ? `<span class="here">${esc(loc.name)}</span>` : '';
  const btn = (key, label) => {
    const on = loc?.kind === key;
    const busy = key === 'gps' && state.locating;
    return `<button type="button" data-loc="${key}" aria-pressed="${on}"${busy ? ' class="busy" aria-busy="true"' : ''}>${label}</button>`;
  };
  $('loc').innerHTML = custom + btn('minsago', '민사고') + btn('gps', '내 위치');
}

function setHero({ when = ' ', score = '–', dim = true, grade = ' ', color = '', meta = ' ' }) {
  $('when').textContent = when;
  $('score').textContent = score;
  $('score').classList.toggle('dim', dim);
  $('grade').textContent = grade;
  $('grade').style.color = color;
  $('meta').innerHTML = meta;
}

function renderEmpty() {
  setHero({});
  $('days').innerHTML = '';
}

function renderError() {
  setHero({ grade: '예보를 불러오지 못했어요', meta: '<button type="button" id="retry">다시 시도</button>' });
  $('days').innerHTML = '';
}

function render() {
  const m = state.model;
  if (!m) return;
  const d = m.days[state.sel];
  const when = `${d.ymd.m}월 ${d.ymd.d}일 ${d.wd}요일`;
  if (d.polar) {
    setHero({ when, grade: d.polar === 'day' ? '백야' : '극야' });
  } else if (d.res.score == null) {
    setHero({ when, grade: '자료 부족', meta: `일몰 ${fmtTime(d.sunset, m.tz, m.off)}` });
  } else {
    setHero({
      when,
      score: String(d.res.score),
      dim: false,
      grade: d.res.grade.label,
      color: `var(--c-${d.res.grade.key})`,
      meta: `일몰 ${fmtTime(d.sunset, m.tz, m.off)}`,
    });
  }
  $('days').innerHTML = m.days
    .map((x) => {
      const s = x.res?.score;
      const on = x.idx === state.sel;
      const name = x.idx === 0 ? '오늘' : x.wd;
      const label = `${x.ymd.m}월 ${x.ymd.d}일 ${x.wd}요일 ${s == null ? '점수 없음' : `${s}점`}`;
      return `<button type="button" class="day" data-i="${x.idx}" aria-pressed="${on}" aria-label="${label}" tabindex="${on ? 0 : -1}"><span class="w">${name}</span><span class="s">${s ?? '–'}</span></button>`;
    })
    .join('');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

// 콘솔에서 확인용
window.__noeul = { state, K, load, select, setLoc };

bind();
start();
