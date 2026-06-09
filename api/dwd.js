// Vercel Serverless Function: DWD Niederschlag Proxy (agnostisch)
// Findet die nächste aktive DWD-Niederschlagsstation zu lat/lon.
// Logik identisch zu netlify/functions/dwd.js.
import zlib from 'zlib';

const BASE = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/recent';
const STATION_LIST = `${BASE}/RR_Stundenwerte_Beschreibung_Stationen.txt`;
const UA = 'wasser-dashboard/1.0';

let _stationsCache = null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  try {
    const stations = await getStations();
    if (!stations.length) throw new Error('DWD-Stationsliste leer');

    const ranked = (isFinite(lat) && isFinite(lon))
      ? stations.map(s => ({ ...s, distKm: Math.round(haversine(lat, lon, s.lat, s.lon) * 10) / 10 }))
                .sort((a, b) => a.distKm - b.distKm)
      : stations.map(s => ({ ...s, distKm: null }));

    let chosen = null, data = null;
    for (const s of ranked.slice(0, 6)) {
      const csv = await fetchStationCsv(s.id);
      if (csv) {
        const rows = parseCsv(csv);
        if (rows.length) { chosen = s; data = rows.slice(-72); break; }
      }
    }
    if (!chosen) throw new Error('Keine abrufbare Station im Umkreis');

    res.status(200).json({
      ok: true,
      station: { id: chosen.id, name: chosen.name, lat: chosen.lat, lon: chosen.lon, distKm: chosen.distKm },
      data, ts: Date.now(),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}

async function getStations() {
  if (_stationsCache) return _stationsCache;
  const r = await fetch(STATION_LIST, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`DWD Stationsliste HTTP ${r.status}`);
  const txt = Buffer.from(await r.arrayBuffer()).toString('latin1');
  _stationsCache = parseStationList(txt);
  return _stationsCache;
}

function parseStationList(txt) {
  const lines = txt.split('\n').slice(2);
  const nowYear = new Date().getUTCFullYear();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 8) continue;
    const id = t[0], bis = t[2];
    const lat = parseFloat(t[4]), lon = parseFloat(t[5]);
    const abgabe = t[t.length - 1];
    if (!/^\d{5}$/.test(id) || !isFinite(lat) || !isFinite(lon)) continue;
    if (!(parseInt(bis.slice(0, 4), 10) >= nowYear - 1)) continue;
    if (abgabe && abgabe.toLowerCase() !== 'frei') continue;
    out.push({ id, name: t.slice(6, t.length - 2).join(' '), lat, lon });
  }
  return out;
}

async function fetchStationCsv(id) {
  try {
    const r = await fetch(`${BASE}/stundenwerte_RR_${id}_akt.zip`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return extractCsvFromZip(Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}

function extractCsvFromZip(buf) {
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const fnLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const fn = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf8');
    const dataStart = offset + 30 + fnLen + extraLen;
    const compSize = buf.readUInt32LE(offset + 18);
    const method = buf.readUInt16LE(offset + 8);
    if (fn.startsWith('produkt_rr_stunde_') && fn.endsWith('.txt')) {
      let data = buf.slice(dataStart, dataStart + compSize);
      if (method === 8) data = zlib.inflateRawSync(data);
      return data.toString('latin1');
    }
    offset = dataStart + compSize;
  }
  return null;
}

function parseCsv(csv) {
  return csv.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.split(';');
    if (c.length < 4) return null;
    const raw = c[1].trim();
    if (!/^\d{10}$/.test(raw)) return null;
    const dt = new Date(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:00:00Z`).toISOString();
    const mm = parseFloat(c[3].replace(',', '.'));
    return { dt, mm: isNaN(mm) || mm < 0 ? 0 : mm };
  }).filter(Boolean);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
