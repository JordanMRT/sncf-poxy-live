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

const express    = require('express');
const cors       = require('cors');
const compression = require('compression');
const fetch      = require('node-fetch');
const https      = require('https');
const AdmZip     = require('adm-zip');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(compression()); // gzip — les payloads /trains peuvent peser plusieurs centaines de Ko
app.use(express.json());

// Agent HTTPS keep-alive — réutilise les connexions TCP/TLS vers transport.data.gouv.fr
// au lieu d'en ouvrir une nouvelle à chaque refresh (gain surtout sur Render où le froid coûte cher)
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const fetchKA = (url, opts = {}) => fetch(url, { ...opts, agent: keepAliveAgent });

// ══════════════════════════════════════════════
// URLS
// ══════════════════════════════════════════════
const GTFS_STATIC_URL = 'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
const GTFS_RT_TRIPS   = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';
const GTFS_RT_ALERTS  = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts';

// ══════════════════════════════════════════════
// RÉFÉRENTIEL STATIQUE
// ══════════════════════════════════════════════
const ref = { stops: new Map(), uic: new Map(), trips: new Map(), routes: new Map(), loadedAt: 0 };
const stopCache = new Map(); // mémoïsation resolveStop (rawId → gare | null)
const STATIC_TTL = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Charge le GTFS statique SANS bloquer la boucle d'événements trop longtemps.
// Les 3 maps sont construites à part puis échangées d'un coup à la fin :
// aucune requête ne voit un référentiel à moitié rempli.
// Retourne true si le chargement a réussi.
async function loadGtfsStatic() {
  console.log('📦 Chargement GTFS statique SNCF...');
  try {
    const res = await fetchKA(GTFS_STATIC_URL, { timeout: 120000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zip = new AdmZip(await res.buffer());

    const stops = new Map(), uic = new Map(), routes = new Map(), trips = new Map();

    await parseCSVBuffer(zip.readFile('stops.txt'), ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], r => {
      if (!r.stop_id) return;
      const info = { name: r.stop_name || r.stop_id, lat: parseFloat(r.stop_lat) || null, lon: parseFloat(r.stop_lon) || null };
      stops.set(r.stop_id, info);
      // Index par code UIC (7-8 derniers chiffres) → résolution O(1) au lieu d'un scan de toutes les gares
      const m = r.stop_id.match(/(\d{7,8})$/);
      if (m && !uic.has(m[1])) uic.set(m[1], info);
    });

    await parseCSVBuffer(zip.readFile('routes.txt'), ['route_id', 'route_short_name', 'route_long_name'], r => {
      if (!r.route_id) return;
      routes.set(r.route_id, { shortName: r.route_short_name || '', longName: r.route_long_name || '' });
    });

    // trips.txt est de loin le plus gros fichier : on ne garde que le strict nécessaire
    await parseCSVBuffer(zip.readFile('trips.txt'), ['trip_id', 'trip_short_name', 'trip_headsign', 'route_id'], r => {
      if (!r.trip_id) return;
      trips.set(r.trip_id, { shortName: r.trip_short_name || r.trip_headsign || '', routeId: r.route_id || '' });
    });

    ref.stops = stops; ref.uic = uic; ref.routes = routes; ref.trips = trips;
    stopCache.clear();
    ref.loadedAt = Date.now();
    console.log(`✅ Statique OK: ${stops.size} gares, ${trips.size} courses, ${routes.size} lignes`);
    return true;
  } catch (err) {
    console.error('❌ Erreur GTFS statique:', err.message);
    return false;
  }
}

// Parse un CSV directement depuis le Buffer, ligne par ligne (pas de split géant du
// fichier entier en mémoire) et rend la main à la boucle d'événements tous les 3000
// lignes pour que /health et les requêtes restent réactifs pendant le chargement.
async function parseCSVBuffer(buf, wanted, onRow) {
  if (!buf) return;
  const len = buf.length;
  let eol = buf.indexOf(10);
  if (eol === -1) return;
  const headers = splitLine(buf.toString('utf8', 0, eol).replace(/^\uFEFF/, '').replace(/\r$/, '')).map(h => h.trim());
  const idx = wanted.map(w => [w, headers.indexOf(w)]).filter(([, i]) => i !== -1);
  let pos = eol + 1, n = 0;
  while (pos < len) {
    eol = buf.indexOf(10, pos);
    if (eol === -1) eol = len;
    const end = (eol > pos && buf[eol - 1] === 13) ? eol - 1 : eol;
    if (end > pos) {
      const vals = splitLine(buf.toString('utf8', pos, end));
      const row = {};
      for (const [name, i] of idx) row[name] = (vals[i] || '').trim();
      onRow(row);
    }
    pos = eol + 1;
    if (++n % 3000 === 0) await new Promise(r => setImmediate(r));
  }
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
// → on extrait le code UIC et on le cherche dans l'index (O(1), mémoïsé)
let stopMiss = 0; // gares non résolues sur le dernier parse (diagnostic)
function resolveStop(rawId) {
  if (!rawId) return null;
  if (stopCache.has(rawId)) return stopCache.get(rawId);
  let info = ref.stops.get(rawId) || null;
  if (!info) {
    const m = rawId.match(/(\d{7,8})$/);
    if (m) info = ref.uic.get(m[1]) || null;
  }
  stopCache.set(rawId, info);
  return info;
}

// ══════════════════════════════════════════════
// TYPE ET MARQUE DU TRAIN
// ══════════════════════════════════════════════
// Résout type (TGV/IC/TER) ET brand (inoui/OUIGO/…) en une passe
// pour éviter la désynchronisation entre les deux fonctions.
// firstStopId contient la marque encodée par SNCF : "StopPoint:OCETGV INOUI-87212027"
function resolveTypeAndBrand(tripId, routeId, shortName, firstStopId) {
  const s = `${tripId} ${routeId} ${shortName} ${firstStopId || ''}`.toUpperCase();

  // Marque détectée en priorité depuis firstStopId
  let brand = null;
  if (s.includes('OUIGO'))    brand = 'OUIGO';
  else if (s.includes('INOUI'))    brand = 'inoui';
  else if (s.includes('LYRIA'))    brand = 'Lyria';
  else if (s.includes('EUROSTAR')) brand = 'Eurostar';
  else if (s.includes('THALYS'))   brand = 'Thalys';

  // Type déduit — si une brand TGV connue est détectée, c'est forcément un TGV
  let type;
  if (brand || s.match(/TGV/)) {
    type = 'TGV';
  } else if (s.match(/INTERCIT|INTERCITÉS/)) {
    type = 'IC';
  } else if (s.match(/TER|TRAIN TER/)) {
    type = 'TER';
  } else {
    // Déduction par numéro de train
    const n = shortName.replace(/\D/g, '');
    if (n.length === 4 && ['6','8'].includes(n[0])) type = 'TGV';
    else if (n.length === 4 && n[0] === '3')        type = 'IC';
    else                                             type = 'TER';
  }

  return { type, brand };
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
// Date du jour en heure de Paris : Render tourne en UTC, ce qui décalait le « jour J »
// (et faisait disparaître les trains) entre minuit et 1h/2h du matin en France.
const parisDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
function todayStr() {
  return parisDate.format(new Date()).replace(/-/g, '');
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
  const res = await fetchKA(url, { headers:{ 'Accept':'application/x-protobuf' }, timeout:15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

function parseTripUpdates(feed) {
  const today  = todayStr();
  const trains = [];
  stopMiss = 0;

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
    const shortNum    = staticTrip?.shortName || extractNum(rawTripId);
    // firstStopId contient "StopPoint:OCETGV INOUI-..." → source fiable de type+marque
    const firstStopId = tu.stopTimeUpdate?.[0]?.stopId || '';
    const { type, brand } = resolveTypeAndBrand(rawTripId, routeId, shortNum, firstStopId);

    let maxDelay = 0;
    const stops = (tu.stopTimeUpdate || []).map(s => {
      const info     = resolveStop(s.stopId);
      if (!info) stopMiss++;
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
let rtCache  = { trains: null, alerts: null, updatedAt: 0, lastError: null };
let refreshInFlight = null; // verrou unique : timer et requêtes partagent le même refresh en cours

async function doRefresh() {
  console.log(`[${new Date().toISOString()}] Refresh GTFS-RT...`);
  try {
    const [tf, af] = await Promise.all([fetchGtfsRt(GTFS_RT_TRIPS), fetchGtfsRt(GTFS_RT_ALERTS)]);
    rtCache.trains    = parseTripUpdates(tf);
    rtCache.alerts    = parseAlerts(af);
    rtCache.updatedAt = Date.now();
    rtCache.lastError = null;
    console.log(`✅ RT: ${rtCache.trains.length} trains aujourd'hui, ${rtCache.alerts.length} alertes, ${stopMiss} arrêts sans nom`);
  } catch (err) {
    rtCache.lastError = err.message;
    console.error('❌ Erreur RT:', err.message);
  }
}

function refreshRt() {
  if (!refreshInFlight) refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

const isReady = () => !!(ref.loadedAt && rtCache.trains);

// Données prêtes → on répond tout de suite (même si un peu périmées, le timer rafraîchit
// en arrière-plan). Pas prêt → erreur « warming » (503) au lieu de laisser la requête
// pendre pendant le chargement : le client réessaie dans quelques secondes.
async function getCache() {
  if (!isReady()) {
    if (ref.loadedAt) await refreshRt();      // statique OK, première RT manquante
    if (!isReady()) { const e = new Error('Serveur en cours de démarrage'); e.warming = true; throw e; }
  } else if (Date.now() - rtCache.updatedAt > RT_TTL * 2) {
    refreshRt();                              // données trop vieilles : refresh en arrière-plan
  }
  return rtCache;
}

function fail(res, err) {
  res.set('Cache-Control', 'no-store');
  if (err.warming) {
    res.set('Retry-After', '5');
    return res.status(503).json({ warming: true, error: err.message, retryAfter: 5 });
  }
  res.status(500).json({ error: err.message });
}

// ══════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════
// Les données ne changent pas plus vite que le cache RT (60s) — autant laisser
// le navigateur / un éventuel CDN éviter de re-solliciter le serveur entre-temps.
function cacheHeaders(req, res, next) {
  res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
  next();
}
app.use(['/trains', '/alerts', '/summary', '/search'], cacheHeaders);

app.get('/health', (req, res) => res.json({
  status:     isReady() ? 'ok' : 'warming',
  ready:      isReady(),
  lastError:  rtCache.lastError,
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
  } catch (err) { fail(res, err); }
});

app.get('/trains/:id', async (req, res) => {
  try {
    const data  = await getCache();
    const train = data.trains.find(t => t.id === req.params.id || t.tripId === req.params.id || t.num === req.params.id);
    if (!train) return res.status(404).json({ error: 'Train non trouvé' });
    res.json(train);
  } catch (err) { fail(res, err); }
});

app.get('/alerts', async (req, res) => {
  try {
    const data = await getCache();
    res.json({ updatedAt: new Date(data.updatedAt).toISOString(), count: data.alerts.length, alerts: data.alerts });
  } catch (err) { fail(res, err); }
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
  } catch (err) { fail(res, err); }
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
  } catch (err) { fail(res, err); }
});

// ══════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════
process.on('unhandledRejection', err => console.error('⚠️ unhandledRejection:', err && err.message || err));
process.on('uncaughtException',  err => console.error('⚠️ uncaughtException:',  err && err.message || err));

async function bootData() {
  // Réessaie le chargement statique tant qu'il échoue (avant : un échec = plus aucune
  // donnée exploitable pendant 24 h, jusqu'au prochain redémarrage)
  let wait = 15000;
  while (!(await loadGtfsStatic())) {
    console.log(`↻ Nouvel essai GTFS statique dans ${wait / 1000}s`);
    await sleep(wait);
    wait = Math.min(wait * 2, 5 * 60 * 1000);
  }
  await refreshRt();
  setInterval(refreshRt, RT_TTL);
  setInterval(loadGtfsStatic, STATIC_TTL);
}

app.listen(PORT, () => {
  console.log(`🚄 SNCF Proxy v2 — port ${PORT}`);
  bootData();
});
