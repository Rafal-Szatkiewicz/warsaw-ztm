import {MapboxOverlay} from '@deck.gl/mapbox';
import {Map} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {TripsLayer} from '@deck.gl/geo-layers';
import {ScatterplotLayer} from '@deck.gl/layers';

// --- KONFIGURACJA DANYCH ---
// Pobieraj dane GTFS-RT z https://mkuran.pl/gtfs/warsaw/vehicles.pb (brak API key)
const VEHICLES_PB_URL = '/api/ztm-proxy';
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';

// --- POMOCNICZA HISTORIA AUTOBUSÓW ----
// VehicleNumber -> [{lon, lat, time}]
const busHistory = {};
const HISTORY_LENGTH = 100; // ile pozycji historii trzymać (wydłużony ogon)

// Flaga do przełączania mocków
const USE_MOCK = false;

import * as protobuf from 'protobufjs';

let gtfsRoot = null;
async function loadGtfsProto() {
  if (gtfsRoot) return gtfsRoot;
  const res = await fetch(GTFS_PROTO_URL);
  const protoText = await res.text();
  gtfsRoot = protobuf.parse(protoText).root;
  return gtfsRoot;
}

async function fetchBusData() {
  try {
    // Pobierz plik protobuf
    const [root, pbRes] = await Promise.all([
      loadGtfsProto(),
      fetch(VEHICLES_PB_URL)
    ]);
    const buffer = await pbRes.arrayBuffer();
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    // Loguj zdekodowany FeedMessage jako JSON
    console.log("Fetched new data");
    // Wyciągnij pojazdy z pozycją
    const entities = message.entity || [];
    const now = Date.now();
    const buses = entities
      .filter(e => e.vehicle && e.vehicle.position)
      .map(e => ({
        VehicleNumber: e.vehicle.vehicle && e.vehicle.vehicle.id ? e.vehicle.vehicle.id : '',
        Lon: e.vehicle.position.longitude,
        Lat: e.vehicle.position.latitude,
        Lines: e.vehicle.trip && e.vehicle.trip.routeId ? e.vehicle.trip.routeId : '',
        Brigade: e.vehicle.vehicle && e.vehicle.vehicle.id ? e.vehicle.vehicle.id : '',
        Timestamp: (e.vehicle.timestamp ? e.vehicle.timestamp * 1000 : now)
      }))
      .filter(bus => bus.VehicleNumber !== 'V/10/9');

    // Aktualizuj historię pozycji
    buses.forEach(bus => {
      if (!bus.VehicleNumber) return;
      if (!busHistory[bus.VehicleNumber]) {
        // Pierwszy fetch: tylko jeden punkt, timestamp = teraz
        busHistory[bus.VehicleNumber] = [{lon: bus.Lon, lat: bus.Lat, time: now}];
        return;
      }
      const hist = busHistory[bus.VehicleNumber];
      const last = hist.length ? hist[hist.length-1] : null;
      // Dodaj nową pozycję tylko jeśli timestamp jest większy niż ostatni (uniknij duplikatów i cofania)
      if (last && bus.Timestamp <= last.time) {
        // Nie resetuj historii, po prostu pomiń ten punkt
        return;
      }
      // Dodaj nową pozycję tylko jeśli inna niż ostatnia (pozycja lub timestamp)
      if (!last || last.lon !== bus.Lon || last.lat !== bus.Lat || last.time !== bus.Timestamp) {
        hist.push({lon: bus.Lon, lat: bus.Lat, time: bus.Timestamp});
        if (hist.length > HISTORY_LENGTH) hist.shift();
      }
    });

    // Zwróć tablicę segmentów (każdy odcinek historii jako osobny trip)
    const trips = [];
    // Find the earliest timestamp for global zero
    let globalStart = Date.now();
    // buses.forEach(bus => {
    //   const hist = busHistory[bus.VehicleNumber] || [];
    //   for (let i = 1; i < hist.length; i++) {
    //     const prev = hist[i - 1];
    //     if (globalStart === null || prev.time < globalStart) globalStart = prev.time;
    //   }
    // });
    // if (!globalStart) globalStart = Date.now();
    // Każdy segment (przejście z punktu do punktu) to osobny trip
// Zamiast opierać się na "historycznym czasie", animujemy tylko nowy segment
const MIN_SEGMENT_DURATION = 8; // sekundy
const INTERP_POINTS = 10;
buses.forEach(bus => {
  const hist = busHistory[bus.VehicleNumber] || [];
  if (hist.length < 2) return;

  for (let i = 1; i < hist.length; i++) {
    const prev = hist[i - 1];
    const curr = hist[i];

    const path = [];
    for (let j = 0; j < INTERP_POINTS; j++) {
      const frac = j / (INTERP_POINTS - 1);
      const lon = prev.lon + (curr.lon - prev.lon) * frac;
      const lat = prev.lat + (curr.lat - prev.lat) * frac;
      path.push([lon, lat]);
    }

    // Dla ostatniego segmentu: pełna animacja
    // Dla wcześniejszych: timestamps "skończone", by nie animować
    const isLast = (i === hist.length - 1);
    const timestamps = isLast
      ? Array.from({ length: INTERP_POINTS }, (_, j) => (j / (INTERP_POINTS - 1)) * MIN_SEGMENT_DURATION)
      : Array(INTERP_POINTS).fill(0); // statyczny, nie animowany

    trips.push({
      path,
      timestamps,
      color: [255, 0, 0, 200],
      vehicle: bus
    });
  }
});


    return { trips, globalStart };
  } catch (e) {
    console.error('Błąd pobierania danych autobusów:', e);
    return [];
  }
}

async function init() {
  const map = new Map({
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [21.0122, 52.2297],
    zoom: 11,
    container: 'map',
  });

  // Dodaj element na tooltip
  let tooltipDiv = document.createElement('div');
  tooltipDiv.style.position = 'fixed';
  tooltipDiv.style.pointerEvents = 'none';
  tooltipDiv.style.background = 'rgba(0,0,0,0.85)';
  tooltipDiv.style.color = '#fff';
  tooltipDiv.style.padding = '4px 8px';
  tooltipDiv.style.borderRadius = '4px';
  tooltipDiv.style.fontSize = '14px';
  tooltipDiv.style.zIndex = 1000;
  tooltipDiv.style.display = 'none';
  document.body.appendChild(tooltipDiv);

  const overlay = new MapboxOverlay({
    layers: []
  });
  map.addControl(overlay);

  // Po zoomie odśwież warstwy, aby rozmiar punktów był aktualny, ale nie pobieraj nowych danych
  map.on('zoom', () => {
    // Odśwież warstwy z aktualnymi danymi i rozmiarem punktów
    // Wystarczy wywołać animate() raz, bo on i tak ustawia overlay.setProps
    animate();
  });

  // --- ANIMACJA I AKTUALIZACJA ---

  let animationFrame;
  let lastTripsData = [];
  let lastGlobalStart = null;
  let prevHeadPositions = {}; // VehicleNumber -> {lon, lat}
  let nextHeadPositions = {}; // VehicleNumber -> {lon, lat}
  let lastFetchTime = Date.now();
  let nextFetchTime = lastFetchTime + 10000;
  const FETCH_INTERVAL = 10000;
  const ANIMATION_INTERVAL = Math.round(FETCH_INTERVAL * 1.2); // animacja trwa dłużej niż fetch

  async function updateTrips() {
    const { trips: tripsData, globalStart } = await fetchBusData();
    lastTripsData = tripsData;
    lastGlobalStart = globalStart;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function animate() {
    // Global animation time: seconds since globalStart
    const nowSec = (Date.now() - (lastGlobalStart || Date.now())) / 1000;
    const maxDuration = 8;

    // TripsLayer expects a global currentTime, not per-trip
    const animatedTrips = lastTripsData;
    const globalCurrentTime = Math.min(nowSec, maxDuration);
    const tripsLayer = new TripsLayer({
      id: 'trips',
      data: animatedTrips,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: d => d.color,
      opacity: 0.85,
      widthMinPixels: 10,
      capRounded: true,
      jointRounded: true,
      trailLength: d => (d.timestamps[d.timestamps.length-1] - d.timestamps[0]) || 1,
      currentTime: globalCurrentTime,
      fadeTrail: false
    });
    // Scatter layer: show animated head of each bus
    // Odtwórz busSegments tylko na potrzeby scatterLayer
    const busSegments = {};
    for (const trip of lastTripsData) {
      const vehicleId = trip.vehicle && trip.vehicle.VehicleNumber;
      if (!vehicleId) continue;
      if (!busSegments[vehicleId]) busSegments[vehicleId] = [];
      busSegments[vehicleId].push(trip);
    }
    const busHeads = {};
    for (const segments of Object.values(busSegments)) {
      segments.sort((a, b) => a.timestamps[0] - b.timestamps[0]);
      let headPos = null;
      let vehicle = null;
      for (let i = 0; i < segments.length; i++) {
        const trip = segments[i];
        const start = trip.timestamps[0];
        const end = trip.timestamps[trip.timestamps.length - 1];
        vehicle = trip.vehicle;
        if (nowSec < start) {
          continue;
        } else if (nowSec >= end) {
          headPos = trip.path[trip.path.length - 1];
        } else {
          // Animowany segment
          const segTime = nowSec - start;
          let idx = trip.timestamps.findIndex(t => t > segTime + start);
          if (idx === -1 || idx === 0) {
            headPos = trip.path[trip.path.length - 1];
          } else {
            const t0 = trip.timestamps[idx - 1];
            const t1 = trip.timestamps[idx];
            const p0 = trip.path[idx - 1];
            const p1 = trip.path[idx];
            const frac = (segTime + start - t0) / (t1 - t0);
            headPos = [
              p0[0] + (p1[0] - p0[0]) * frac,
              p0[1] + (p1[1] - p0[1]) * frac
            ];
          }
          break;
        }
      }
      if (headPos && vehicle) {
        busHeads[vehicle.VehicleNumber] = { pos: headPos, vehicle };
      }
    }
    const scatterData = Object.values(busHeads).map(({ pos, vehicle }) => ({ pos, vehicle }));
    const scatterLayer = new ScatterplotLayer({
      id: 'bus-points',
      data: scatterData,
      getPosition: d => d.pos,
      getFillColor: [0, 128, 255, 200],
      getRadius: () => {
        if (map && typeof map.getZoom === 'function') {
          const zoom = map.getZoom();
          return Math.max(6, 60 / Math.pow(1.25, zoom - 10));
        }
        return 40;
      },
      radiusMinPixels: 2,
      pickable: true,
      opacity: 0.95,
      onHover: info => {
        if (info.object && info.object.vehicle && info.object.vehicle.VehicleNumber) {
          tooltipDiv.textContent = `ID: ${info.object.vehicle.VehicleNumber}`;
          tooltipDiv.style.left = info.x + 10 + 'px';
          tooltipDiv.style.top = info.y + 10 + 'px';
          tooltipDiv.style.display = 'block';
        } else {
          tooltipDiv.style.display = 'none';
        }
      }
    });
    overlay.setProps({
      layers: [tripsLayer, scatterLayer]
    });

      // 🛑 Zatrzymaj animację po 1 razie
    if (elapsedSec < maxDuration) {
      animationFrame = requestAnimationFrame(animate);
    }
  //   console.log('currentTime:', globalCurrentTime);
  // console.log('sample timestamps:', animatedTrips[0]?.timestamps);
  }

  await updateTrips();
  animate();
  setInterval(async () => {
    await updateTrips();
  }, FETCH_INTERVAL);
}

document.addEventListener('DOMContentLoaded', init);