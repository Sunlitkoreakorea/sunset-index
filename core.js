// 노을 지수 계산 — 태양 위치, 거리 계산, 점수 공식 (브라우저·Node 공용, 외부 라이브러리 없음)

export const MINSAGO = {
  kind: 'minsago',
  name: '민사고',
  full: '민족사관고등학교 (강원 횡성)',
  lat: 37.4592,
  lon: 128.1436,
};

// 해 지는 방향으로 표본을 뽑는 거리(km). 0은 관측 지점.
export const DISTANCES = [0, 30, 80, 150, 250, 350, 450];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const R_EARTH = 6371.0088; // km
const DAY_MS = 86400000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (a, n) => ((a % n) + n) % n;

/* ---------------- 태양 위치 (NOAA Solar Calculator 식) ---------------- */

function solarParams(ms) {
  const T = (ms / DAY_MS + 2440587.5 - 2451545) / 36525; // 율리우스 세기
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTime =
    4 * DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD)); // 분
  return { decl, eqTime };
}

/** 시각(ms, UTC)의 태양 고도·방위각(북=0°, 시계방향) */
export function sunPosition(ms, lat, lon) {
  const { decl, eqTime } = solarParams(ms);
  const utcMin = mod(ms, DAY_MS) / 60000;
  const tst = mod(utcMin + eqTime + 4 * lon, 1440); // 진태양시(분)
  const ha = (tst / 4 - 180) * RAD;
  const phi = lat * RAD;
  const dl = decl * RAD;
  const cosZ = Math.sin(phi) * Math.sin(dl) + Math.cos(phi) * Math.cos(dl) * Math.cos(ha);
  const alt = 90 - Math.acos(clamp(cosZ, -1, 1)) * DEG;
  const az = mod(
    Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dl) * Math.cos(phi)) * DEG + 180,
    360,
  );
  return { alt, az };
}

/**
 * 현지 날짜(y,m,d)의 해 지는(kind='set') / 뜨는(kind='rise') 시각.
 * altDeg: 해 윗가장자리 + 대기 굴절 기준 -0.833°. 노을 끝(-4°) 같은 다른 고도도 가능.
 * utcOffsetSec는 그 날의 정오를 찾는 데만 쓰므로 한두 시간 틀려도 결과는 같다.
 * 반환: { t: ms(UTC), az } 또는 { polar: 'day' | 'night' }
 */
export function sunEventTime(ymd, lat, lon, utcOffsetSec = 0, kind = 'set', altDeg = -0.833) {
  const approxNoon = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12) - utcOffsetSec * 1000;
  let noon = approxNoon;
  for (let i = 0; i < 3; i++) {
    const { eqTime } = solarParams(noon);
    let n = Math.floor(noon / DAY_MS) * DAY_MS + (720 - 4 * lon - eqTime) * 60000;
    while (n - approxNoon > DAY_MS / 2) n -= DAY_MS;
    while (approxNoon - n > DAY_MS / 2) n += DAY_MS;
    noon = n;
  }
  const sign = kind === 'rise' ? -1 : 1;
  let t = noon;
  for (let i = 0; i < 4; i++) {
    const { decl } = solarParams(t);
    const phi = lat * RAD;
    const dl = decl * RAD;
    const cosH = (Math.sin(altDeg * RAD) - Math.sin(phi) * Math.sin(dl)) / (Math.cos(phi) * Math.cos(dl));
    if (!(cosH <= 1)) return { polar: 'night' }; // 해가 그 고도까지 안 올라옴
    if (cosH < -1) return { polar: 'day' }; // 해가 그 고도 아래로 안 내려감
    t = noon + sign * Math.acos(cosH) * DEG * 4 * 60000;
  }
  return { t, az: sunPosition(t, lat, lon).az };
}

/* ---------------- 지구 위 거리 계산 ---------------- */

/** 출발점에서 방위각 bearing(°)으로 distKm 간 지점 (대권 항로) */
export function destination(lat, lon, bearing, distKm) {
  const d = distKm / R_EARTH;
  const b = bearing * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * DEG, lon: mod(l2 * DEG + 540, 360) - 180 };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * RAD;
  const dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ---------------- 시간·날짜 도우미 ---------------- */

/** 정렬된 시각 배열(초)에서 t 시점 값을 선형 보간. 한쪽이 비면 다른 쪽, 범위 밖이면 null */
export function interpAt(times, values, t) {
  if (!Array.isArray(times) || !Array.isArray(values) || times.length === 0) return null;
  const n = times.length;
  if (!(t >= times[0] && t <= times[n - 1])) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const a = num(values[lo]);
  const b = num(values[hi]);
  if (a == null) return b;
  if (b == null || hi === lo) return a;
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return a + (b - a) * f;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ms 시각이 그 지역(timeZone)에서 며칠인지. 시간대 이름이 안 통하면 고정 오프셋으로 */
export function localYMD(ms, timeZone, offsetSec = 0) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).formatToParts(new Date(ms));
      const get = (k) => Number(parts.find((p) => p.type === k)?.value);
      const ymd = { y: get('year'), m: get('month'), d: get('day') };
      if (ymd.y && ymd.m && ymd.d) return ymd;
    } catch {
      /* 아래 고정 오프셋으로 */
    }
  }
  const d = new Date(ms + offsetSec * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function addDays(ymd, k) {
  const d = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + k));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function weekdayKo(ymd) {
  return '일월화수목금토'[new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay()];
}

const COMPASS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동',
  '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
export function compassKo(az) {
  return COMPASS[Math.round(mod(az, 360) / 22.5) % 16];
}

/* ---------------- 노을 점수 ---------------- */

// [표본 번호(DISTANCES의 위치), 가중치]
const W_CANVAS = [[0, 0.32], [1, 0.27], [2, 0.19], [3, 0.14], [4, 0.08]]; // 0~250km 중·상층 구름 = 물들 캔버스
const W_BAND = [[3, 0.35], [4, 0.4], [5, 0.25]]; // 150~350km = 서쪽 지평선에 걸리는 구름 띠
const W_PATH = [[2, 0.1], [3, 0.25], [4, 0.25], [5, 0.25], [6, 0.15]]; // 80~450km 해 쪽 (표시용 하층 평균)
const W_UP = [[0, 0.6], [1, 0.4]]; // 머리 위 저층 구름
const W_HORIZON = [[1, 0.25], [2, 0.35], [3, 0.4]]; // 서쪽 지평선 쪽 저층 구름

/* ---------------- 햇빛 길: 빛줄기 거꾸로 따라가기 ----------------
 * 해가 지평선 아래 0~3°일 때, 머리 위 구름 밑면에 닿는 햇빛을 해 쪽으로 거꾸로 따라간다.
 * 빛줄기 높이 h(x) = 구름 높이 − x·tan(해 각도) + x²/(2R)  (x: 구름에서 해 쪽으로 간 거리, 지구가 둥근 효과 포함)
 * 빛줄기가 하층·중층·상층 띠 안을 지나는 동안 그 자리 구름량만큼 가리고, 땅에 닿으면(지구 그림자) 0.
 * 맑은 하늘에서 같은 계산을 한 값으로 나눠, 지구 그림자 몫은 빼고 구름에 가린 몫만 남긴다.
 */
const R_KM = 6371;
const BANDS = [
  { lo: 0.5, hi: 2.5, a: 0.9 }, // 하층
  { lo: 3.5, hi: 6.5, a: 0.7 }, // 중층
  { lo: 8, hi: 11, a: 0.3 }, // 상층 (얇은 권운이라 빛이 잘 샘)
];
const CANVAS_BASE = { mid: 3.5, high: 8 }; // 물드는 구름 밑면 높이(km)
const SUN_DEP = [[0, 0.4], [0.5, 0.8], [1, 1], [1.5, 1], [2, 1], [2.5, 0.8], [3, 0.6]]; // 해 각도(°), 색 가중
const RAY_STEP = 5; // km
const RAY_MAX = 700; // km
const RAY_EXT = 40; // 꽉 찬 띠를 이 거리(km)만큼 지나면 (1 − a)만 남음

function fillGaps(arr) {
  return arr.map((v, i) => {
    if (v != null) return v;
    let best = null;
    let bd = Infinity;
    arr.forEach((w, j) => {
      if (w != null && Math.abs(i - j) < bd) {
        bd = Math.abs(i - j);
        best = w;
      }
    });
    return best ?? 0;
  });
}

function coverAt(arr, km) {
  if (km <= DISTANCES[0]) return arr[0];
  for (let i = 1; i < DISTANCES.length; i++) {
    if (km <= DISTANCES[i]) {
      const f = (km - DISTANCES[i - 1]) / (DISTANCES[i] - DISTANCES[i - 1]);
      return arr[i - 1] + (arr[i] - arr[i - 1]) * f;
    }
  }
  return arr[arr.length - 1]; // 450km 너머는 마지막 값 유지
}

/** 한 빛줄기의 투과율(0~1). layers = [하층, 중층, 상층] 구름 비율 배열(DISTANCES 순서) 또는 null(맑은 하늘) */
export function rayTransmission(layers, startKm, heightKm, depDeg) {
  const t = Math.tan(depDeg * RAD);
  let T = 1;
  for (let x = RAY_STEP / 2; x < RAY_MAX; x += RAY_STEP) {
    const h = heightKm - x * t + (x * x) / (2 * R_KM);
    if (h < 0.3) return 0; // 땅(지구 그림자)
    if (h > BANDS[2].hi && x > R_KM * t) break; // 구름 위로 올라가 다시 안 내려옴
    if (!layers) continue;
    for (let b = 0; b < BANDS.length; b++) {
      if (h >= BANDS[b].lo && h <= BANDS[b].hi) {
        T *= Math.pow(1 - BANDS[b].a * clamp(coverAt(layers[b], startKm + x), 0, 1), RAY_STEP / RAY_EXT);
      }
    }
    if (T < 1e-4) return 0;
  }
  return T;
}

const clearCache = new Map();
function clearRay(heightKm, depDeg) {
  const k = `${heightKm}|${depDeg}`;
  if (!clearCache.has(k)) clearCache.set(k, rayTransmission(null, 0, heightKm, depDeg));
  return clearCache.get(k);
}

/** 그 자리 구름 밑면이 노을빛을 받는 정도(0~1, 맑은 하늘 = 1) */
export function canvasLight(layers, km, heightKm) {
  let got = 0;
  let max = 0;
  for (const [d, w] of SUN_DEP) {
    const clear = clearRay(heightKm, d);
    if (!clear) continue;
    got += w * rayTransmission(layers, km, heightKm, d);
    max += w * clear;
  }
  return max ? got / max : 0;
}

function wavg(values, weights) {
  let s = 0;
  let w = 0;
  for (const [i, wi] of weights) {
    const v = values[i];
    if (v == null) continue;
    s += v * wi;
    w += wi;
  }
  return w >= 0.4 ? s / w : null; // 절반 가까이 비면 판단 보류
}

/** 중·상층 구름 비율(0~1) → 캔버스 점수(0~1). 35~75%가 가장 좋고, 꽉 차면 조금 깎임 (꽉 찬 날은 빛길로 갈림) */
export function canvasCurve(U) {
  if (U <= 0.05) return 0;
  if (U < 0.4) return ((U - 0.05) / 0.35) ** 0.8;
  if (U <= 0.75) return 1;
  return 1 - (0.2 * (Math.min(U, 1) - 0.75)) / 0.25;
}

/** 습도(%)·시정(m) → 0.4~1 */
export function hazeFactor(rh, visM) {
  let fv = 1;
  if (visM != null) {
    const km = visM / 1000;
    fv = km >= 30 ? 1 : km <= 2 ? 0.5 : 0.5 + (0.5 * Math.log(km / 2)) / Math.log(15);
  }
  let fr = 1;
  if (rh != null) fr = rh <= 65 ? 1 : rh >= 98 ? 0.75 : 1 - (0.25 * (rh - 65)) / 33;
  return Math.max(0.4, fv * fr);
}

/** 에어로졸 광학두께(AOD 550nm) → 0.7~1.05. 조금 있으면 더 붉고, 많으면 뿌옇다 */
export function aerosolFactor(aod) {
  if (aod == null) return 1;
  const pts = [[0, 0.97], [0.1, 1], [0.2, 1.05], [0.35, 1.05], [0.6, 0.95], [1, 0.8], [1.5, 0.7]];
  if (aod >= 1.5) return 0.7;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (aod <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((y1 - y0) * (aod - x0)) / (x1 - x0);
    }
  }
  return 0.7;
}

/** 관측 지점 강수(mm/h) → 0.35~1 */
export function rainFactor(mm) {
  if (mm == null || mm < 0.1) return 1;
  if (mm >= 1) return 0.35;
  return 1 - (0.65 * (mm - 0.1)) / 0.9;
}

export const GRADES = [
  { min: 80, key: 'epic', label: '장관', desc: '하늘 넓게 붉게 물들 가능성이 커요' },
  { min: 60, key: 'great', label: '매우 좋음', desc: '진한 노을을 기대해 볼 만해요' },
  { min: 40, key: 'good', label: '좋음', desc: '구름이 꽤 물들 수 있어요' },
  { min: 20, key: 'fair', label: '보통', desc: '지평선 쪽만 은은하게 물들어요' },
  { min: 0, key: 'poor', label: '나쁨', desc: '색이 거의 안 보일 가능성이 커요' },
];

export function grade(score) {
  if (score == null) return null;
  return GRADES.find((g) => score >= g.min) ?? GRADES[GRADES.length - 1];
}

/**
 * 노을 점수(0~100).
 * s.low/mid/high: DISTANCES 순서의 구름량(%) 배열(값이 없으면 null)
 * s.rh(%), s.vis(m), s.precip(mm/h), s.aod: 관측 지점 값(없으면 null)
 */
export function scoreSunset(s) {
  const pct = (v) => (num(v) == null ? null : clamp(v / 100, 0, 1));
  const L = (s.low ?? []).map(pct);
  const M = (s.mid ?? []).map(pct);
  const H = (s.high ?? []).map(pct);
  const n = DISTANCES.length;
  for (const arr of [L, M, H]) while (arr.length < n) arr.push(null);

  const Lpath = wavg(L, W_PATH);
  const Lup = wavg(L, W_UP);
  const Lhz = wavg(L, W_HORIZON);
  const hasUpper = (ws) => ws.reduce((w, [i, wi]) => w + (M[i] != null || H[i] != null ? wi : 0), 0) >= 0.4;
  if (Lup == null || Lhz == null || Lpath == null || !hasUpper(W_CANVAS)) {
    return { score: null, reason: '구름 예보 자료가 부족해요' };
  }

  // 표본마다: 중·상층 구름 양(위층은 아래층 틈으로 보이는 만큼)과, 그중 노을빛을 받는 양
  const layers = [fillGaps(L), fillGaps(M), fillGaps(H)];
  const memo = new Map();
  const cell = (i) => {
    if (!memo.has(i)) {
      const mv = M[i] ?? 0;
      const hv = (H[i] ?? 0) * (1 - 0.7 * mv);
      const tm = canvasLight(layers, DISTANCES[i], CANVAS_BASE.mid);
      const th = canvasLight(layers, DISTANCES[i], CANVAS_BASE.high);
      memo.set(i, { amt: mv + 0.8 * hv, lit: mv * tm + 0.8 * hv * th, hypo: (tm + th) / 2 });
    }
    return memo.get(i);
  };
  let U = 0;
  let amt = 0;
  let lit = 0;
  let hypo = 0;
  let ws = 0;
  for (const [i, w] of W_CANVAS) {
    if (M[i] == null && H[i] == null) continue;
    const c = cell(i);
    U += w * Math.min(1, c.amt);
    amt += w * c.amt;
    lit += w * c.lit;
    hypo += w * c.hypo;
    ws += w;
  }
  U /= ws;
  // 햇빛 길: 캔버스 구름이 받는 빛의 비율 (구름이 거의 없으면 '있다면 받을 빛')
  const P = amt / ws > 0.02 ? lit / amt : hypo / ws;
  // 지평선에 걸린 구름 띠 중 빛을 못 받아 회색으로 남는 양
  let dark = 0;
  let wb = 0;
  for (const [i, w] of W_BAND) {
    const c = cell(i);
    dark += w * Math.max(0, c.amt - c.lit);
    wb += w;
  }
  const G = 1 - 0.6 * Math.min(1, dark / wb);

  const C = canvasCurve(U);
  const S = 1 - Lup; // 머리 위 트임
  const Z = 1 - Lhz; // 서쪽 지평선 트임 (낮은 구름)
  const glow = 25 * Z * (1 - 0.5 * Lup) * G; // 구름 없이도 생기는 지평선 노을
  const color = 75 * C * P * S * (0.5 + 0.5 * Z); // 구름이 물드는 몫
  const fH = hazeFactor(num(s.rh), num(s.vis));
  const fA = aerosolFactor(num(s.aod));
  const fR = rainFactor(num(s.precip));
  const raw = clamp((glow + color) * fH * fA * fR, 0, 100);
  const score = Math.round(raw);
  return {
    score,
    raw,
    grade: grade(score),
    parts: { U, C, P, G, S, Z, Lpath, Lup, Lhz, glow, color, fH, fA, fR },
  };
}

/** 점수에 대한 한 줄 설명 */
export function explain(res) {
  if (!res || res.score == null) return res?.reason ?? '';
  const p = res.parts;
  if (p.fR < 0.7) return '비가 와서 노을 보기는 어려워요.';
  if (p.S < 0.35) return '머리 위를 낮은 구름이 덮어서 하늘이 잘 안 보여요.';
  if (p.U >= 0.25 && p.P < 0.4) return '물들 구름은 있지만 해 쪽 구름에 막혀 빛이 닿기 어려워요.';
  if (p.Z < 0.4) return '서쪽 지평선 쪽 낮은 구름이 해를 가려요.';
  if (p.U < 0.08) return '하늘이 너무 맑아서 지평선 쪽만 은은하게 물들어요.';
  if (p.fH < 0.75) return '공기가 뿌옇거나 습해서 색이 흐려질 수 있어요.';
  if (res.score >= 60) return '높은 구름이 적당하고 해 쪽이 트여 있어 진하게 물들 수 있어요.';
  if (res.score >= 40) return '물들 구름이 어느 정도 있고 해 쪽도 대체로 트여 있어요.';
  if (p.U > 0.8) return '높은 구름이 하늘을 거의 다 덮어서 색이 옅을 수 있어요.';
  return '물들 구름이 적거나 빛길이 일부 막혀 있어요.';
}

/** 며칠 뒤 예보인지에 따른 신뢰도 */
export function reliability(dayIndex) {
  if (dayIndex <= 1) return { key: 'high', label: '높음' };
  if (dayIndex <= 3) return { key: 'mid', label: '보통' };
  return { key: 'low', label: '낮음' };
}
