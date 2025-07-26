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

// Przykładowe dane testowe (kilka autobusów)
const mockBuses = [
  {VehicleNumber: '1000', Lon: 21.0122, Lat: 52.2297, Lines: '225'},
  {VehicleNumber: '1001', Lon: 21.0222, Lat: 52.2397, Lines: '219'},
  {VehicleNumber: '1002', Lon: 21.0322, Lat: 52.2197, Lines: '161'}
];
// Przykładowe trasy dla każdego autobusu (każdy punkt co 10 sekund)
const mockRoutes = [
  // Autobus 1: zakręty, pętla
  [
    [21.0122, 52.2297], [21.0135, 52.2310], [21.0150, 52.2300], [21.0165, 52.2315], [21.0180, 52.2290], [21.0122, 52.2297]
  ],
  // Autobus 2: zygzak
  [
    [21.0222, 52.2397], [21.0230, 52.2410], [21.0250, 52.2400], [21.0270, 52.2420], [21.0290, 52.2390], [21.0222, 52.2397]
  ],
  // Autobus 3: trasa z ostrym zakrętem
  [
    [21.0322, 52.2197], [21.0340, 52.2205], [21.0360, 52.2212], [21.0380, 52.2200], [21.0400, 52.2180], [21.0370, 52.2170], [21.0322, 52.2197]
  ]
];
let mockRouteStep = 0;
let mockRouteSteps = {
  '1000': 0,
  '1001': 0,
  '1002': 0
};
let lastPositions = [
  [21.0122, 52.2297],
  [21.0222, 52.2397],
  [21.0322, 52.2197]
];
let nextPositions = [
  [21.0122, 52.2297],
  [21.0222, 52.2397],
  [21.0322, 52.2197]
];
let lastUpdateTime = Date.now();

function getMockData(interpolated = false, t = 0) {
  // Jeśli interpolated=true, zwróć pozycje interpolowane
  if (interpolated) {
    return mockBuses.map((bus, i) => {
      const [lon1, lat1] = lastPositions[i];
      const [lon2, lat2] = nextPositions[i];
      const frac = Math.min(t / 10000, 1); // t w ms, 10s na segment
      const lon = lon1 + (lon2 - lon1) * frac;
      const lat = lat1 + (lat2 - lat1) * frac;
      return {...bus, Lon: lon, Lat: lat};
    });
  }
  // Zwykły mock: przesuwaj do kolejnego punktu
  return mockBuses.map((bus, i) => {
    const route = mockRoutes[i];
    const idx = mockRouteSteps[bus.VehicleNumber] % route.length;
    return {...bus, Lon: route[idx][0], Lat: route[idx][1]};
  });
}

// --- Dekodowanie protobuf w przeglądarce ---

import * as protobuf from 'protobufjs';
// Flaga do przełączania mocków
const USE_MOCK = false;

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
    // Loguj cały zdekodowany obiekt jako JSON (uwaga: może być duży)
    console.log('FeedMessage JSON:', JSON.stringify(FeedMessage.toObject(message), null, 2));
    // Wyciągnij pojazdy z pozycją
    const entities = message.entity || [];
    const now = Date.now();
    const buses = entities
      .filter(e => e.vehicle && e.vehicle.position)
      .map(e => ({
        VehicleNumber: e.vehicle.vehicle && e.vehicle.vehicle.label ? e.vehicle.vehicle.label : '',
        Lon: e.vehicle.position.longitude,
        Lat: e.vehicle.position.latitude,
        Lines: e.vehicle.trip && e.vehicle.trip.routeId ? e.vehicle.trip.routeId : '',
        Brigade: e.vehicle.vehicle && e.vehicle.vehicle.id ? e.vehicle.vehicle.id : '',
        Timestamp: (e.vehicle.timestamp ? e.vehicle.timestamp * 1000 : now)
      }));

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
      // Dodaj nową pozycję tylko jeśli inna niż ostatnia (pozycja lub timestamp)
      if (!last || last.lon !== bus.Lon || last.lat !== bus.Lat || last.time !== bus.Timestamp) {
        hist.push({lon: bus.Lon, lat: bus.Lat, time: bus.Timestamp});
        if (hist.length > HISTORY_LENGTH) hist.shift();
      }
    });

    // Zwróć tablicę tripów (każdy autobus jako "trasa" z historią)
    const trips = buses.map(bus => {
      const hist = busHistory[bus.VehicleNumber] || [];
      // path: [[lon, lat], ...]
      const path = hist.map(e => [e.lon, e.lat]);
      // timestamps: w sekundach, przesunięte do zera
      let timestamps = hist.map(e => Math.floor(e.time / 1000));
      if (timestamps.length > 0) {
        const t0 = timestamps[0];
        timestamps = timestamps.map(t => t - t0);
      }
      return {
        path: path.length ? path : [[bus.Lon, bus.Lat]],
        timestamps: timestamps.length ? timestamps : [0],
        color: [255, 0, 0, 200],
        vehicle: bus
      };
    });
    return trips;
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

  // --- WARSTWA ANIMOWANYCH OGONÓW + PUNKTY ---
  let tripsLayer = new TripsLayer({
    id: 'trips',
    data: [],
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    opacity: 0.85,
    widthMinPixels: 10,
    capRounded: true,
    jointRounded: true,
    trailLength: HISTORY_LENGTH,
    currentTime: 0,
    fadeTrail: true
  });

  let scatterLayer = new ScatterplotLayer({
    id: 'bus-points',
    data: [],
    getPosition: d => d.path[0],
    getFillColor: [0, 128, 255, 200],
    getRadius: 40,
    radiusMinPixels: 6,
    pickable: true,
    opacity: 0.95
  });

  const overlay = new MapboxOverlay({
    layers: [tripsLayer, scatterLayer]
  });
  map.addControl(overlay);

  // --- ANIMACJA I AKTUALIZACJA ---
  let animationFrame;
  let currentTime = 0;
  let maxTrail = HISTORY_LENGTH;

  async function updateTrips() {
    const tripsData = await fetchBusData();
    // Ustal długość animacji na podstawie najdłuższej trasy (w sekundach)
    const maxRouteLen = Math.max(...mockRoutes.map(r => r.length));
    maxTrail = maxRouteLen * 10;
    tripsLayer = tripsLayer.clone({
      data: tripsData,
      trailLength: maxTrail,
      widthMinPixels: 10,
      fadeTrail: true,
      currentTime: currentTime,
      capRounded: true,
      jointRounded: true,
    });
    scatterLayer = scatterLayer.clone({
      data: tripsData
    });
    overlay.setProps({
      layers: [tripsLayer, scatterLayer]
    });
  }

  function animate() {
    let tripsData;
    let currentTimeAnim;
    if (USE_MOCK) {
      const t = Date.now() - lastUpdateTime;
      const buses = getMockData(true, t);
      tripsData = buses.map((bus, i) => {
        const key = bus.VehicleNumber;
        let path = (busHistory[key] || []).map(e => [e.lon, e.lat]);
        path = [...path, [bus.Lon, bus.Lat]];
        let timestampsRaw = (busHistory[key] || []).map(e => Math.floor(e.time / 1000));
        let timestamps = timestampsRaw.slice(-path.length);
        if (timestamps.length > 0) {
          const t0 = timestamps[0];
          timestamps = timestamps.map(t => t - t0);
        }
        // Dodaj timestamp dla interpolowanego punktu
        const lastTs = timestamps.length > 0 ? timestamps[timestamps.length-1] : 0;
        const interpTs = lastTs + (t/10000);
        timestamps = [...timestamps, interpTs];
        return {
          path,
          timestamps,
          color: [255, 0, 0, 200]
        };
      });
      // currentTime = upływ czasu od początku trasy (w sekundach)
      currentTimeAnim = tripsData.length ? tripsData[0].timestamps[tripsData[0].timestamps.length-1] : 0;
      overlay.setProps({
        layers: [
          tripsLayer.clone({
            data: tripsData,
            currentTime: currentTimeAnim
          }),
          scatterLayer.clone({
            data: tripsData
          })
        ]
      });
    } else {
      currentTimeAnim = (currentTime + 0.2) % (maxTrail + 2);
      overlay.setProps({
        layers: [
          tripsLayer,
          scatterLayer
        ]
      });
    }
    animationFrame = requestAnimationFrame(animate);
  }

  await updateTrips();
  animate();
  setInterval(updateTrips, 10000);
}

document.addEventListener('DOMContentLoaded', init);