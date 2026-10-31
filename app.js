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

/* ---------------- 시작 ---------------- */

bind();
start();

function start() {
  const q = new URLSearchParams(location.search);
  const la = parseFloat(q.get('lat'));
  const lo = parseFloat(q.get('lon'));
  if (validLL(la, lo)) {
    const name = (q.get('name') || '').trim().slice(0, 40) || '지정한 위치';
    setLoc({ kind: 'custom', name, lat: la, lon: lo }, { persist: false });
    return;
  }
  const saved = readSaved();
  if (saved) {
    setLoc(saved, { persist: false }); // 지난번 내 위치로 먼저 보여 주고
    locate({ quiet: true }); // GPS로 새 위치를 다시 잡는다
    return;
  }
  setLoc({ ...K.MINSAGO }, { persist: false });
}

function bind() {
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      if (b.dataset.loc === 'gps') locate({ quiet: false });
      else {
        state.locating = false;
        setLoc({ ...K.MINSAGO });
      }
    });
  }
  $('refresh').addEventListener('click', () => load({ keepSel: true }));
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.model && Date.now() - state.model.fetchedAt > STALE_MS) load({ keepSel: true });
  });
}

/* ---------------- 위치 ---------------- */

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
    if (!quiet) toast('이 브라우저는 위치 기능을 지원하지 않아요.');
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
      const why = err && err.code === 1 ? '위치 권한이 꺼져 있어요.' : '위치를 찾지 못했어요.';
      if (state.loc?.kind === 'gps') toast(`${why} 지난번 위치로 보여 줄게요.`);
      else if (!quiet) toast(`${why} 민사고 기준으로 계속 보여 줄게요.`);
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
    if (!r.ok || (j && j.error)) throw new Error((j && j.reason) || `서버 응답 ${r.status}`);
    if (j == null) throw new Error('빈 응답을 받았어요');
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('예보 서버 응답이 너무 늦어요');
    if (e instanceof TypeError) throw new Error('인터넷 연결을 확인해 주세요');
    throw e;
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
    hourly: 'aerosol_optical_depth,pm2_5',
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '7',
  })}`;

  const [fcR, aqR] = await Promise.allSettled([getJSON(fcUrl), getJSON(aqUrl)]);
  if (fcR.status === 'rejected') throw fcR.reason;
  const arr = Array.isArray(fcR.value) ? fcR.value : [fcR.value];
  if (arr.length !== pts.length || !arr.every((a) => Array.isArray(a?.hourly?.time))) {
    throw new Error('예보 응답 모양이 예상과 달라요');
  }
  const obs = arr[0];
  const aq = aqR.status === 'fulfilled' && Array.isArray(aqR.value?.hourly?.time) ? aqR.value : null;
  const tz = obs.timezone;
  const off = Number.isFinite(obs.utc_offset_seconds) ? obs.utc_offset_seconds : approxOff;
  const today = K.localYMD(now, tz, off);

  const days = [];
  for (let k = 0; k < DAYS; k++) {
    const ymd = K.addDays(today, k);
    const base = { idx: k, ymd, wd: K.weekdayKo(ymd), rel: K.reliability(k) };
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
      pm25: aq ? at(aq, 'pm2_5') : null,
      at: tS * 1000,
    };
    const end = K.sunEventTime(ymd, loc.lat, loc.lon, off, 'set', -4);
    days.push({
      ...base,
      sunset: ev.t,
      az: ev.az,
      glowStart: ev.t - 5 * 60000,
      glowEnd: end.t ?? null,
      sample,
      res: K.scoreSunset(sample),
    });
  }
  return { loc, pts, az, tz, off, days, aqOk: !!aq, fetchedAt: now, gridElev: obs.elevation };
}

async function load({ keepSel }) {
  const my = ++state.req;
  if (!keepSel) state.sel = 0;
  setBusy(true);
  if (!state.model || state.model.loc !== state.loc) renderLoading();
  try {
    const model = await fetchModel(state.loc);
    if (my !== state.req) return;
    state.model = model;
    state.sel = Math.min(state.sel, model.days.length - 1);
    render();
  } catch (e) {
    if (my !== state.req) return;
    console.error(e);
    renderError(e);
  } finally {
    if (my === state.req) setBusy(false);
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
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}`);
const gradeColor = (g) => (g ? `var(--c-${g.key})` : 'var(--faint)');

function fmtTime(ms, tz, off) {
  if (ms == null) return '–';
  ms = Math.round(ms / 60000) * 60000; // 초는 반올림 (17:30:59 → 17:31)
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  } catch {
    const d = new Date(ms + (off || 0) * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}

function fmtCoord(lat, lon) {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
}

function dayName(d) {
  return ['오늘', '내일', '모레'][d.idx] ?? `${d.wd}요일`;
}

function shortName(d) {
  return ['오늘', '내일', '모레'][d.idx] ?? d.wd;
}

function renderLoc() {
  const loc = state.loc;
  for (const b of document.querySelectorAll('.seg-btn')) {
    const on = loc && b.dataset.loc === loc.kind;
    b.setAttribute('aria-pressed', String(!!on));
    if (b.dataset.loc === 'gps') {
      b.classList.toggle('busy', state.locating);
      b.setAttribute('aria-busy', String(state.locating));
    }
  }
  let text = '';
  if (!loc) text = '';
  else if (loc.kind === 'minsago') text = K.MINSAGO.full;
  else text = `${loc.name} · ${fmtCoord(loc.lat, loc.lon)}`;
  if (state.locating) text += ' · 위치 찾는 중…';
  $('locText').textContent = text;
}

function setBusy(on) {
  $('refresh').classList.toggle('spin', on);
  $('refresh').disabled = on;
  if (on) $('updText').textContent = '불러오는 중…';
}

function renderLoading() {
  $('days').innerHTML = '';
  $('hero').innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span>예보 불러오는 중…</div>';
  for (const id of ['sectionCard', 'factorCard', 'rawCard']) $(id).hidden = true;
}

function renderError(e) {
  $('updText').textContent = '불러오기 실패';
  $('hero').innerHTML = `<div class="err"><p>예보를 불러오지 못했어요. ${esc(e?.message || '')}</p><button type="button" class="btn" id="retry">다시 시도</button></div>`;
  $('retry').addEventListener('click', () => load({ keepSel: true }));
  if (!state.model || state.model.loc !== state.loc) {
    $('days').innerHTML = '';
    for (const id of ['sectionCard', 'factorCard', 'rawCard']) $(id).hidden = true;
  }
}

function render() {
  const m = state.model;
  if (!m) return;
  $('updText').textContent = `${fmtTime(m.fetchedAt)} 업데이트`;
  renderDays(m);
  const day = m.days[state.sel];
  renderHero(day, m);
  const ok = !day.polar && day.res?.score != null;
  $('sectionCard').hidden = !ok;
  $('factorCard').hidden = !ok;
  $('rawCard').hidden = day.polar != null;
  if (ok) {
    renderSection(day, m);
    renderFactors(day, m);
  }
  if (!day.polar) renderRaw(day, m);
}

function renderDays(m) {
  $('days').innerHTML = m.days
    .map((d) => {
      const s = d.res?.score;
      const g = d.res?.grade;
      const on = d.idx === state.sel;
      const label = s == null ? '–' : s;
      const aria = `${dayName(d)} ${d.ymd.m}월 ${d.ymd.d}일, ${s == null ? '점수 없음' : `${s}점 ${g.label}`}`;
      return `<button type="button" class="day" data-i="${d.idx}" aria-pressed="${on}" aria-label="${esc(aria)}" tabindex="${on ? 0 : -1}">
        <span class="d-name">${shortName(d)}</span>
        <span class="d-date">${d.ymd.m}/${d.ymd.d}</span>
        <span class="d-score" style="color:${gradeColor(g)}">${label}</span>
        <span class="d-bar" style="background:${gradeColor(g)};opacity:${s == null ? 0.25 : 0.9}"></span>
      </button>`;
    })
    .join('');
}

function renderHero(d, m) {
  const near3 = ['오늘', '내일', '모레'][d.idx];
  const head = `${near3 ? `${near3} · ` : ''}${d.ymd.m}월 ${d.ymd.d}일 (${d.wd})`;
  if (d.polar) {
    const msg = d.polar === 'day' ? '이 날은 해가 지지 않아요 (백야).' : '이 날은 해가 뜨지 않아요 (극야).';
    $('hero').innerHTML = `<div class="polar"><b>${esc(head)}</b><br>${msg}</div>`;
    return;
  }
  const r = d.res;
  const score = r.score;
  const g = r.grade;
  const C = 2 * Math.PI * 54;
  const off = score == null ? C : C * (1 - score / 100);
  const passed = d.idx === 0 && Date.now() > (d.glowEnd ?? d.sunset + 20 * 60000);
  const facts = [
    `일몰 <b>${fmtTime(d.sunset, m.tz, m.off)}</b>`,
    `방향 <b>${K.compassKo(d.az)} ${Math.round(d.az)}°</b>`,
    d.glowEnd ? `물드는 때 <b>${fmtTime(d.glowStart, m.tz, m.off)}~${fmtTime(d.glowEnd, m.tz, m.off)}</b>` : '',
    `예보 신뢰도 <b>${d.rel.label}</b>`,
  ].filter(Boolean);
  $('hero').innerHTML = `
    <div class="ring" role="img" aria-label="노을 지수 ${score ?? '없음'}점">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="track" cx="60" cy="60" r="54" fill="none" stroke-width="10"/>
        <circle class="val" cx="60" cy="60" r="54" fill="none" stroke-width="10" stroke-linecap="round"
          stroke="${gradeColor(g)}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
      </svg>
      <div class="num"><div>${score ?? '–'}<small>/ 100</small></div></div>
    </div>
    <div class="h-body">
      <p class="h-grade" style="color:${gradeColor(g)}">${g ? g.label : '판단 보류'}${passed ? '<span class="badge">오늘 노을은 지났어요</span>' : ''}</p>
      <p class="h-date">${esc(head)}</p>
      <p class="h-sum">${esc(K.explain(r))}</p>
      <ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>
    </div>`;
}

// 구름 단면도: 왼쪽이 관측 지점, 오른쪽이 해 지는 쪽
function renderSection(d, m) {
  const s = d.sample;
  const P = d.res.parts.P;
  const x0 = 60;
  const x1 = 440;
  const maxD = 500;
  const xs = (km) => x0 + (x1 - x0) * Math.sqrt(km / maxD);
  const bounds = [0, 15, 55, 115, 200, 300, 400, 500];
  const ground = 164;
  const rows = [
    { key: 'high', label: '상층', y: 14, h: 44 },
    { key: 'mid', label: '중층', y: 62, h: 50 },
    { key: 'low', label: '하층', y: 116, h: 44 },
  ];
  const lit = mix('#bdb6cf', '#ffae78', clampUnit((P - 0.25) / 0.6));
  let svg = '';
  let labels = ''; // 칸 숫자는 빛줄기 선 위에 그린다
  for (const row of rows) {
    svg += `<text x="4" y="${row.y + row.h / 2 + 5}" class="t-row">${row.label}</text>`;
    for (let i = 0; i < K.DISTANCES.length; i++) {
      const xa = xs(bounds[i]);
      const xb = xs(bounds[i + 1]);
      const v = s[row.key][i];
      const fill = row.key === 'low' ? '#c7ccd8' : lit;
      const op = v == null ? 0 : v <= 0.5 ? 0 : 0.14 + 0.8 * (v / 100);
      svg += `<rect x="${(xa + 1).toFixed(1)}" y="${row.y}" width="${(xb - xa - 2).toFixed(1)}" height="${row.h}" rx="6"
        fill="${fill}" fill-opacity="${op.toFixed(2)}" stroke="rgba(255,255,255,.10)"${v == null ? ' stroke-dasharray="3 3"' : ''}>
        <title>${row.label} ${K.DISTANCES[i]}km: ${v == null ? '자료 없음' : `${Math.round(v)}%`}</title></rect>`;
      const txt = v == null ? '?' : `${Math.round(v)}`;
      const dark = v != null && v >= 55;
      labels += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${row.y + row.h / 2 + 4.5}" class="t-cell${dark ? ' dark' : ''}">${txt}</text>`;
    }
  }
  // 햇빛 길: 해에서 낮게 들어와 관측 지점 위 구름(상층·중층 사이)에 닿는 빛
  const A = [454, ground - 5];
  const B = [300, ground + 4];
  const Cp = [x0 + 8, 60];
  const good = P >= 0.55;
  svg += `<path d="M${A} Q${B} ${Cp}" fill="none" stroke="${good ? '#ffae78' : '#8f88a3'}" stroke-width="2.5"
    stroke-linecap="round" ${good ? '' : 'stroke-dasharray="5 5"'} opacity=".95"/>`;
  if (!good) {
    // 가장 많이 막힌 곳에 × 표시
    let worst = 2;
    for (let i = 3; i < K.DISTANCES.length; i++) if ((s.low[i] ?? -1) > (s.low[worst] ?? -1)) worst = i;
    const tx = xs(K.DISTANCES[worst]);
    const pt = quadAtX(A, B, Cp, tx);
    svg += `<g transform="translate(${tx.toFixed(1)} ${pt.toFixed(1)})"><circle r="9" fill="#2a2040" stroke="#ff8f80" stroke-width="2"/>
      <path d="M-4-4L4 4M4-4L-4 4" stroke="#ff8f80" stroke-width="2.2" stroke-linecap="round"/></g>`;
  }
  svg += labels;
  // 땅, 해, 관측자
  svg += `<line x1="0" y1="${ground}" x2="480" y2="${ground}" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>`;
  svg += `<path d="M450 ${ground} a13 13 0 0 1 26 0z" fill="url(#sunG)"/>`;
  svg += `<g transform="translate(${x0} ${ground})" fill="#f4eee8"><circle cy="-15" r="3.6"/><path d="M-3.4-10h6.8l-1 10h-4.8z"/></g>`;
  // 거리 눈금
  K.DISTANCES.forEach((km, i) => {
    const x = xs(km);
    svg += `<line x1="${x.toFixed(1)}" y1="${ground}" x2="${x.toFixed(1)}" y2="${ground + 4}" stroke="rgba(255,255,255,.35)"/>`;
    svg += `<text x="${x.toFixed(1)}" y="${ground + 17}" class="t-tick">${km}${i === K.DISTANCES.length - 1 ? 'km' : ''}</text>`;
  });
  $('section').innerHTML = `
    <svg viewBox="0 0 480 186" role="img" aria-label="해 지는 쪽 0~450km 구간의 하층·중층·상층 구름량">
      <defs><radialGradient id="sunG" cx="50%" cy="100%" r="100%"><stop offset="0" stop-color="#ffe2a0"/><stop offset=".6" stop-color="#ff9a5a"/><stop offset="1" stop-color="#f2674a"/></radialGradient></defs>
      <style>
        .t-row{font-size:13px;font-weight:600;fill:#b3aac3}
        .t-cell{font-size:12px;font-weight:700;fill:#f4eee8;text-anchor:middle;paint-order:stroke;stroke:#231d3d;stroke-width:3.5px;stroke-linejoin:round}
        .t-cell.dark{fill:#1b1730;stroke:#f1d9cc}
        .t-tick{font-size:11px;font-weight:500;fill:#9b93ad;text-anchor:middle}
      </style>
      ${svg}
    </svg>
    <div class="legend">
      <span><i style="background:#c7ccd8"></i>낮은 구름 (빛을 막음)</span>
      <span><i style="background:${lit}"></i>높은 구름 (물드는 캔버스)</span>
      <span><i style="background:${good ? '#ffae78' : '#8f88a3'};height:3px;vertical-align:3px"></i>햇빛 길${good ? '' : ' (막힘)'}</span>
      <span>칸 숫자 = 구름량 %</span>
    </div>`;
  $('sectionSub').textContent = `오늘 일몰 방향(${K.compassKo(m.az)} ${Math.round(m.az)}°)으로 450km까지 · 해 진 뒤 10분(${fmtTime(d.sample.at, m.tz, m.off)}) 예보`;
}

function renderFactors(d, m) {
  const p = d.res.parts;
  const s = d.sample;
  const bars = [
    { name: '하늘 캔버스', v: p.C, note: `중·상층 구름 ${pct(p.U)}% — 35~75%일 때 가장 좋아요` },
    { name: '햇빛 길', v: p.P, note: `해 쪽 80~450km 낮은 구름 평균 ${pct(p.Lpath)}%` },
    { name: '서쪽 트임', v: (p.S + p.Z) / 2, note: `머리 위 낮은 구름 ${pct(p.Lup)}% · 서쪽 지평선 쪽 ${pct(p.Lhz)}%` },
  ];
  const barColor = (v) => (v >= 0.66 ? 'var(--c-good)' : v >= 0.33 ? 'var(--c-fair)' : 'var(--c-poor)');
  let html = bars
    .map(
      (b) => `<div class="factor">
        <span class="f-name">${b.name}</span>
        <span class="f-track"><span class="f-fill" style="width:${Math.round(b.v * 100)}%;background:${barColor(b.v)}"></span></span>
        <span class="f-val">${Math.round(b.v * 100)}</span>
        <p class="f-note">${b.note}</p>
      </div>`,
    )
    .join('');
  const visKm = s.vis == null ? null : s.vis / 1000;
  const air = [s.rh == null ? null : `습도 ${Math.round(s.rh)}%`, visKm == null ? null : `시정 ${visKm >= 10 ? Math.round(visKm) : visKm.toFixed(1)}km`]
    .filter(Boolean)
    .join(' · ');
  const dust = s.aod == null
    ? (m.aqOk ? '이 날 대기질 예보 없음' : '대기질 자료를 못 받음')
    : `AOD ${s.aod.toFixed(2)}${s.pm25 == null ? '' : ` · 초미세먼지 ${Math.round(s.pm25)}㎍/㎥`}`;
  const mods = [
    { name: '공기', f: p.fH, note: air || '자료 없음' },
    { name: '미세먼지', f: p.fA, note: dust },
    { name: '비', f: p.fR, note: s.precip == null ? '자료 없음' : `${s.precip.toFixed(1)}mm/h` },
  ];
  html += `<div class="mods">${mods
    .map((x) => {
      const cls = x.f >= 1.02 ? 'up' : x.f <= 0.98 ? 'down' : '';
      return `<span class="mod ${cls}">${x.name} <b>×${x.f.toFixed(2)}</b> · ${esc(x.note)}</span>`;
    })
    .join('')}</div>`;
  $('factors').innerHTML = html;
}

function renderRaw(d, m) {
  const s = d.sample;
  const v = (x) => (x == null ? '–' : Math.round(x));
  const rows = m.pts
    .map(
      (p, i) => `<tr><td>${K.DISTANCES[i]}km</td><td>${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</td>
      <td>${v(s.low[i])}</td><td>${v(s.mid[i])}</td><td>${v(s.high[i])}</td></tr>`,
    )
    .join('');
  const obs = [
    `기준 시각 ${fmtTime(s.at, m.tz, m.off)}`,
    `습도 ${v(s.rh)}%`,
    `시정 ${s.vis == null ? '–' : (s.vis / 1000).toFixed(1)}km`,
    `강수 ${s.precip == null ? '–' : s.precip.toFixed(1)}mm/h`,
    `AOD ${s.aod == null ? '–' : s.aod.toFixed(2)}`,
    `PM2.5 ${v(s.pm25)}㎍/㎥`,
    m.gridElev != null ? `예보 격자 해발 ${Math.round(m.gridElev)}m` : '',
  ].filter(Boolean);
  $('raw').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>해 쪽 거리</th><th>위도, 경도</th><th>하층%</th><th>중층%</th><th>상층%</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="raw-obs">관측 지점: ${obs.map(esc).join(' · ')}</p>`;
}

/* ---------------- 작은 도우미 ---------------- */

function clampUnit(v) {
  return Math.min(1, Math.max(0, v));
}

function mix(a, b, t) {
  const h = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(a);
  const [r2, g2, b2] = h(b);
  const f = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}

// 2차 베지어 곡선에서 x 위치의 y (수치로 찾기)
function quadAtX(A, B, C, x) {
  let best = A[1];
  let bestDx = Infinity;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const u = 1 - t;
    const px = u * u * A[0] + 2 * u * t * B[0] + t * t * C[0];
    const py = u * u * A[1] + 2 * u * t * B[1] + t * t * C[1];
    if (Math.abs(px - x) < bestDx) {
      bestDx = Math.abs(px - x);
      best = py;
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
  }, 4000);
}

// 콘솔에서 확인용
window.__noeul = { state, K, load, select, setLoc };
