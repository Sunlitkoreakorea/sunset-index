import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as K from '../core.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/sunsets.json', import.meta.url), 'utf8'));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (허용 ${tol})`);

/* ---------- 해 지는 시각 ---------- */

test('일몰 시각이 Open-Meteo 기준값과 맞는다 (13개 도시 × 약 360일)', () => {
  let checked = 0;
  for (const p of fx.places) {
    const highLat = Math.abs(p.lat) > 60;
    for (const d of p.days) {
      const ymd = K.localYMD(d.t * 1000 + 6 * 3600e3, p.timezone, d.off);
      const omPolar = d.sunset === d.sunrise ? 'night' : d.sunset - d.sunrise === 86400 ? 'day' : null;
      const ev = K.sunEventTime(ymd, p.lat, p.lon, d.off, 'set');
      if (omPolar || ev.polar) continue; // 극지 경계는 아래 테스트에서
      const tol = highLat ? 300 : 40; // 초
      near(ev.t / 1000, d.sunset, tol, `${p.name} ${ymd.y}-${ymd.m}-${ymd.d}`);
      checked++;
    }
  }
  assert.ok(checked > 4000, `비교한 날 수 ${checked}`);
});

test('백야·극야 판정이 경계 하루 말고는 Open-Meteo와 같다', () => {
  const p = fx.places.find((x) => x.name === '트롬쇠');
  let mismatch = 0;
  let polarDays = 0;
  for (const d of p.days) {
    const ymd = K.localYMD(d.t * 1000 + 6 * 3600e3, p.timezone, d.off);
    const omPolar = d.sunset === d.sunrise ? 'night' : d.sunset - d.sunrise === 86400 ? 'day' : null;
    const ev = K.sunEventTime(ymd, p.lat, p.lon, d.off, 'set');
    if (omPolar) polarDays++;
    if ((ev.polar ?? null) !== omPolar) mismatch++;
  }
  assert.ok(polarDays > 100, `극지 날 수 ${polarDays}`);
  assert.ok(mismatch <= 2, `불일치 ${mismatch}일`);
});

test('시간대 오프셋이 몇 시간 틀려도 같은 날의 일몰을 고른다', () => {
  const ymd = { y: 2026, m: 10, d: 31 };
  const a = K.sunEventTime(ymd, K.MINSAGO.lat, K.MINSAGO.lon, 9 * 3600).t;
  for (const off of [6, 7, 8, 10, 11, 12].map((h) => h * 3600)) {
    near(K.sunEventTime(ymd, K.MINSAGO.lat, K.MINSAGO.lon, off).t, a, 1000, `off ${off}`);
  }
  // 2026-10-31 민사고 일몰은 17:31 KST 무렵 (Open-Meteo 1793435462)
  near(a / 1000, 1793435462, 40);
});

test('일몰 방위각: 춘분 무렵 정서쪽, 하지·동지는 독립 공식과 맞는다', () => {
  // 춘분(2026-03-20): 적위≈0 → 굴절 때문에 270°보다 아주 조금 북쪽
  const eq = K.sunEventTime({ y: 2026, m: 3, d: 20 }, 37.4592, 128.1436, 32400);
  assert.ok(eq.az > 269.5 && eq.az < 271.5, `춘분 ${eq.az}`);
  // cos A = (sinδ − sinφ·sin h) / (cosφ·cos h), h = −0.833°
  const expectAz = (decl, lat) => {
    const r = Math.PI / 180;
    const h = -0.833 * r;
    const c = (Math.sin(decl * r) - Math.sin(lat * r) * Math.sin(h)) / (Math.cos(lat * r) * Math.cos(h));
    return 360 - Math.acos(c) / r;
  };
  const jun = K.sunEventTime({ y: 2026, m: 6, d: 21 }, 37.4592, 128.1436, 32400);
  near(jun.az, expectAz(23.435, 37.4592), 0.3, '하지 민사고');
  const dec = K.sunEventTime({ y: 2025, m: 12, d: 21 }, 37.4592, 128.1436, 32400);
  near(dec.az, expectAz(-23.435, 37.4592), 0.3, '동지 민사고');
  const syd = K.sunEventTime({ y: 2025, m: 12, d: 21 }, -33.8688, 151.2093, 39600);
  near(syd.az, expectAz(-23.435, -33.8688), 0.3, '동지 시드니');
  assert.ok(syd.az > 235 && syd.az < 245, '시드니 12월 일몰은 남서쪽');
});

test('노을 끝(-4°)은 일몰보다 뒤, 해돋이는 앞', () => {
  const ymd = { y: 2026, m: 10, d: 31 };
  const set = K.sunEventTime(ymd, 37.4592, 128.1436, 32400).t;
  const end = K.sunEventTime(ymd, 37.4592, 128.1436, 32400, 'set', -4).t;
  const rise = K.sunEventTime(ymd, 37.4592, 128.1436, 32400, 'rise').t;
  assert.ok(end - set > 10 * 60000 && end - set < 30 * 60000, `${(end - set) / 60000}분`);
  assert.ok(rise < set && set - rise > 9 * 3600e3);
  // 고도 함수와도 일치: 일몰 시각의 고도 ≈ -0.833°
  near(K.sunPosition(set, 37.4592, 128.1436).alt, -0.833, 0.05);
  near(K.sunPosition(end, 37.4592, 128.1436).alt, -4, 0.05);
});

/* ---------- 거리 계산 ---------- */

test('destination: 적도 동쪽 1° 이동, 날짜변경선 넘기, 왕복 거리', () => {
  const e = K.destination(0, 0, 90, (Math.PI / 180) * 6371.0088);
  near(e.lat, 0, 1e-9);
  near(e.lon, 1, 1e-9);
  const w = K.destination(0, 179.5, 90, 111.2);
  assert.ok(w.lon < -179 && w.lon > -180, `날짜변경선 ${w.lon}`);
  for (const km of K.DISTANCES) {
    const p = K.destination(K.MINSAGO.lat, K.MINSAGO.lon, 250, km);
    near(K.haversine(K.MINSAGO.lat, K.MINSAGO.lon, p.lat, p.lon), km, 0.001, `${km}km`);
  }
  const west = K.destination(K.MINSAGO.lat, K.MINSAGO.lon, 270, 100);
  // 정서쪽으로 출발한 대권은 위도선보다 적도 쪽(남쪽)으로 휜다: sin(lat2) = sin(lat1)·cos(d)
  assert.ok(west.lon < K.MINSAGO.lon && west.lat < K.MINSAGO.lat, '정서쪽 대권은 살짝 남쪽으로 휜다');
  near(Math.sin(west.lat * Math.PI / 180), Math.sin(K.MINSAGO.lat * Math.PI / 180) * Math.cos(100 / 6371.0088), 1e-12);
});

/* ---------- 보간·날짜 ---------- */

test('interpAt: 정확한 시각, 사이, 빈 값, 범위 밖', () => {
  const t = [0, 3600, 7200];
  assert.equal(K.interpAt(t, [10, 20, 30], 0), 10);
  assert.equal(K.interpAt(t, [10, 20, 30], 7200), 30);
  near(K.interpAt(t, [10, 20, 30], 1800), 15, 1e-9);
  near(K.interpAt(t, [10, 20, 30], 5400), 25, 1e-9);
  assert.equal(K.interpAt(t, [10, null, 30], 1800), 10);
  assert.equal(K.interpAt(t, [null, 20, 30], 1800), 20);
  assert.equal(K.interpAt(t, [null, null, 30], 1800), null);
  assert.equal(K.interpAt(t, [10, 20, 30], -1), null);
  assert.equal(K.interpAt(t, [10, 20, 30], 7201), null);
  assert.equal(K.interpAt([], [], 0), null);
  assert.equal(K.interpAt([5], [7], 5), 7);
  assert.equal(K.interpAt(t, [10, NaN, 30], 3600), 30);
});

test('localYMD·addDays·weekdayKo', () => {
  assert.deepEqual(K.localYMD(Date.UTC(2026, 9, 31, 15, 30), 'Asia/Seoul'), { y: 2026, m: 11, d: 1 });
  assert.deepEqual(K.localYMD(Date.UTC(2026, 9, 31, 14, 30), 'Asia/Seoul'), { y: 2026, m: 10, d: 31 });
  // 뉴욕 서머타임 끝나는 날(11/1) 새벽
  assert.deepEqual(K.localYMD(Date.UTC(2026, 10, 1, 4, 30), 'America/New_York'), { y: 2026, m: 11, d: 1 });
  // 이름이 틀리면 고정 오프셋으로
  assert.deepEqual(K.localYMD(Date.UTC(2026, 9, 31, 15, 30), 'Not/AZone', 32400), { y: 2026, m: 11, d: 1 });
  assert.deepEqual(K.localYMD(Date.UTC(2026, 9, 31, 15, 30), null, 32400), { y: 2026, m: 11, d: 1 });
  assert.deepEqual(K.addDays({ y: 2026, m: 12, d: 30 }, 3), { y: 2027, m: 1, d: 2 });
  assert.deepEqual(K.addDays({ y: 2028, m: 2, d: 28 }, 1), { y: 2028, m: 2, d: 29 });
  assert.equal(K.weekdayKo({ y: 2026, m: 10, d: 31 }), '토');
  assert.equal(K.weekdayKo({ y: 2026, m: 11, d: 1 }), '일');
});

test('compassKo', () => {
  assert.equal(K.compassKo(270), '서');
  assert.equal(K.compassKo(247.5), '서남서');
  assert.equal(K.compassKo(359), '북');
  assert.equal(K.compassKo(11.2), '북');
  assert.equal(K.compassKo(11.3), '북북동');
  assert.equal(K.compassKo(-90), '서');
});

/* ---------- 점수 ---------- */

const fill = (v) => K.DISTANCES.map(() => v);
const base = { rh: 50, vis: 50000, precip: 0, aod: null };

test('대표 상황 점수', () => {
  const clear = K.scoreSunset({ ...base, low: fill(0), mid: fill(0), high: fill(0) });
  assert.equal(clear.score, 25);
  assert.equal(clear.grade.label, '보통');
  near(clear.parts.P, 1, 1e-9, '맑은 하늘 빛길');

  // 머리 위(0~150km)에 구름, 해 쪽은 맑음 = 교과서적인 좋은 노을
  const ideal = K.scoreSunset({ ...base, low: fill(0), mid: [50, 50, 50, 50, 0, 0, 0], high: fill(0) });
  assert.ok(ideal.score >= 80, `이상적 ${ideal.score}`);
  const idealHigh = K.scoreSunset({ ...base, low: fill(0), mid: fill(0), high: [50, 50, 50, 50, 0, 0, 0] });
  assert.ok(idealHigh.score >= 80, `이상적(상층) ${idealHigh.score}`);

  // 머리 위가 꽉 차도 해 쪽이 트여 있으면 하늘 전체가 물들 수 있음
  const fireSky = K.scoreSunset({ ...base, low: fill(0), mid: [100, 100, 100, 80, 0, 0, 0], high: fill(0) });
  assert.ok(fireSky.score >= 65, `머리 위 꽉 + 해 쪽 트임 ${fireSky.score}`);

  // 2026-11-04형: 머리 위 구름은 좋은데 해 쪽 350~450km에 중층 구름 띠 → 빛이 못 들어옴
  const farDeck = K.scoreSunset({ ...base, low: fill(0), mid: [50, 50, 50, 50, 30, 80, 100], high: fill(0) });
  assert.ok(farDeck.score <= 40 && farDeck.score < ideal.score - 40, `먼 구름 띠 ${farDeck.score}`);
  assert.match(K.explain(farDeck), /막혀|가려/);

  const midOvercast = K.scoreSunset({ ...base, low: fill(0), mid: fill(100), high: fill(0) });
  assert.ok(midOvercast.score <= 20, `중층 꽉 ${midOvercast.score}`);

  const overcastLow = K.scoreSunset({ ...base, low: fill(100), mid: fill(50), high: fill(50) });
  assert.equal(overcastLow.score, 0);

  // 머리 위엔 높은 구름, 해 쪽은 낮은 구름으로 막힘
  const blocked = K.scoreSunset({ ...base, low: [0, 0, 50, 100, 100, 100, 100], mid: fill(50), high: fill(30) });
  assert.ok(blocked.score < 20, `막힘 ${blocked.score}`);
  assert.match(K.explain(blocked), /막혀|가려/);

  const rainy = K.scoreSunset({ ...base, precip: 2, low: fill(0), mid: [50, 50, 50, 50, 0, 0, 0], high: fill(0) });
  assert.ok(rainy.score < ideal.score * 0.4, `비 ${rainy.score}`);
  assert.match(K.explain(rainy), /비/);
});

test('2026-11-04 민사고 실제 예보값: 예전 공식 83점 → 새 공식은 보통 이하', () => {
  // 해 진 뒤 10분 예보 (해 쪽 350~450km 서해 위에 중·상층 구름 띠, 근처 공항은 5km 높이 중층 BKN 관측)
  const s = {
    low: fill(0), mid: [8, 15, 16, 18, 32, 63, 96], high: [20, 25, 26, 30, 37, 41, 90],
    rh: 68, vis: 39700, precip: 0, aod: 0.22,
  };
  const r = K.scoreSunset(s);
  assert.ok(r.score < 40, `11/4 ${r.score}`);
  assert.ok(r.parts.P < 0.4, `빛길 ${r.parts.P}`);
});

test('광선 추적: 맑으면 1, 지구 그림자, 구름이 늘면 줄어듦', () => {
  const zero = [fill(0), fill(0), fill(0)];
  near(K.canvasLight(zero, 0, 3.5), 1, 1e-9);
  near(K.canvasLight(zero, 150, 8), 1, 1e-9);
  // 3.5km 높이 구름은 해가 2.5° 아래면 지구 그림자에 들어감 (√(2h/R) ≈ 1.9°)
  assert.equal(K.rayTransmission(null, 0, 3.5, 2.5), 0);
  assert.ok(K.rayTransmission(null, 0, 8, 2.5) > 0);
  // 같은 빛줄기에서 먼 중층 구름이 늘면 투과율이 줄어든다
  const t1 = K.rayTransmission([fill(0), [0, 0, 0, 0, 0, 0.3, 0.3], fill(0)], 0, 3.5, 1.5);
  const t2 = K.rayTransmission([fill(0), [0, 0, 0, 0, 0, 0.9, 0.9], fill(0)], 0, 3.5, 1.5);
  assert.ok(t2 < t1 && t1 < 1, `${t1} ${t2}`);
  // 범위를 벗어난 값이 들어와도 0~1을 지킨다
  const t3 = K.rayTransmission([fill(0), [0, 0, 0, 0, 0, 30, 30], fill(0)], 0, 3.5, 1.5);
  assert.ok(t3 >= 0 && t3 <= 1, `${t3}`);
});

test('자료가 비면 판단을 보류하거나 남은 자료로 계산한다', () => {
  const noObs = K.scoreSunset({ ...base, low: [null, null, 0, 0, 0, 0, 0], mid: fill(40), high: fill(0) });
  assert.equal(noObs.score, null);
  assert.ok(K.explain(noObs).length > 0);
  const oneFarMissing = K.scoreSunset({ ...base, low: [0, 0, 0, 0, 0, 0, null], mid: fill(40), high: fill(0) });
  assert.ok(Number.isInteger(oneFarMissing.score));
  const empty = K.scoreSunset({});
  assert.equal(empty.score, null);
});

// 작은 결정론적 난수 (재현 가능)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('무작위 10,000건: 점수는 늘 0~100 정수이거나 null, NaN 없음', () => {
  const r = rng(42);
  const maybe = (v) => (r() < 0.05 ? null : v);
  for (let n = 0; n < 10000; n++) {
    const arr = () => K.DISTANCES.map(() => maybe(r() * 100));
    const res = K.scoreSunset({
      low: arr(), mid: arr(), high: arr(),
      rh: maybe(r() * 100), vis: maybe(r() * 60000), precip: maybe(r() < 0.8 ? 0 : r() * 5), aod: maybe(r() * 2),
    });
    if (res.score == null) continue;
    assert.ok(Number.isInteger(res.score) && res.score >= 0 && res.score <= 100, `점수 ${res.score}`);
    for (const [k, v] of Object.entries(res.parts)) assert.ok(Number.isFinite(v), `${k}=${v}`);
    assert.ok(typeof K.explain(res) === 'string' && K.explain(res).length > 5);
  }
});

test('낮은 구름·비·뿌연 공기가 늘면 점수는 절대 오르지 않는다', () => {
  const r = rng(7);
  for (let n = 0; n < 3000; n++) {
    const s = {
      low: K.DISTANCES.map(() => r() * 100),
      mid: K.DISTANCES.map(() => r() * 100),
      high: K.DISTANCES.map(() => r() * 100),
      rh: r() * 100, vis: r() * 50000, precip: r() < 0.7 ? 0 : r() * 3, aod: r() * 1.2,
    };
    const before = K.scoreSunset(s).raw;
    const i = Math.floor(r() * K.DISTANCES.length);
    const more = { ...s, low: s.low.map((v, j) => (j === i ? Math.min(100, v + 20) : v)) };
    assert.ok(K.scoreSunset(more).raw <= before + 1e-9, `저층 ${i}`);
    assert.ok(K.scoreSunset({ ...s, precip: s.precip + 0.5 }).raw <= before + 1e-9, '비');
    assert.ok(K.scoreSunset({ ...s, vis: s.vis * 0.5 }).raw <= before + 1e-9, '시정');
    assert.ok(K.scoreSunset({ ...s, rh: Math.min(100, s.rh + 10) }).raw <= before + 1e-9, '습도');
    // 캔버스 밖(350·450km) 해 쪽 중·상층 구름이 늘어도 점수는 오르지 않는다
    const j = 5 + Math.floor(r() * 2);
    const key = r() < 0.5 ? 'mid' : 'high';
    const far = { ...s, [key]: s[key].map((v, k) => (k === j ? Math.min(100, v + 25) : v)) };
    assert.ok(K.scoreSunset(far).raw <= before + 1e-9, `먼 ${key} ${j}`);
  }
});

test('보정 함수들이 경계에서 끊기지 않고 범위 안에 있다', () => {
  for (const x of [0.05, 0.4, 0.75]) near(K.canvasCurve(x - 1e-9), K.canvasCurve(x + 1e-9), 1e-6, `canvas ${x}`);
  near(K.canvasCurve(1), 0.8, 1e-9);
  assert.equal(K.canvasCurve(0), 0);
  for (let a = 0; a <= 2; a += 0.01) {
    const f = K.aerosolFactor(a);
    assert.ok(f >= 0.7 && f <= 1.05, `aod ${a} → ${f}`);
    near(f, K.aerosolFactor(a + 1e-9), 1e-6, `aod 연속 ${a}`);
  }
  for (const v of [2000, 30000]) near(K.hazeFactor(null, v - 1e-6), K.hazeFactor(null, v + 1e-6), 1e-6, `vis ${v}`);
  for (const h of [65, 98]) near(K.hazeFactor(h - 1e-9, null), K.hazeFactor(h + 1e-9, null), 1e-6, `rh ${h}`);
  for (const p of [0.1, 1]) near(K.rainFactor(p - 1e-9), K.rainFactor(p + 1e-9), 1e-6, `rain ${p}`);
  assert.equal(K.hazeFactor(null, null), 1);
  assert.ok(K.hazeFactor(100, 100) >= 0.4);
});

test('등급 구간', () => {
  assert.equal(K.grade(0).label, '나쁨');
  assert.equal(K.grade(19).label, '나쁨');
  assert.equal(K.grade(20).label, '보통');
  assert.equal(K.grade(40).label, '좋음');
  assert.equal(K.grade(60).label, '매우 좋음');
  assert.equal(K.grade(80).label, '장관');
  assert.equal(K.grade(100).label, '장관');
  assert.equal(K.grade(null), null);
  assert.equal(K.reliability(0).label, '높음');
  assert.equal(K.reliability(3).label, '보통');
  assert.equal(K.reliability(6).label, '낮음');
});
