// Netlify Function: DWD Niederschlag Proxy (agnostisch)
//
// Findet dynamisch die nächste aktive DWD-Niederschlagsstation zu lat/lon,
// lädt deren ZIP (Open Data, stündlich) und liefert die letzten 72h als JSON.
//
// Aufruf:  /.netlify/functions/dwd?lat=48.93&lon=8.96
//   → { ok, station:{id,name,lat,lon,distKm}, data:[{dt,mm}], ts }
import zlib from 'zlib';

const BASE = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/recent';
const STATION_LIST = `${BASE}/RR_Stundenwerte_Beschreibung_Stationen.txt`;
const UA = 'wasser-dashboard/1.0';

let _stationsCache = null; // über warme Lambda-Aufrufe hinweg zwischenspeichern

export async function handler(event) {
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat);
  const lon = parseFloat(q.lon);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
  };

  try {
    const stations = await getStations();
    if (!stations.length) throw new Error('DWD-Stationsliste leer');

    // Kandidaten nach Nähe sortieren (Fallback nach unten, falls ein ZIP fehlt)
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

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        station: { id: chosen.id, name: chosen.name, lat: chosen.lat, lon: chosen.lon, distKm: chosen.distKm },
        data, ts: Date.now(),
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: err.message }) };
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

// Fixe Spalten: Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland Abgabe
// Stationsname kann Leerzeichen enthalten → von vorne & hinten tokenisieren.
function parseStationList(txt) {
  const lines = txt.split('\n').slice(2); // Header + Trennlinie überspringen
  const nowYear = new Date().getUTCFullYear();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 8) continue;
    const id = t[0];
    const bis = t[2];               // YYYYMMDD
    const lat = parseFloat(t[4]);
    const lon = parseFloat(t[5]);
    const abgabe = t[t.length - 1];
    if (!/^\d{5}$/.test(id) || !isFinite(lat) || !isFinite(lon)) continue;
    // nur aktive, frei abgebbare Stationen (bis-Datum im laufenden/letzten Jahr)
    const bisYear = parseInt(bis.slice(0, 4), 10);
    if (!(bisYear >= nowYear - 1)) continue;
    if (abgabe && abgabe.toLowerCase() !== 'frei') continue;
    const name = t.slice(6, t.length - 2).join(' ');
    out.push({ id, name, lat, lon });
  }
  return out;
}

async function fetchStationCsv(id) {
  const url = `${BASE}/stundenwerte_RR_${id}_akt.zip`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return extractCsvFromZip(buf);
  } catch { return null; }
}

/** Rudimentärer ZIP Local-File-Header-Parser, findet den produkt_rr CSV-Eintrag */
function extractCsvFromZip(buf) {
  const PK = 0x04034b50;
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) !== PK) { offset++; continue; }
    const fnLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const fn = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf8');
    const dataStart = offset + 30 + fnLen + extraLen;
    const compSize = buf.readUInt32LE(offset + 18);
    const compMethod = buf.readUInt16LE(offset + 8);
    if (fn.startsWith('produkt_rr_stunde_') && fn.endsWith('.txt')) {
      let data = buf.slice(dataStart, dataStart + compSize);
      if (compMethod === 8) {
        try { data = zlib.inflateRawSync(data); } catch { return null; }
      }
      return data.toString('latin1');
    }
    offset = dataStart + compSize;
  }
  return null;
}

/** DWD CSV → Array von { dt: ISO-String, mm: float } */
function parseCsv(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 4) continue;
    const rawDt = cols[1].trim(); // YYYYMMDDHH
    if (!/^\d{10}$/.test(rawDt)) continue;
    const dt = new Date(`${rawDt.slice(0,4)}-${rawDt.slice(4,6)}-${rawDt.slice(6,8)}T${rawDt.slice(8,10)}:00:00Z`).toISOString();
    const mm = parseFloat(cols[3].replace(',', '.'));
    result.push({ dt, mm: isNaN(mm) || mm < 0 ? 0 : mm });
  }
  return result;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
