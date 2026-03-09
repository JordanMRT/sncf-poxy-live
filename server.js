/**
 * SNCF Live Proxy — server.js v2
 *
 * Nouveautés :
 *  - Référentiel GTFS statique SNCF (stops, trips, routes)
 *    → noms lisibles des gares, coordonnées GPS réelles
 *    → numéros de trains lisibles (ex: "8504")
 *  - Filtrage strict sur le jour J (startDate)
 *  - Détection correcte TGV/INOUI/OUIGO/TER/IC
 *  - Endpoint /search?q=... pour la barre de recherche
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const AdmZip   = require('adm-zip');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════
// URLS
// ══════════════════════════════════════════════
const GTFS_STATIC_URL = 'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
const GTFS_RT_TRIPS   = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';
const GTFS_RT_ALERTS  = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts';

// ══════════════════════════════════════════════
// RÉFÉRENTIEL STATIQUE
// ══════════════════════════════════════════════
const ref = { stops: new Map(), trips: new Map(), routes: new Map(), loadedAt: 0 };
const STATIC_TTL = 24 * 60 * 60 * 1000;

async function loadGtfsStatic() {
  console.log('📦 Chargement GTFS statique SNCF...');
  try {
    const res = await fetch(GTFS_STATIC_URL, { timeout: 90000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.buffer();
    const zip = new AdmZip(buf);

    parseCSV(zip.readAsText('stops.txt')).forEach(r => {
      if (!r.stop_id) return;
      ref.stops.set(r.stop_id, {
        name: r.stop_name || r.stop_id,
        lat:  parseFloat(r.stop_lat) || null,
        lon:  parseFloat(r.stop_lon) || null,
      });
    });

    parseCSV(zip.readAsText('routes.txt')).forEach(r => {
      if (!r.route_id) return;
      ref.routes.set(r.route_id, {
        shortName: r.route_short_name || '',
        longName:  r.route_long_name  || '',
      });
    });

    parseCSV(zip.readAsText('trips.txt')).forEach(r => {
      if (!r.trip_id) return;
      ref.trips.set(r.trip_id, {
        shortName: r.trip_short_name || r.trip_headsign || '',
        routeId:   r.route_id || '',
        headsign:  r.trip_headsign || '',
      });
    });

    ref.loadedAt = Date.now();
    console.log(`✅ Statique OK: ${ref.stops.size} gares, ${ref.trips.size} courses, ${ref.routes.size} lignes`);
  } catch (err) {
    console.error('❌ Erreur GTFS statique:', err.message);
  }
}

function parseCSV(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

function splitLine(line) {
  const r = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') { q = !q; }
    else if (c === ',' && !q) { r.push(cur); cur = ''; }
    else cur += c;
  }
  r.push(cur);
  return r;
}

// Résolution d'un stopId GTFS-RT → info gare
// Les IDs RT peuvent être "StopPoint:OCETGV INOUI-87212027"
// → on extrait le code UIC 8 chiffres et on cherche dans ref.stops
function resolveStop(rawId) {
  if (!rawId) return null;
  if (ref.stops.has(rawId)) return ref.stops.get(rawId);
  const m = rawId.match(/(\d{7,8})$/);
  if (!m) return null;
  const uic = m[1];
  for (const [id, s] of ref.stops) {
    if (id.endsWith(uic)) return s;
  }
  // tentative avec 7 derniers chiffres
  for (const [id, s] of ref.stops) {
    if (id.includes(uic)) return s;
  }
  return null;
}

// ══════════════════════════════════════════════
// TYPE DE TRAIN
// ══════════════════════════════════════════════
function guessType(tripId, routeId, shortName) {
  const s = `${tripId} ${routeId} ${shortName}`.toUpperCase();
  if (s.match(/OUIGO|INOUI|LYRIA|EUROSTAR|THALYS|TGV/)) return 'TGV';
  if (s.match(/INTERCIT|INTERCITÉS/))                    return 'IC';
  if (s.match(/TER|TRAIN TER/))                          return 'TER';
  // Déduction par numéro de train
  const n = shortName.replace(/\D/g, '');
  if (n.length === 4 && ['6','8'].includes(n[0]))        return 'TGV';
  if (n.length === 4 && n[0] === '3')                    return 'IC';
  return 'TER';
}

// Sous-marque commerciale extraite du tripId / routeId
function extractBrand(tripId, routeId, shortName) {
  const s = `${tripId} ${routeId} ${shortName}`.toUpperCase();
  if (s.includes('OUIGO'))    return 'OUIGO';
  if (s.includes('INOUI'))    return 'inoui';
  if (s.includes('LYRIA'))    return 'Lyria';
  if (s.includes('EUROSTAR')) return 'Eurostar';
  if (s.includes('THALYS'))   return 'Thalys';
  return null;
}

// Numéro lisible depuis le tripId SNCF
// "OCESN8504F3823199:2025..." → "8504"
function extractNum(tripId) {
  const m = tripId.match(/OCESN(\d+)F/);
  if (m) return m[1];
  const m2 = tripId.match(/:(\d{4,6}):/);
  if (m2) return m2[1];
  return tripId.split(':')[0].replace(/^OCESN/, '').replace(/F.*/, '') || '?';
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function toISO(ts) {
  try { const t = (typeof ts === 'object') ? ts.low : ts; return new Date(t * 1000).toISOString(); }
  catch { return null; }
}

function schedStr(v) {
  return ({0:'SCHEDULED',1:'ADDED',2:'UNSCHEDULED',3:'CANCELED',5:'REPLACEMENT'})[v] ?? 'SCHEDULED';
}

function getRtStatus(schedRel, maxDelaySec, stops) {
  if (schedRel === 3) return 'NO_SERVICE';
  if (stops.some(s => s.scheduleRelationship === 'SKIPPED' || s.scheduleRelationship === 'ADDED')) return 'MODIFIED_SERVICE';
  if (maxDelaySec > 300) return 'SIGNIFICANT_DELAYS';
  return 'NO_DISRUPTION';
}

function causeName(v) {
  return ({0:'UNKNOWN_CAUSE',1:'OTHER_CAUSE',2:'TECHNICAL_PROBLEM',3:'STRIKE',4:'DEMONSTRATION',
           5:'ACCIDENT',6:'HOLIDAY',7:'WEATHER',8:'MAINTENANCE',9:'CONSTRUCTION',
           10:'POLICE_ACTIVITY',11:'MEDICAL_EMERGENCY'})[v] ?? 'UNKNOWN_CAUSE';
}

function effectName(v) {
  return ({0:'NO_SERVICE',1:'REDUCED_SERVICE',2:'SIGNIFICANT_DELAYS',3:'DETOUR',
           4:'ADDITIONAL_SERVICE',5:'MODIFIED_SERVICE',6:'OTHER_EFFECT',7:'UNKNOWN_EFFECT',
           8:'STOP_MOVED',9:'NO_EFFECT',10:'ACCESSIBILITY_ISSUE'})[v] ?? 'UNKNOWN_EFFECT';
}

function getSeverity(cause, effect) {
  if (effect === 0) return 'blocking';
  if (effect === 2 || cause === 3) return 'significant';
  return 'info';
}

function extractText(obj) {
  if (!obj?.translation?.length) return null;
  const fr = obj.translation.find(t => t.language === 'fr');
  return (fr || obj.translation[0])?.text || null;
}

// ══════════════════════════════════════════════
// PARSE GTFS-RT
// ══════════════════════════════════════════════
async function fetchGtfsRt(url) {
  const res = await fetch(url, { headers:{ 'Accept':'application/x-protobuf' }, timeout:15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

function parseTripUpdates(feed) {
  const today  = todayStr();
  const trains = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const tu   = entity.tripUpdate;
    const trip = tu.trip || {};

    // Filtre jour J
    if (trip.startDate && trip.startDate !== today) continue;

    const rawTripId  = trip.tripId || '';
    const staticTrip = ref.trips.get(rawTripId);
    const routeId    = staticTrip?.routeId || trip.routeId || '';
    const route      = ref.routes.get(routeId);
    const shortNum   = staticTrip?.shortName || extractNum(rawTripId);
    const type       = guessType(rawTripId, routeId, shortNum);
    const brand      = extractBrand(rawTripId, routeId, shortNum);

    let maxDelay = 0;
    const stops = (tu.stopTimeUpdate || []).map(s => {
      const info     = resolveStop(s.stopId);
      const arrDelay = s.arrival?.delay  || 0;
      const depDelay = s.departure?.delay || 0;
      const delay    = Math.max(arrDelay, depDelay);
      if (delay > maxDelay) maxDelay = delay;
      return {
        stopId:    s.stopId,
        stopName:  info?.name || s.stopId?.match(/(\d{7,8})$/)?.[1] || s.stopId || '?',
        lat:       info?.lat  || null,
        lon:       info?.lon  || null,
        sequence:  s.stopSequence || 0,
        arrival:   { delay: arrDelay, time: s.arrival?.time   ? toISO(s.arrival.time)   : null },
        departure: { delay: depDelay, time: s.departure?.time ? toISO(s.departure.time) : null },
        scheduleRelationship: schedStr(s.scheduleRelationship),
      };
    });

    // Position : on prend la gare du milieu avec coordonnées
    const withCoords = stops.filter(s => s.lat && s.lon);
    const posStop    = withCoords[Math.floor(withCoords.length / 2)] || null;

    const first = stops[0];
    const last  = stops[stops.length - 1];

    trains.push({
      id:         entity.id,
      tripId:     rawTripId,
      num:        shortNum,
      type,
      brand,
      routeName:  route?.shortName || route?.longName || '',
      startDate:  trip.startDate || today,
      startTime:  trip.startTime || '',
      from:       first?.stopName || '?',
      fromTime:   first?.departure?.time || first?.arrival?.time || null,
      to:         last?.stopName  || '?',
      toTime:     last?.arrival?.time || null,
      lat:        posStop?.lat || null,
      lon:        posStop?.lon || null,
      delay:      Math.round(maxDelay / 60),
      delaySeconds: maxDelay,
      rtStatus:   getRtStatus(trip.scheduleRelationship, maxDelay, stops),
      scheduleRelationship: schedStr(trip.scheduleRelationship),
      stops,
      timestamp:  tu.timestamp ? toISO(tu.timestamp) : null,
    });
  }

  // DEBUG temporaire — à retirer après
const tgvs = trains.filter(t => t.type === 'TGV').slice(0, 3);
tgvs.forEach(t => {
  console.log('🔍 TGV DEBUG:', JSON.stringify({
    tripId: t.tripId,
    routeId: t.routeName,
    firstStopId: t.stops?.[0]?.stopId,
    brand: t.brand
  }));
});

  return trains;
}

function parseAlerts(feed) {
  return feed.entity.filter(e => e.alert).map(entity => {
    const a = entity.alert;
    return {
      id:          entity.id,
      cause:       causeName(a.cause),
      effect:      effectName(a.effect),
      severity:    getSeverity(a.cause, a.effect),
      headerText:  extractText(a.headerText),
      description: extractText(a.descriptionText),
      affected:    (a.informedEntity || []).map(e => ({ routeId: e.routeId||null, tripId: e.trip?.tripId||null, stopId: e.stopId||null })),
      activePeriods: (a.activePeriod || []).map(p => ({ start: p.start ? toISO(p.start) : null, end: p.end ? toISO(p.end) : null })),
    };
  });
}

// ══════════════════════════════════════════════
// CACHE RT 60s
// ══════════════════════════════════════════════
const RT_TTL = 60 * 1000;
let rtCache  = { trains: null, alerts: null, updatedAt: 0 };

async function refreshRt() {
  console.log(`[${new Date().toISOString()}] Refresh GTFS-RT...`);
  try {
    const [tf, af] = await Promise.all([fetchGtfsRt(GTFS_RT_TRIPS), fetchGtfsRt(GTFS_RT_ALERTS)]);
    rtCache.trains    = parseTripUpdates(tf);
    rtCache.alerts    = parseAlerts(af);
    rtCache.updatedAt = Date.now();
    console.log(`✅ RT: ${rtCache.trains.length} trains aujourd'hui, ${rtCache.alerts.length} alertes`);
  } catch (err) {
    console.error('❌ Erreur RT:', err.message);
  }
}

async function getCache() {
  if (!rtCache.trains || Date.now() - rtCache.updatedAt > RT_TTL) await refreshRt();
  return rtCache;
}

// ══════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════
app.get('/health', (req, res) => res.json({
  status:     'ok',
  uptime:     Math.round(process.uptime()) + 's',
  gtfsStops:  ref.stops.size,
  gtfsTrips:  ref.trips.size,
  gtfsRoutes: ref.routes.size,
  cacheAge:   rtCache.updatedAt ? Math.round((Date.now()-rtCache.updatedAt)/1000)+'s' : 'vide',
  trainCount: rtCache.trains?.length ?? 0,
  today:      todayStr(),
}));

app.get('/trains', async (req, res) => {
  try {
    const data = await getCache();
    let trains = data.trains;
    const { type, status, minDelay, limit } = req.query;
    if (type)     trains = trains.filter(t => t.type === type.toUpperCase());
    if (status)   trains = trains.filter(t => t.rtStatus === status.toUpperCase());
    if (minDelay) trains = trains.filter(t => t.delay >= parseInt(minDelay));
    if (limit)    trains = trains.slice(0, parseInt(limit));
    res.json({ updatedAt: new Date(data.updatedAt).toISOString(), cacheAgeSec: Math.round((Date.now()-data.updatedAt)/1000), today: todayStr(), count: trains.length, trains });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/trains/:id', async (req, res) => {
  try {
    const data  = await getCache();
    const train = data.trains.find(t => t.id === req.params.id || t.tripId === req.params.id || t.num === req.params.id);
    if (!train) return res.status(404).json({ error: 'Train non trouvé' });
    res.json(train);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/alerts', async (req, res) => {
  try {
    const data = await getCache();
    res.json({ updatedAt: new Date(data.updatedAt).toISOString(), count: data.alerts.length, alerts: data.alerts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/summary', async (req, res) => {
  try {
    const data = await getCache();
    res.json({
      updatedAt: new Date(data.updatedAt).toISOString(), today: todayStr(),
      stats: {
        total:     data.trains.length,
        onTime:    data.trains.filter(t=>t.delay===0&&t.rtStatus==='NO_DISRUPTION').length,
        delayed:   data.trains.filter(t=>t.delay>0).length,
        cancelled: data.trains.filter(t=>t.rtStatus==='NO_SERVICE').length,
        modified:  data.trains.filter(t=>t.rtStatus==='MODIFIED_SERVICE').length,
        byType: {
          TGV: data.trains.filter(t=>t.type==='TGV').length,
          TER: data.trains.filter(t=>t.type==='TER').length,
          IC:  data.trains.filter(t=>t.type==='IC').length,
        },
      },
      alerts: data.alerts.slice(0, 10),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ results: [] });
    const data    = await getCache();
    const results = data.trains.filter(t =>
      t.num.toLowerCase().includes(q) ||
      t.from.toLowerCase().includes(q) ||
      t.to.toLowerCase().includes(q) ||
      (`${t.type} ${t.num}`).toLowerCase().includes(q)
    ).slice(0, 20);
    res.json({ query: q, count: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`🚄 SNCF Proxy v2 — port ${PORT}`);
  await loadGtfsStatic();
  await refreshRt();
  setInterval(refreshRt, RT_TTL);
  setInterval(loadGtfsStatic, STATIC_TTL);
});
