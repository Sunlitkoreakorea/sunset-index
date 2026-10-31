// Open-Meteo가 계산한 일몰 시각을 받아 test/fixtures/sunsets.json 으로 저장 (테스트 기준값)
// 실행: node tools/make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const PLACES = [
  ['민사고', 37.4592, 128.1436],
  ['서울', 37.5665, 126.978],
  ['런던', 51.5074, -0.1278],
  ['뉴욕', 40.7128, -74.006],
  ['LA', 34.05, -118.24],
  ['시드니', -33.8688, 151.2093],
  ['레이캬비크', 64.1466, -21.9426],
  ['트롬쇠', 69.6496, 18.956],
  ['오클랜드', -36.85, 174.76],
  ['키리티마티', 1.87, -157.4],
  ['호놀룰루', 21.31, -157.86],
  ['키토', -0.18, -78.47],
  ['우수아이아', -54.8, -68.3],
];

const out = { made: new Date().toISOString(), places: [] };
for (const [name, lat, lon] of PLACES) {
  const q = (base, extra) =>
    `${base}?latitude=${lat}&longitude=${lon}&daily=sunset,sunrise&timezone=auto&timeformat=unixtime&${extra}`;
  const arch = await (await fetch(q('https://archive-api.open-meteo.com/v1/archive', 'start_date=2025-11-01&end_date=2026-10-20'))).json();
  const fc = await (await fetch(q('https://api.open-meteo.com/v1/forecast', 'forecast_days=8'))).json();
  if (arch.error || fc.error) throw new Error(`${name}: ${arch.reason || fc.reason}`);
  out.places.push({
    name, lat, lon,
    timezone: fc.timezone,
    utc_offset_seconds: fc.utc_offset_seconds,
    days: [arch, fc].flatMap((r) => r.daily.time.map((t, i) => ({ t, sunset: r.daily.sunset[i], sunrise: r.daily.sunrise[i], off: r.utc_offset_seconds }))),
  });
  console.log(name, out.places.at(-1).days.length);
}
mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('../test/fixtures/sunsets.json', import.meta.url), JSON.stringify(out));
