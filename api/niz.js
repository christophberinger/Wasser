// Vercel Serverless Function: Gewässergüte-Proxy (NIZ Baden-Württemberg)
// Logik identisch zu netlify/functions/niz.js – siehe dort für Details.

const LIST = 'https://lupo-cloud.de/niz-app/quality-stations';
const STATION = 'https://lupo-cloud.de/niz-app/quality-station';
const UA = 'Mozilla/5.0 wasser-dashboard/1.0';

const PARAM_LABELS = {
  temp: 'Wassertemperatur', o2: 'Sauerstoff', pH: 'pH-Wert',
  lf: 'Leitfähigkeit', tr: 'Trübung', o2s: 'O₂-Sättigung',
};
const PARAM_ORDER = ['temp', 'o2', 'o2s', 'pH', 'lf', 'tr'];

let _listCache = null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  const radiusKm = Math.min(parseFloat(req.query.radius) || 25, 80);

  try {
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('lat/lon erforderlich');
    const stations = await getList();
    if (!stations.length) throw new Error('NIZ-Stationsliste leer');

    const nearest = stations
      .map(s => ({ ...s, distKm: Math.round(haversine(lat, lon, s.lat, s.lon) * 10) / 10 }))
      .filter(s => s.distKm <= radiusKm)
      .sort((a, b) => a.distKm - b.distKm)[0];

    if (!nearest) { res.status(200).json({ ok: true, station: null, params: [] }); return; }

    const detail = await fetchStation(nearest.id);
    res.status(200).json({ ok: true, ...detail, station: { ...detail.station, distKm: nearest.distKm } });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}

async function getList() {
  if (_listCache) return _listCache;
  const r = await fetch(LIST, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`NIZ Liste HTTP ${r.status}`);
  const d = await r.json();
  _listCache = (d?.selectorStations?.items || []).filter(s => isFinite(s.lat) && isFinite(s.lon));
  return _listCache;
}

async function fetchStation(id) {
  const r = await fetch(`${STATION}?id=${encodeURIComponent(id)}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`NIZ Station HTTP ${r.status}`);
  const d = await r.json();
  const st = d?.infoPanel?.station || {};
  const mr = st.messreihen || {};
  const params = [];
  for (const key of [...PARAM_ORDER, ...Object.keys(mr)]) {
    if (!mr[key] || params.some(p => p.key === key)) continue;
    const v = mr[key].values || {};
    if (v.latest == null && v['latest-original'] == null) continue;
    params.push({
      key, label: PARAM_LABELS[key] || key, unit: mr[key].dimension || '',
      value: v.latest ?? (v['latest-original'] != null ? String(v['latest-original']) : '–'),
      valueNum: v['latest-original'] ?? null,
      dayAvg: v.dailyAverageDayBefore?.awgw ?? null,
      tsFormat: v['latest-ts-format-mez'] || st['ts-format-mez'] || '',
      invalid: !!v['latest-invalid'],
    });
  }
  return {
    station: { name: st.name || '', gewaesser: st.gewaesser || '', lat: st.lat, lon: st.lon, ts: st['ts-format-mez'] || st['ts-format'] || '' },
    params,
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
