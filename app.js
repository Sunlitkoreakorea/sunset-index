// 배포 때마다 index.html의 ?v= 와 함께 올린다 (GitHub Pages가 10분 캐시함)
import * as K from './core.js?v=9';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const HOURLY = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'relative_humidity_2m', 'visibility', 'precipitation'];
const LS_KEY = 'noeul.loc.v1';
const AFTER_SUNSET_S = 600; // 해 진 뒤 10분 예보로 계산
const DAYS = 14; // 2주 (Open-Meteo는 16일까지 줌)
const STALE_MS = 30 * 60000;

const $ = (id) => document.getElementById(id);
const VIEW_KEY = 'noeul.view.v1';
const state = { loc: null, model: null, sel: 0, req: 0, locating: false, view: readView(), req3d: 0 };
let grid = null; // { model, promise } 3D용 옆 칸 구름
let scene3d = null;
let sceneMod = null;

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
    setLoc(saved, { persist: false }); // 지난번 위치로 먼저 보여 주고
    if (saved.kind === 'gps') locate({ quiet: true }); // 내 위치였으면 GPS로 다시 잡는다
    return;
  }
  setLoc({ ...K.MINSAGO }, { persist: false });
}

function bind() {
  $('loc').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.loc === 'pick') {
      if ($('pick').hidden) openPick();
      else closePick();
      return;
    }
    closePick();
    clearQuery();
    if (b.dataset.loc === 'gps') locate({ quiet: false });
    else {
      state.locating = false;
      setLoc({ ...K.MINSAGO });
    }
  });
  $('pickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  $('pickClose').addEventListener('click', () => closePick({ refocus: true }));
  $('pick').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePick({ refocus: true });
  });
  $('pickList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    const p = b && pickResults[Number(b.dataset.i)];
    if (!p) return;
    closePick();
    clearQuery();
    state.locating = false;
    setLoc({ kind: 'custom', name: p.name.slice(0, 30), lat: p.lat, lon: p.lon });
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
    else if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 7);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 7);
    else return;
    e.preventDefault();
    select(i);
    $('days').querySelector(`[data-i="${i}"]`)?.focus();
  });
  $('meta').addEventListener('click', (e) => {
    if (e.target.closest('#retry')) load({ keepSel: true });
  });
  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.view === state.view) return;
    state.view = b.dataset.view;
    try {
      localStorage.setItem(VIEW_KEY, state.view);
    } catch {
      /* 무시 */
    }
    render();
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
    if (!v || !validLL(v.lat, v.lon)) return null;
    if (v.kind === 'gps') return { kind: 'gps', name: '내 위치', lat: v.lat, lon: v.lon };
    if (v.kind === 'custom' && typeof v.name === 'string') return { kind: 'custom', name: v.name.slice(0, 30), lat: v.lat, lon: v.lon };
  } catch {
    /* 저장소를 못 쓰면 민사고로 */
  }
  return null;
}

function persist(loc) {
  try {
    if (loc.kind === 'gps') localStorage.setItem(LS_KEY, JSON.stringify({ kind: 'gps', lat: loc.lat, lon: loc.lon }));
    else if (loc.kind === 'custom') localStorage.setItem(LS_KEY, JSON.stringify({ kind: 'custom', name: loc.name, lat: loc.lat, lon: loc.lon }));
    else if (loc.kind === 'minsago') localStorage.removeItem(LS_KEY);
  } catch {
    /* 무시 */
  }
}

/* ---------------- 다른 곳 고르기 (장소 검색) ---------------- */

let pickResults = [];
let lastSearchAt = 0;
let searchSeq = 0;

function openPick() {
  $('pick').hidden = false;
  renderLoc();
  $('pickInput').focus();
  $('pickInput').select();
}

function closePick({ refocus = false } = {}) {
  if ($('pick').hidden) return;
  $('pick').hidden = true;
  renderLoc();
  if (refocus) $('loc').querySelector('[data-loc="pick"]')?.focus(); // 숨긴 입력칸에 초점이 남지 않게
}

function pickMsg(text) {
  pickResults = [];
  $('pickList').innerHTML = text ? `<li class="p-msg">${esc(text)}</li>` : '';
}

async function runSearch() {
  const q = $('pickInput').value.trim();
  if (!q) return;
  const my = ++searchSeq;
  pickMsg('…');
  try {
    const { items, osm } = await searchPlaces(q);
    if (my !== searchSeq) return;
    if (!items.length) return pickMsg('결과 없음');
    pickResults = items;
    $('pickList').innerHTML =
      items
        .map(
          (p, i) =>
            `<li><button type="button" data-i="${i}"><span class="p-name">${esc(p.name)}</span><span class="p-sub">${esc(p.sub)}</span></button></li>`,
        )
        .join('') + (osm ? '<li class="p-attr">© OpenStreetMap</li>' : '');
  } catch (e) {
    if (my !== searchSeq) return;
    console.error(e);
    pickMsg('찾지 못했어요');
  }
}

// "37.5, 127.0" 같은 좌표는 그대로, 아니면 OpenStreetMap(Nominatim) → 안 되면 Open-Meteo 지명 검색
async function searchPlaces(q) {
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (validLL(lat, lon)) return { items: [{ name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, sub: '좌표', lat, lon }], osm: false };
  }
  const wait = lastSearchAt + 1100 - Date.now(); // Nominatim 이용 규칙: 1초에 한 번
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
  try {
    const j = await getJSON(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': 'ko', addressdetails: '1' })}`,
      12000,
    );
    if (!Array.isArray(j)) throw new Error('응답 형식 오류');
    const items = j.map((r) => ({
      name: (r.name || String(r.display_name || '').split(',')[0]).trim(),
      sub: placeSub(r.address),
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));
    return { items: dedupe(items), osm: true };
  } catch (e) {
    console.warn('Nominatim 실패, Open-Meteo 검색으로', e);
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '8', language: 'ko' })}`, 12000);
    const items = (j.results || []).map((r) => ({
      name: r.name,
      sub: [r.admin1, r.country].filter(Boolean).join(' · '),
      lat: r.latitude,
      lon: r.longitude,
    }));
    return { items: dedupe(items), osm: false };
  }
}

function placeSub(a = {}) {
  const parts = [a.city || a.county || a.town || a.village || a.municipality, a.province || a.state];
  if (a.country && a.country_code !== 'kr') parts.push(a.country);
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

// 이름이 같고 2km 안이면 하나만
function dedupe(items) {
  const out = [];
  for (const p of items) {
    if (!p.name || !validLL(p.lat, p.lon)) continue;
    if (out.some((o) => o.name === p.name && K.haversine(o.lat, o.lon, p.lat, p.lon) < 2)) continue;
    out.push(p);
  }
  return out;
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
    forecast_days: '16',
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
    const sample = {
      low: arr.map((a) => at(a, 'cloud_cover_low')),
      mid: arr.map((a) => at(a, 'cloud_cover_mid')),
      high: arr.map((a) => at(a, 'cloud_cover_high')),
      rh: at(obs, 'relative_humidity_2m'),
      vis: at(obs, 'visibility'),
      precip: at(obs, 'precipitation'),
      aod: aq ? at(aq, 'aerosol_optical_depth') : null,
      at: tS * 1000,
    };
    days.push({ ...base, sunset: ev.t, sample, res: K.scoreSunset(sample) });
  }
  return { loc, pts, az, tz, off, days, fetchedAt: now };
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
  const open = !$('pick').hidden;
  const btn = (key, label, on) => {
    const busy = key === 'gps' && state.locating;
    const extra = key === 'pick' ? ` aria-expanded="${open}" title="${esc(label)}"` : '';
    return `<button type="button" data-loc="${key}" aria-pressed="${on}"${busy ? ' class="busy" aria-busy="true"' : ''}${extra}>${esc(label)}</button>`;
  };
  const custom = loc?.kind === 'custom';
  $('loc').innerHTML =
    btn('minsago', '민사고', loc?.kind === 'minsago') +
    btn('gps', '내 위치', loc?.kind === 'gps') +
    btn('pick', custom ? loc.name : '다른 곳', custom || open);
}

function setHero({ when = ' ', score = '–', dim = true, grade = ' ', color = '', meta = ' ' }) {
  $('when').textContent = when;
  $('score').textContent = score;
  $('score').classList.toggle('dim', dim);
  $('grade').textContent = grade;
  $('grade').style.color = color;
  $('meta').innerHTML = meta;
}

function showMore(on) {
  for (const id of ['sectionBlk', 'factorBlk', 'rawBlk']) $(id).hidden = !on;
  if (!on) scene3d?.stop();
}

function renderEmpty() {
  setHero({});
  $('days').innerHTML = '';
  showMore(false);
}

function renderError() {
  setHero({ grade: '예보를 불러오지 못했어요', meta: '<button type="button" id="retry">다시 시도</button>' });
  $('days').innerHTML = '';
  showMore(false);
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
      const name = x.idx === 0 ? '오늘' : `${x.wd} ${x.ymd.d}`;
      const label = `${x.ymd.m}월 ${x.ymd.d}일 ${x.wd}요일 ${s == null ? '점수 없음' : `${s}점`}`;
      return `<button type="button" class="day" data-i="${x.idx}" aria-pressed="${on}" aria-label="${label}" tabindex="${on ? 0 : -1}"><span class="w">${name}</span><span class="s">${s ?? '–'}</span></button>`;
    })
    .join('');

  const ok = !d.polar && d.res.score != null;
  showMore(ok);
  if (ok) {
    renderCloud(d, m);
    renderFactors(d);
    renderRaw(d, m);
  } else scene3d?.stop();
}

/* ---------------- 구름 단면도: 2D / 3D ---------------- */

function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

function renderCloud(d, m) {
  for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  $('sectionMeta').textContent = `${K.compassKo(m.az)} ${Math.round(m.az)}° · ${fmtTime(d.sample.at, m.tz, m.off)}`;
  const is3d = state.view === '3d';
  $('section').hidden = is3d;
  $('scene3d').hidden = !is3d;
  if (is3d) render3d(d, m);
  else {
    scene3d?.stop();
    renderSection(d, m);
  }
}

const LATERAL = [-100, -50, 0, 50, 100]; // scene3d.js와 같은 값

// 3D용: 해 지는 길 양옆까지 7 × 5 = 35곳 구름 (위치·예보가 바뀔 때만 새로 받음)
function getGrid(m) {
  if (grid && grid.model === m) return grid.promise;
  const pts = [];
  K.DISTANCES.forEach((km, di) => {
    const c = km === 0 ? { lat: m.loc.lat, lon: m.loc.lon } : K.destination(m.loc.lat, m.loc.lon, m.az, km);
    LATERAL.forEach((l, li) => {
      const p = l === 0 ? c : K.destination(c.lat, c.lon, m.az + (l > 0 ? 90 : -90), Math.abs(l));
      pts.push({ di, li, lat: p.lat, lon: p.lon });
    });
  });
  const url = `${FORECAST}?${new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(4)).join(','),
    longitude: pts.map((p) => p.lon.toFixed(4)).join(','),
    hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high',
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '16',
  })}`;
  const promise = getJSON(url).then((j) => {
    const arr = Array.isArray(j) ? j : [j];
    if (arr.length !== pts.length || !arr.every((a) => Array.isArray(a?.hourly?.time))) throw new Error('응답 형식 오류');
    return pts.map((p, i) => ({ ...p, hourly: arr[i].hourly }));
  });
  grid = { model: m, promise };
  promise.catch(() => {
    if (grid?.promise === promise) grid = null; // 다음에 다시 시도
  });
  return promise;
}

function scene3dMsg(text) {
  let el = $('scene3d').querySelector('.s3-msg');
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 's3-msg';
    $('scene3d').prepend(el);
  }
  el.textContent = text;
}

async function render3d(d, m) {
  const my = ++state.req3d;
  if (!scene3d) scene3dMsg('…');
  try {
    sceneMod ??= await import('./scene3d.js?v=9');
    const pts = await getGrid(m);
    if (my !== state.req3d || state.view !== '3d') return;
    if (!scene3d) scene3d = sceneMod.createScene($('scene3d'), { distances: K.DISTANCES });
    scene3dMsg('');
    const tS = d.sample.at / 1000;
    const cells = pts.map((p) => {
      if (p.li === 2) return { di: p.di, li: p.li, low: d.sample.low[p.di], mid: d.sample.mid[p.di], high: d.sample.high[p.di] };
      const at = (k) => K.interpAt(p.hourly.time, p.hourly[k], tS);
      return { di: p.di, li: p.li, low: at('cloud_cover_low'), mid: at('cloud_cover_mid'), high: at('cloud_cover_high') };
    });
    const worst = worstBlock(d.sample);
    scene3d.update(cells, {
      P: d.res.parts.P,
      worstKm: K.DISTANCES[worst],
      sideNames: [K.compassKo(m.az - 90), K.compassKo(m.az + 90)],
    });
    scene3d.start();
  } catch (e) {
    if (my !== state.req3d) return;
    console.error(e);
    scene3d?.stop();
    scene3dMsg('3D를 불러오지 못했어요');
  }
}

// 구름 단면도: 왼쪽이 관측 지점, 오른쪽이 해 지는 쪽
function renderSection(d, m) {
  const s = d.sample;
  const P = d.res.parts.P;
  const x0 = 56;
  const x1 = 440;
  const xs = (km) => x0 + (x1 - x0) * Math.sqrt(km / 500);
  const bounds = [0, 15, 55, 115, 200, 300, 400, 500];
  const ground = 150;
  const rows = [
    { key: 'high', label: '상층', y: 6, h: 40 },
    { key: 'mid', label: '중층', y: 52, h: 44 },
    { key: 'low', label: '하층', y: 102, h: 40 },
  ];
  let cells = '';
  let nums = '';
  for (const row of rows) {
    cells += `<text x="0" y="${row.y + row.h / 2 + 4}" class="t-row">${row.label}</text>`;
    for (let i = 0; i < K.DISTANCES.length; i++) {
      const xa = xs(bounds[i]) + 1;
      const xb = xs(bounds[i + 1]) - 1;
      const v = s[row.key][i];
      const fill = row.key === 'low' ? 'var(--muted)' : 'var(--accent)';
      const op = v == null || v < 0.5 ? 0 : 0.08 + 0.62 * (v / 100);
      cells += `<rect x="${xa.toFixed(1)}" y="${row.y}" width="${(xb - xa).toFixed(1)}" height="${row.h}" rx="3" style="fill:${fill};fill-opacity:${op.toFixed(2)};stroke:var(--line)"/>`;
      nums += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${row.y + row.h / 2 + 4}" class="t-cell">${v == null ? '–' : Math.round(v)}</text>`;
    }
  }
  // 햇빛 길: 해에서 낮게 들어와 관측 지점 위 구름에 닿는 빛
  const A = [452, ground - 4];
  const B = [300, ground + 4];
  const C = [x0 + 8, 49];
  const good = P >= 0.55;
  let path = `<path d="M${A} Q${B} ${C}" style="fill:none;stroke:${good ? 'var(--accent)' : 'var(--muted)'}" stroke-width="1.75" stroke-linecap="round"${good ? '' : ' stroke-dasharray="4 4"'}/>`;
  if (!good) {
    const worst = worstBlock(s);
    const tx = xs(K.DISTANCES[worst]);
    const ty = quadAtX(A, B, C, tx);
    path += `<path d="M${tx - 4} ${ty - 4}l8 8m0-8l-8 8" style="stroke:var(--text)" stroke-width="1.75" stroke-linecap="round"/>`;
  }
  let ticks = '';
  K.DISTANCES.forEach((km, i) => {
    ticks += `<text x="${xs(km).toFixed(1)}" y="${ground + 18}" class="t-tick">${km}${i === K.DISTANCES.length - 1 ? 'km' : ''}</text>`;
  });
  $('section').innerHTML = `<svg viewBox="0 0 480 174" role="img" aria-label="해 지는 쪽 450km까지 하층·중층·상층 구름량(%)">
    ${cells}${path}${nums}
    <line x1="0" y1="${ground}" x2="480" y2="${ground}" style="stroke:var(--faint)"/>
    <path d="M452 ${ground}a11 11 0 0 1 22 0z" style="fill:var(--accent)"/>
    <g transform="translate(${x0} ${ground})" style="fill:var(--text)"><circle cy="-13" r="3"/><path d="M-3-8.5h6l-1 8.5h-4z"/></g>
    ${ticks}
  </svg>`;
}

function renderFactors(d) {
  const p = d.res.parts;
  const bars = [
    ['하늘 캔버스', p.C],
    ['햇빛 길', p.P],
    ['서쪽 트임', (p.S + p.Z) / 2],
  ];
  const mods = [
    ['공기', p.fH],
    ['미세먼지', p.fA],
    ['비', p.fR],
  ];
  $('factors').innerHTML =
    bars
      .map(([name, v]) => {
        const n = Math.round(v * 100);
        return `<div class="factor"><span>${name}</span><span class="f-track"><span class="f-fill" style="width:${n}%"></span></span><span class="f-val">${n}</span></div>`;
      })
      .join('') +
    `<div class="mods">${mods.map(([name, f]) => `<span>${name} <b>×${f.toFixed(2)}</b></span>`).join('')}</div>`;
}

function renderRaw(d, m) {
  const s = d.sample;
  const v = (x) => (x == null ? '–' : Math.round(x));
  const rows = K.DISTANCES.map((km, i) => `<tr><td>${km} km</td><td>${v(s.low[i])}</td><td>${v(s.mid[i])}</td><td>${v(s.high[i])}</td></tr>`).join('');
  const obs = [
    ['기준', fmtTime(s.at, m.tz, m.off)],
    ['습도', s.rh == null ? '–' : `${Math.round(s.rh)}%`],
    ['시정', s.vis == null ? '–' : `${(s.vis / 1000).toFixed(1)} km`],
    ['강수', s.precip == null ? '–' : `${s.precip.toFixed(1)} mm/h`],
    ['AOD', s.aod == null ? '–' : s.aod.toFixed(2)],
  ];
  $('raw').innerHTML = `<table><thead><tr><th>거리</th><th>하층 %</th><th>중층 %</th><th>상층 %</th></tr></thead><tbody>${rows}</tbody></table>
    <dl class="obs">${obs.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('')}</dl>`;
}

// 해 쪽(80~450km)에서 빛을 가장 많이 막는 표본 (하층·중층·상층을 함께 봄)
function worstBlock(s) {
  const f = (v) => (v == null ? 0 : v / 100);
  let worst = 2;
  let most = -1;
  for (let i = 2; i < K.DISTANCES.length; i++) {
    const b = 1 - (1 - 0.9 * f(s.low[i])) * (1 - 0.7 * f(s.mid[i])) * (1 - 0.3 * f(s.high[i]));
    if (b > most) {
      most = b;
      worst = i;
    }
  }
  return worst;
}

// 2차 베지어 곡선에서 x 위치의 y (수치로 찾기)
function quadAtX(A, B, C, x) {
  let best = A[1];
  let bestDx = Infinity;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const u = 1 - t;
    const px = u * u * A[0] + 2 * u * t * B[0] + t * t * C[0];
    if (Math.abs(px - x) < bestDx) {
      bestDx = Math.abs(px - x);
      best = u * u * A[1] + 2 * u * t * B[1] + t * t * C[1];
    }
  }
  return best;
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
