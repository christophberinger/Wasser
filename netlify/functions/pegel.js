// Netlify Function: Pegel-Proxy (Baden-Württemberg, agnostisch)
//
// Quelle: HVZ Baden-Württemberg (Hochwasservorhersagezentrale / LUBW).
// Die Stammdaten-Datei hvz_peg_stmn.js enthält ALLE ~330 BW-Pegel
// (auch kleine Flüsse wie die Enz) inkl. Koordinaten + aktuellem W/Q-Wert.
// Sie wird ~alle 15 Min aktualisiert und liegt als JS-Global-Zuweisung vor
// (kein CORS) – daher serverseitig parsen und als saubere JSON liefern.
//
// Aufruf:  /.netlify/functions/pegel?lat=48.93&lon=8.96&radius=20
//   → { ok, stations: [ {id,name,water,w,wUnit,wDate,q,qUnit,qDate,lat,lon,distKm,stale} ] }
// Rückwärtskompatibel: ohne lat/lon wird die komplette (sortierte) Liste geliefert.

const HVZ_STMN = 'https://www.hvz.baden-wuerttemberg.de/js/hvz_peg_stmn.js';
const UA = 'wasser-dashboard/1.0';

export async function handler(event) {
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat);
  const lon = parseFloat(q.lon);
  const radiusKm = Math.min(parseFloat(q.radius) || 25, 80);
  const limit = Math.min(parseInt(q.limit) || 8, 30);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=600, stale-while-revalidate=1800',
  };

  try {
    const res = await fetch(HVZ_STMN, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HVZ HTTP ${res.status}`);
    const js = await res.text();

    let stations = parseHvzStations(js);
    if (!stations.length) throw new Error('Keine Stationen aus HVZ geparst');

    if (isFinite(lat) && isFinite(lon)) {
      stations = stations
        .map(s => ({ ...s, distKm: Math.round(haversine(lat, lon, s.lat, s.lon) * 10) / 10 }))
        .filter(s => s.distKm <= radiusKm)
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, limit);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, count: stations.length, stations, ts: Date.now() }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

// HVZ-Stammdaten parsen: HVZ_Site.PEG_DB = [ ['00037','Höfen','Enz',...], ... ];
// Spalten (0-basiert): 0=id 1=name 2=gewässer 4=W 5=WDim 6=WDat 7=Q 8=QDim 9=QDat
//                      20=lon 21=lat  (WGS84). Werte '--' = keine Messung.
function parseHvzStations(js) {
  const start = js.indexOf('PEG_DB');
  if (start < 0) return [];
  const open = js.indexOf('[', start);
  const end = js.indexOf('];', open);
  if (open < 0 || end < 0) return [];
  const block = js.slice(open + 1, end);

  const rows = block.match(/\[[^\]]*\]/g) || [];
  const out = [];
  for (const row of rows) {
    let arr;
    try { arr = JSON.parse(row.replace(/'/g, '"')); }
    catch { continue; }
    if (!Array.isArray(arr) || arr.length < 22) continue;

    const lon = num(arr[20]), lat = num(arr[21]);
    if (!isFinite(lat) || !isFinite(lon) || lat < 47 || lat > 50 || lon < 7 || lon > 11) continue;

    const wRaw = String(arr[4] ?? '').trim();
    const qRaw = String(arr[7] ?? '').trim();
    const stale = wRaw === '' || wRaw === '--' || /Zeitlimit|Wert/i.test(wRaw);

    out.push({
      id: String(arr[0]),
      name: String(arr[1]),
      water: String(arr[2]),
      w: numOrNull(wRaw),
      wUnit: String(arr[5] || 'cm'),
      wDate: String(arr[6] || ''),
      q: numOrNull(qRaw),
      qUnit: String(arr[8] || ''),
      qDate: String(arr[9] || ''),
      lat, lon,
      stale,
    });
  }
  return out;
}

function num(v) { return parseFloat(String(v).replace(',', '.')); }
function numOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
