// Netlify Function: Gewässergüte-Proxy (NIZ Baden-Württemberg)
//
// Quelle: Niedrigwasser-Informationszentrum BW (LUBW), Backend lupo-cloud.de.
// Liefert tagesaktuelle Güteparameter an ~130 Fließgewässer-Messstationen:
//   Wassertemperatur (alle), zusätzlich O₂, pH, Leitfähigkeit, Trübung an
//   kontinuierlichen Gütemessstationen. Kein CORS → serverseitig proxen.
//
// Aufruf:  /.netlify/functions/niz?lat=48.93&lon=8.96&radius=25
//   → { ok, station:{name,gewaesser,lat,lon,distKm,ts}, params:[{key,label,unit,value,valueNum,dayAvg}] }

const LIST = 'https://lupo-cloud.de/niz-app/quality-stations';
const STATION = 'https://lupo-cloud.de/niz-app/quality-station';
const UA = 'Mozilla/5.0 wasser-dashboard/1.0';

const PARAM_LABELS = {
  temp: 'Wassertemperatur', o2: 'Sauerstoff', pH: 'pH-Wert',
  lf: 'Leitfähigkeit', tr: 'Trübung', o2s: 'O₂-Sättigung',
};
const PARAM_ORDER = ['temp', 'o2', 'o2s', 'pH', 'lf', 'tr'];

let _listCache = null;

export async function handler(event) {
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const radiusKm = Math.min(parseFloat(q.radius) || 25, 80);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800, stale-while-revalidate=3600',
  };

  try {
    // Modus 1: komplette Stationsliste (für Karten-Marker)
    if (q.list) {
      const stations = await getList();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, stations: stations.map(s => ({ id: s.id, name: s.label || s.title || String(s.id), lat: s.lat, lon: s.lon })) }) };
    }
    // Modus 2: Detail einer einzelnen Station (für Sidebar)
    if (q.id) {
      const detail = await fetchStation(q.id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...detail }) };
    }

    // Modus 3: nächste vollständige Gütemessstation (Ampel / Abwärtskompatibilität)
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('lat/lon, id oder list erforderlich');
    const stations = await getList();
    if (!stations.length) throw new Error('NIZ-Stationsliste leer');

    const ranked = stations
      .map(s => ({ ...s, distKm: Math.round(haversine(lat, lon, s.lat, s.lon) * 10) / 10 }))
      .filter(s => s.distKm <= radiusKm)
      .sort((a, b) => a.distKm - b.distKm);

    if (!ranked.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, station: null, params: [] }) };
    }

    const picked = await pickStation(ranked);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...picked.detail, station: { ...picked.detail.station, distKm: picked.cand.distKm } }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

// Für die Gewässergüte die nächste VOLLSTÄNDIGE Gütemessstation (mit O₂) bevorzugen.
// Viele NIZ-Stationen messen nur Wassertemperatur – die nächste davon wäre wenig
// aussagekräftig. Daher die nächsten Kandidaten prüfen und die nächstgelegene mit
// O₂ wählen; sonst auf die nächste (Temperatur-)Station zurückfallen.
const hasO2 = d => !!d?.params?.some(p => p.key === 'o2');
async function pickStation(ranked) {
  const first = await fetchStation(ranked[0].id);
  if (hasO2(first) || ranked.length === 1) return { cand: ranked[0], detail: first };
  const rest = ranked.slice(1, 12);
  const details = await Promise.all(rest.map(c => fetchStation(c.id).then(d => ({ c, d })).catch(() => null)));
  const o2hit = details.find(x => x && hasO2(x.d)); // nächste mit O₂ (Reihenfolge = Distanz)
  return o2hit ? { cand: o2hit.c, detail: o2hit.d } : { cand: ranked[0], detail: first };
}

async function getList() {
  if (_listCache) return _listCache;
  const r = await fetch(LIST, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`NIZ Liste HTTP ${r.status}`);
  const d = await r.json();
  const items = d?.selectorStations?.items || [];
  _listCache = items.filter(s => isFinite(s.lat) && isFinite(s.lon));
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
      key,
      label: PARAM_LABELS[key] || key,
      unit: mr[key].dimension || '',
      value: v.latest ?? (v['latest-original'] != null ? String(v['latest-original']) : '–'),
      valueNum: v['latest-original'] ?? null,
      dayAvg: v.dailyAverageDayBefore?.awgw ?? null,
      tsFormat: v['latest-ts-format-mez'] || st['ts-format-mez'] || '',
      invalid: !!v['latest-invalid'],
    });
  }

  return {
    station: {
      name: st.name || '', gewaesser: st.gewaesser || '',
      lat: st.lat, lon: st.lon, ts: st['ts-format-mez'] || st['ts-format'] || '',
    },
    params,
    series: extractSeries(d.table),
  };
}

// Zeitreihe aus der Tabellen-Ansicht: header = [Datum/Zeit, Temperatur, ...],
// data = [[ts_ms, temp, o2, pH, lf, tr], ...] (neueste zuerst → aufsteigend sortieren).
const COLMAP = [
  { re: /temperatur/i, key: 'temp' }, { re: /sauerstoff/i, key: 'o2' },
  { re: /pH/i, key: 'pH' }, { re: /leitf/i, key: 'lf' },
  { re: /tr(ü|u)bung/i, key: 'tr' }, { re: /chlorophyll/i, key: 'chl' },
];
function extractSeries(table) {
  if (!table?.header || !Array.isArray(table.data)) return null;
  const labels = table.header.map(c => (c.label || '').replace(/<[^>]+>/g, ''));
  const colKey = labels.map(l => (COLMAP.find(m => m.re.test(l))?.key) || null);
  const rows = [...table.data].sort((a, b) => a[0] - b[0]);
  const ts = rows.map(r => r[0]);
  const data = {};
  for (let i = 1; i < labels.length; i++) {
    const key = colKey[i]; if (!key) continue;
    data[key] = rows.map(r => (typeof r[i] === 'number' ? r[i] : null));
  }
  return { ts, data };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
