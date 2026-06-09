// Vercel Serverless Function: Pegel-Proxy (HVZ Baden-Württemberg)
// Logik identisch zu netlify/functions/pegel.js – siehe dort für Details.

const HVZ_STMN = 'https://www.hvz.baden-wuerttemberg.de/js/hvz_peg_stmn.js';
const UA = 'wasser-dashboard/1.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=1800');

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radiusKm = Math.min(parseFloat(req.query.radius) || 25, 80);
  const limit = Math.min(parseInt(req.query.limit) || 8, 30);

  try {
    const r = await fetch(HVZ_STMN, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HVZ HTTP ${r.status}`);
    const js = await r.text();

    let stations = parseHvzStations(js);
    if (!stations.length) throw new Error('Keine Stationen aus HVZ geparst');

    if (isFinite(lat) && isFinite(lon)) {
      stations = stations
        .map(s => ({ ...s, distKm: Math.round(haversine(lat, lon, s.lat, s.lon) * 10) / 10 }))
        .filter(s => s.distKm <= radiusKm)
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, limit);
    }
    res.status(200).json({ ok: true, count: stations.length, stations, ts: Date.now() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}

function parseHvzStations(js) {
  const start = js.indexOf('PEG_DB');
  if (start < 0) return [];
  const open = js.indexOf('[', start);
  const end = js.indexOf('];', open);
  if (open < 0 || end < 0) return [];
  const rows = js.slice(open + 1, end).match(/\[[^\]]*\]/g) || [];
  const out = [];
  for (const row of rows) {
    let arr;
    try { arr = JSON.parse(row.replace(/'/g, '"')); } catch { continue; }
    if (!Array.isArray(arr) || arr.length < 22) continue;
    const lon = num(arr[20]), lat = num(arr[21]);
    if (!isFinite(lat) || !isFinite(lon) || lat < 47 || lat > 50 || lon < 7 || lon > 11) continue;
    const wRaw = String(arr[4] ?? '').trim();
    const qRaw = String(arr[7] ?? '').trim();
    const stale = wRaw === '' || wRaw === '--' || /Zeitlimit|Wert/i.test(wRaw);
    out.push({
      id: String(arr[0]), name: String(arr[1]), water: String(arr[2]),
      w: numOrNull(wRaw), wUnit: String(arr[5] || 'cm'), wDate: String(arr[6] || ''),
      q: numOrNull(qRaw), qUnit: String(arr[8] || ''), qDate: String(arr[9] || ''),
      lat, lon, stale,
    });
  }
  return out;
}
function num(v) { return parseFloat(String(v).replace(',', '.')); }
function numOrNull(v) { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
