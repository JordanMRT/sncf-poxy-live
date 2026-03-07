/**
 * SNCF Live Proxy — server.js
 * Récupère les flux GTFS-RT SNCF (protobuf),
 * les décode en JSON et les expose via une API REST.
 *
 * Endpoints disponibles :
 *   GET /trains        → liste tous les trains en circulation
 *   GET /trains/:id    → détail d'un train par son ID
 *   GET /health        → statut du serveur
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS : autorise toutes les origines (adapter en prod si besoin) ───
app.use(cors());
app.use(express.json());

// ─── URLs des flux GTFS-RT SNCF (open data transport.data.gouv.fr) ───
const URLS = {
  tripUpdates: 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates',
  alerts:      'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts',
};

// ─── Cache en mémoire (évite de surcharger l'API SNCF) ───
const CACHE_TTL = 60 * 1000; // 60 secondes
let cache = {
  trains:    null,
  alerts:    null,
  updatedAt: 0,
};

// ─────────────────────────────────────────────────────────────
// Décodage du flux GTFS-RT protobuf
// ─────────────────────────────────────────────────────────────
async function fetchGtfsRt(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/x-protobuf' },
    timeout: 10000,
  });

  if (!res.ok) throw new Error(`Erreur HTTP ${res.status} sur ${url}`);

  const buffer = await res.arrayBuffer();
  const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );
  return feed;
}

// ─────────────────────────────────────────────────────────────
// Traitement des TripUpdates → liste de trains
// ─────────────────────────────────────────────────────────────
function parseTripUpdates(feed) {
  const trains = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;

    const tu      = entity.tripUpdate;
    const trip    = tu.trip || {};
    const stops   = tu.stopTimeUpdate || [];

    // Calcul du retard max sur les arrêts à venir
    let maxDelay = 0;
    const parsedStops = stops.map(s => {
      const arrDelay = s.arrival?.delay  || 0;
      const depDelay = s.departure?.delay || 0;
      const delay    = Math.max(arrDelay, depDelay);
      if (delay > maxDelay) maxDelay = delay;

      return {
        stopId:       s.stopId || null,
        stopSequence: s.stopSequence || 0,
        arrival: {
          delay:       arrDelay,
          time:        s.arrival?.time   ? toISO(s.arrival.time)   : null,
          uncertainty: s.arrival?.uncertainty || null,
        },
        departure: {
          delay:       depDelay,
          time:        s.departure?.time ? toISO(s.departure.time) : null,
          uncertainty: s.departure?.uncertainty || null,
        },
        scheduleRelationship: scheduleRelStr(s.scheduleRelationship),
      };
    });

    // Déduction du statut global
    const rtStatus = getRtStatus(trip.scheduleRelationship, maxDelay, parsedStops);

    trains.push({
      id:          entity.id,
      tripId:      trip.tripId      || null,
      routeId:     trip.routeId     || null,
      directionId: trip.directionId ?? null,
      startDate:   trip.startDate   || null,
      startTime:   trip.startTime   || null,
      delay:       Math.round(maxDelay / 60), // en minutes
      delaySeconds: maxDelay,
      rtStatus,
      scheduleRelationship: scheduleRelStr(trip.scheduleRelationship),
      stops: parsedStops,
      timestamp: tu.timestamp ? toISO(tu.timestamp) : null,
    });
  }

  return trains;
}

// ─────────────────────────────────────────────────────────────
// Traitement des Service Alerts → perturbations
// ─────────────────────────────────────────────────────────────
function parseAlerts(feed) {
  const alerts = [];

  for (const entity of feed.entity) {
    if (!entity.alert) continue;
    const a = entity.alert;

    // Entités affectées (routes, trips, stops…)
    const affected = (a.informedEntity || []).map(e => ({
      routeId: e.routeId || null,
      tripId:  e.trip?.tripId || null,
      stopId:  e.stopId || null,
    }));

    // Traduction de la cause et de l'effet
    const cause  = causeName(a.cause);
    const effect = effectName(a.effect);

    // Messages disponibles (fr en priorité)
    const headerText  = extractText(a.headerText);
    const description = extractText(a.descriptionText);

    // Fenêtres d'activité
    const activePeriods = (a.activePeriod || []).map(p => ({
      start: p.start ? toISO(p.start) : null,
      end:   p.end   ? toISO(p.end)   : null,
    }));

    alerts.push({
      id: entity.id,
      cause,
      effect,
      headerText,
      description,
      affected,
      activePeriods,
      severity: getSeverity(a.cause, a.effect),
    });
  }

  return alerts;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function toISO(timestamp) {
  try {
    const t = typeof timestamp === 'object' ? timestamp.low : timestamp;
    return new Date(t * 1000).toISOString();
  } catch { return null; }
}

function scheduleRelStr(val) {
  const map = { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT' };
  return map[val] ?? 'SCHEDULED';
}

function getRtStatus(schedRel, maxDelaySeconds, stops) {
  if (schedRel === 3) return 'NO_SERVICE';
  const hasSkipped = stops.some(s => s.scheduleRelationship === 'SKIPPED');
  const hasAdded   = stops.some(s => s.scheduleRelationship === 'ADDED');
  if (hasSkipped || hasAdded) return 'MODIFIED_SERVICE';
  if (maxDelaySeconds > 300) return 'SIGNIFICANT_DELAYS'; // > 5 min
  return 'NO_DISRUPTION';
}

function causeName(val) {
  const map = {
    0: 'UNKNOWN_CAUSE', 1: 'OTHER_CAUSE', 2: 'TECHNICAL_PROBLEM',
    3: 'STRIKE', 4: 'DEMONSTRATION', 5: 'ACCIDENT', 6: 'HOLIDAY',
    7: 'WEATHER', 8: 'MAINTENANCE', 9: 'CONSTRUCTION',
    10: 'POLICE_ACTIVITY', 11: 'MEDICAL_EMERGENCY',
  };
  return map[val] ?? 'UNKNOWN_CAUSE';
}

function effectName(val) {
  const map = {
    0: 'NO_SERVICE', 1: 'REDUCED_SERVICE', 2: 'SIGNIFICANT_DELAYS',
    3: 'DETOUR', 4: 'ADDITIONAL_SERVICE', 5: 'MODIFIED_SERVICE',
    6: 'OTHER_EFFECT', 7: 'UNKNOWN_EFFECT', 8: 'STOP_MOVED',
    9: 'NO_EFFECT', 10: 'ACCESSIBILITY_ISSUE',
  };
  return map[val] ?? 'UNKNOWN_EFFECT';
}

function getSeverity(cause, effect) {
  if (effect === 0) return 'blocking';            // NO_SERVICE
  if (effect === 2 || cause === 3) return 'significant'; // DELAYS ou STRIKE
  return 'info';
}

function extractText(textObj) {
  if (!textObj?.translation?.length) return null;
  const fr = textObj.translation.find(t => t.language === 'fr');
  return (fr || textObj.translation[0])?.text || null;
}

// ─────────────────────────────────────────────────────────────
// Refresh du cache
// ─────────────────────────────────────────────────────────────
async function refreshCache() {
  console.log(`[${new Date().toISOString()}] Refresh du cache GTFS-RT...`);
  try {
    const [tripFeed, alertFeed] = await Promise.all([
      fetchGtfsRt(URLS.tripUpdates),
      fetchGtfsRt(URLS.alerts),
    ]);

    cache.trains    = parseTripUpdates(tripFeed);
    cache.alerts    = parseAlerts(alertFeed);
    cache.updatedAt = Date.now();

    console.log(`✅ Cache mis à jour : ${cache.trains.length} trains, ${cache.alerts.length} alertes`);
  } catch (err) {
    console.error('❌ Erreur refresh cache :', err.message);
    // On garde l'ancien cache en cas d'erreur
  }
}

async function getCache() {
  if (!cache.trains || Date.now() - cache.updatedAt > CACHE_TTL) {
    await refreshCache();
  }
  return cache;
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// Santé du serveur
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    uptime:    Math.round(process.uptime()),
    cacheAge:  cache.updatedAt ? Math.round((Date.now() - cache.updatedAt) / 1000) + 's' : 'vide',
    trainCount: cache.trains?.length ?? 0,
    alertCount: cache.alerts?.length ?? 0,
  });
});

// Tous les trains
app.get('/trains', async (req, res) => {
  try {
    const data = await getCache();

    let trains = data.trains;

    // Filtres optionnels via query params
    const { type, status, minDelay, maxDelay, limit } = req.query;

    if (type)     trains = trains.filter(t => t.routeId?.toUpperCase().includes(type.toUpperCase()));
    if (status)   trains = trains.filter(t => t.rtStatus === status.toUpperCase());
    if (minDelay) trains = trains.filter(t => t.delay >= parseInt(minDelay));
    if (maxDelay) trains = trains.filter(t => t.delay <= parseInt(maxDelay));
    if (limit)    trains = trains.slice(0, parseInt(limit));

    res.json({
      updatedAt:  new Date(data.updatedAt).toISOString(),
      cacheAgeSec: Math.round((Date.now() - data.updatedAt) / 1000),
      count:      trains.length,
      trains,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// Un train par ID
app.get('/trains/:id', async (req, res) => {
  try {
    const data  = await getCache();
    const train = data.trains.find(t => t.id === req.params.id || t.tripId === req.params.id);
    if (!train) return res.status(404).json({ error: 'Train non trouvé' });
    res.json(train);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// Alertes / perturbations
app.get('/alerts', async (req, res) => {
  try {
    const data = await getCache();
    res.json({
      updatedAt: new Date(data.updatedAt).toISOString(),
      count:     data.alerts.length,
      alerts:    data.alerts,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// Résumé global (trains + alertes en un seul appel)
app.get('/summary', async (req, res) => {
  try {
    const data = await getCache();
    const disrupted  = data.trains.filter(t => t.rtStatus !== 'NO_DISRUPTION').length;
    const cancelled  = data.trains.filter(t => t.rtStatus === 'NO_SERVICE').length;
    const delayed    = data.trains.filter(t => t.delay > 0).length;
    const onTime     = data.trains.filter(t => t.delay === 0 && t.rtStatus === 'NO_DISRUPTION').length;

    res.json({
      updatedAt:  new Date(data.updatedAt).toISOString(),
      stats: { total: data.trains.length, onTime, delayed, cancelled, disrupted },
      alerts: data.alerts.slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚄 SNCF Proxy démarré sur le port ${PORT}`);
  // Premier chargement du cache au démarrage
  await refreshCache();
  // Refresh automatique toutes les 60 secondes
  setInterval(refreshCache, CACHE_TTL);
});
