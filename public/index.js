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
const busHistory = {};
const HISTORY_LENGTH = 100; // ile pozycji historii trzymać (wydłużony ogon)

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
    console.log('FeedMessage JSON:', JSON.stringify(FeedMessage.toObject(message), null, 2));
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
    layers: [],
    interleaved: true
  });
  map.addControl(overlay);

  // Po zoomie odśwież oba layery, aby były zsynchronizowane i rozmiar punktów był aktualny
  map.on('zoom', () => {
    updateTrips();
  });

  // --- ANIMACJA I AKTUALIZACJA ---
  let animationFrame;
  let currentTime = 0;
  let maxTrail = HISTORY_LENGTH;
  let lastTripsData = [];
  let lastFetchTime = Date.now();
  let nextFetchTime = lastFetchTime + 10000;

  async function updateTrips() {
    const tripsData = await fetchBusData();
    lastTripsData = tripsData;
    lastFetchTime = Date.now();
    nextFetchTime = lastFetchTime + 10000;
    maxTrail = HISTORY_LENGTH;
    // Ustal currentTime na maksymalny czas z timestamps (długość ogona)
    let maxCurrentTime = 0;
    for (const trip of tripsData) {
      if (trip.timestamps && trip.timestamps.length > 0) {
        const last = trip.timestamps[trip.timestamps.length - 1];
        if (last > maxCurrentTime) maxCurrentTime = last;
      }
    }
    // Jeśli currentTime przekroczył nowy maxCurrentTime, zresetuj do 0
    if (currentTime > maxCurrentTime) currentTime = 0;
    const tripsLayer = new TripsLayer({
      id: 'trips',
      data: tripsData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: d => d.color,
      opacity: 0.85,
      widthMinPixels: 10,
      capRounded: true,
      jointRounded: true,
      trailLength: maxTrail,
      currentTime: currentTime,
      fadeTrail: false
    });
    const scatterLayer = new ScatterplotLayer({
      id: 'bus-points',
      data: tripsData,
      getPosition: d => d.path[d.path.length - 1],
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
  }

  function interpolateTripsData() {
    // Zwraca tripsData z interpolowaną głową każdego pojazdu
    const now = Date.now();
    const t = Math.min((now - lastFetchTime) / (nextFetchTime - lastFetchTime), 1);
    return lastTripsData.map(trip => {
      const hist = trip.path;
      if (hist.length < 2) return trip;
      // Ostatni punkt historii
      const [lon1, lat1] = hist[hist.length - 2];
      const [lon2, lat2] = hist[hist.length - 1];
      const lon = lon1 + (lon2 - lon1) * t;
      const lat = lat1 + (lat2 - lat1) * t;
      // Nowa path: cała historia + interpolowana głowa
      const interpPath = [...hist.slice(0, -1), [lon, lat]];
      // timestamps: wydłużone o interpolację
      let timestamps = trip.timestamps || [];
      if (timestamps.length > 1) {
        const lastTs = timestamps[timestamps.length - 2];
        const nextTs = timestamps[timestamps.length - 1];
        const interpTs = lastTs + (nextTs - lastTs) * t;
        timestamps = [...timestamps.slice(0, -1), interpTs];
      }
      return {
        ...trip,
        path: interpPath,
        timestamps: timestamps
      };
    });
  }

  function animateTrails() {
    currentTime += 0.2;
    if (currentTime > maxTrail) currentTime = 0;
    // Interpoluj pozycje do nowej lokalizacji
    const tripsDataInterp = interpolateTripsData();
    const layers = overlay.props && overlay.props.layers ? overlay.props.layers : [];
    const tripsLayer = layers.find(l => l && l.id === 'trips');
    const scatterLayer = layers.find(l => l && l.id === 'bus-points');
    if (tripsLayer && scatterLayer) {
      overlay.setProps({
        layers: [
          new TripsLayer({
            ...tripsLayer.props,
            data: tripsDataInterp,
            currentTime: currentTime
          }),
          new ScatterplotLayer({
            ...scatterLayer.props,
            data: tripsDataInterp
          })
        ]
      });
    }
    animationFrame = requestAnimationFrame(animateTrails);
  }

  await updateTrips();
  animateTrails();
  setInterval(updateTrips, 10000);
}

document.addEventListener('DOMContentLoaded', init);