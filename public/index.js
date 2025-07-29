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
const FETCH_INTERVAL = 10000;
const ANIMATION_INTERVAL = Math.round(FETCH_INTERVAL * 1.2);

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
      // Dodaj nową pozycję tylko jeśli inna niż ostatnia (pozycja lub timestamp)
      if (!last || last.lon !== bus.Lon || last.lat !== bus.Lat || last.time !== bus.Timestamp) {
        hist.push({lon: bus.Lon, lat: bus.Lat, time: bus.Timestamp});
        if (hist.length > HISTORY_LENGTH) hist.shift();
      }
    });

    // Klasyczna animacja ogona: tylko historyczne punkty, bez interpolacji głowy
    const trips = buses.map(bus => {
      const hist = busHistory[bus.VehicleNumber] || [];
      let path = hist.map(e => [e.lon, e.lat]);
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
  let prevHeadPositions = {}; // VehicleNumber -> {lon, lat}
  let nextHeadPositions = {}; // VehicleNumber -> {lon, lat}
  let lastFetchTime = Date.now();
  let nextFetchTime = lastFetchTime + FETCH_INTERVAL;

  async function updateTrips() {
    const tripsData = await fetchBusData();
    const now = Date.now();
    // Zawsze ustaw lastFetchTime/nextFetchTime, by animacja była ciągła
    lastFetchTime = now;
    nextFetchTime = now + ANIMATION_INTERVAL;
    // Zapamiętaj stare i nowe pozycje głowy ogona dla każdego pojazdu
    prevHeadPositions = {};
    nextHeadPositions = {};
    for (const trip of tripsData) {
      const vehicleId = trip.vehicle && trip.vehicle.VehicleNumber;
      if (!vehicleId) continue;
      // Stara pozycja głowy (z poprzedniego fetchu)
      const prevTrip = lastTripsData.find(t => t.vehicle && t.vehicle.VehicleNumber === vehicleId);
      if (prevTrip && prevTrip.path && prevTrip.path.length > 0) {
        prevHeadPositions[vehicleId] = {
          lon: prevTrip.path[prevTrip.path.length - 1][0],
          lat: prevTrip.path[prevTrip.path.length - 1][1]
        };
      } else if (trip.path && trip.path.length > 0) {
        prevHeadPositions[vehicleId] = {
          lon: trip.path[trip.path.length - 1][0],
          lat: trip.path[trip.path.length - 1][1]
        };
      }
      // Nowa pozycja głowy (z obecnego fetchu)
      if (trip.path && trip.path.length > 0) {
        const prev = prevHeadPositions[vehicleId];
        const curr = { lon: trip.path[trip.path.length - 1][0], lat: trip.path[trip.path.length - 1][1] };
        // Jeśli pozycja się nie zmieniła, interpoluj do tej samej pozycji
        if (prev && prev.lon === curr.lon && prev.lat === curr.lat) {
          nextHeadPositions[vehicleId] = { ...curr };
        } else {
          nextHeadPositions[vehicleId] = { ...curr };
        }
      }
    }
    lastTripsData = tripsData;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }


  function animate() {
    const now = Date.now();
    // Animuj currentTime liniowo po całej historii
    let maxCurrentTime = 0;
    for (const trip of lastTripsData) {
      if (trip.timestamps && trip.timestamps.length > 0) {
        const last = trip.timestamps[trip.timestamps.length - 1];
        if (last > maxCurrentTime) maxCurrentTime = last;
      }
    }
    // currentTime rośnie od 0 do maxCurrentTime w pętli
    const animDuration = ANIMATION_INTERVAL;
    const t = ((now - lastFetchTime) % animDuration) / animDuration;
    const animatedCurrentTime = t * maxCurrentTime;
    const tripsLayer = new TripsLayer({
      id: 'trips',
      data: lastTripsData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: d => d.color,
      opacity: 0.85,
      widthMinPixels: 10,
      capRounded: true,
      jointRounded: true,
      trailLength: HISTORY_LENGTH,
      currentTime: animatedCurrentTime,
      fadeTrail: false
    });
    const scatterLayer = new ScatterplotLayer({
      id: 'bus-points',
      data: lastTripsData,
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
    animationFrame = requestAnimationFrame(animate);
  }

  await updateTrips();
  animate();
  setInterval(async () => {
    await updateTrips();
  }, FETCH_INTERVAL);
}

document.addEventListener('DOMContentLoaded', init);