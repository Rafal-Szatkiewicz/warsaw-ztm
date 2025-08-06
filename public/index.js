import {MapboxOverlay} from '@deck.gl/mapbox';
import {Map} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {TripsLayer} from '@deck.gl/geo-layers';
import {ScatterplotLayer} from '@deck.gl/layers';
import * as protobuf from 'protobufjs';

// Download GTFS from https://mkuran.pl/gtfs/warsaw/vehicles.pb

const VEHICLES_PB_URL = '/api/ztm-proxy';
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';

const busHistory = {};
const HISTORY_LENGTH = 100;



let gtfsRoot = null;
async function loadGtfsProto() 
{
  if (gtfsRoot) return gtfsRoot;
  const res = await fetch(GTFS_PROTO_URL);
  const protoText = await res.text();
  gtfsRoot = protobuf.parse(protoText).root;
  return gtfsRoot;
}

async function fetchBusData() 
{
  try 
  {
    // Download protobuf
    const [root, pbRes] = await Promise.all([
      loadGtfsProto(),
      fetch(VEHICLES_PB_URL)
    ]);
    const buffer = await pbRes.arrayBuffer();
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    let timestamp = message.header?.timestamp || null;

    console.log("Fetched new data");
    // console.log('FeedMessage JSON:', JSON.stringify(FeedMessage.toObject(message), null, 2));
    // Fetch entities and convert to bus data
    const entities = message.entity || [];
    const now = Date.now();
    const buses = entities
      .filter(e => e.vehicle && e.vehicle.position)
      .map(e => ({
        VehicleNumber: e.vehicle.vehicle && e.vehicle.vehicle.id ? e.vehicle.vehicle.id : '',
        Lon: e.vehicle.position.longitude,
        Lat: e.vehicle.position.latitude,
        Brigade: e.vehicle.vehicle && e.vehicle.vehicle.label ? e.vehicle.vehicle.label : '',
        Timestamp: (e.vehicle.timestamp ? e.vehicle.timestamp * 1000 : now)
      }));

    // Update bus history
    buses.forEach(bus => {
      if (!bus.VehicleNumber) return;
      if (!busHistory[bus.VehicleNumber]) {
        const now = Date.now();
        const earlier = now - 5000;
        busHistory[bus.VehicleNumber] = [
          {lon: bus.Lon, lat: bus.Lat, time: earlier},
          {lon: bus.Lon, lat: bus.Lat, time: now}
        ];
        return;
      }

      const hist = busHistory[bus.VehicleNumber];
      const last = hist.length ? hist[hist.length-1] : null;
      // Add new position only if it's newer than the last recorded time
      if (last && bus.Timestamp <= last.time) {
        return;
      }
      // Add new position only if it's different from the last recorded position
      if (!last || last.lon !== bus.Lon || last.lat !== bus.Lat || last.time !== bus.Timestamp) {
        hist.push({lon: bus.Lon, lat: bus.Lat, time: bus.Timestamp});
        if (hist.length > HISTORY_LENGTH) hist.shift();
      }
    });

    // Return trips data for animation
    const trips = [];
    let globalStart = Date.now();
    // Zamiast opierać się na "historycznym czasie", animujemy tylko nowy segment
    const MIN_SEGMENT_DURATION = 19; // sekundy
    const INTERP_POINTS = 10;
    buses.forEach(bus => {
      const hist = busHistory[bus.VehicleNumber] || [];
      if (hist.length < 2) return;

      const startIndex = Math.max(1, hist.length - 3);
      for (let i = startIndex; i < hist.length; i++) 
      {
        const prev = hist[i - 1];
        const curr = hist[i];

        const path = [];
        for (let j = 0; j < INTERP_POINTS; j++) 
        {
          const frac = j / (INTERP_POINTS - 1);
          const lon = prev.lon + (curr.lon - prev.lon) * frac;
          const lat = prev.lat + (curr.lat - prev.lat) * frac;
          path.push([lon, lat]);
        }

        // Animate last segment
        // For previous segments, use static timestamps
        const isLast = (i === hist.length - 1);
        const timestamps = isLast
          ? Array.from({ length: INTERP_POINTS }, (_, j) => (j / (INTERP_POINTS - 1)) * MIN_SEGMENT_DURATION)
          : Array(INTERP_POINTS).fill(0); // static

        const opacityFactor = i / (hist.length - 1);
        const alpha = Math.round(255 * Math.pow(opacityFactor, 0.7));

        trips.push({
          path,
          timestamps,
          color: [123, 181, 23, alpha],
          vehicle: bus
        });

      }
    });


    return { trips, globalStart, timestamp };
  } catch (e) {
    console.error('Error while fetching bus data:', e);
    return [];
  }
}

async function init() 
{

  const map = new Map({
    style: 'https://tiles.openfreemap.org/styles/liberty',
    //style: "https://tiles.openfreemap.org/styles/dark",
    center: [21.0122, 52.2297],
    zoom: 14,
    container: 'map',
  });

  // Dodaj element na tooltip
  let tooltipDiv = document.createElement('div');
  tooltipDiv.className = 'bus-tooltip';
  document.body.appendChild(tooltipDiv);


  const overlay = new MapboxOverlay({
    layers: []
  });
  map.addControl(overlay);

  let animationFrame;
  let lastTripsData = [];
  let lastGlobalStart = null;
  const FETCH_INTERVAL = 20000;

  async function updateTrips() 
  {
    const result = await fetchBusData();
    if (!result || !result.trips) return;
    lastTripsData = result.trips;
    lastGlobalStart = result.globalStart;

    // Update timestamp display
    if (result.timestamp) {
      const tsDiv = document.getElementById('timestamp-value');
      const date = new Date(result.timestamp * 1000);
      tsDiv.textContent = `${date.toLocaleString()}`;
    }
  }

  function animate() 
  {
    console.log('Animating trips...');
    // Global animation time: seconds since globalStart
    const nowSec = (Date.now() - lastGlobalStart) / 1000;

    // TripsLayer expects a global currentTime, not per-trip
    const animatedTrips = lastTripsData;
    const globalCurrentTime = nowSec;
    const tripsLayer = new TripsLayer({
      id: 'trips',
      data: animatedTrips,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: d => d.color,
      opacity: 1,
      widthUnits: 'meters',
      getWidth: 5,
      capRounded: true,
      jointRounded: true,
      trailLength: 40,
      currentTime: globalCurrentTime,
      fadeTrail: false
    });
    // Scatter layer: show animated head of each bus
    const busSegments = {};
    for (const trip of lastTripsData) 
    {
      const vehicleId = trip.vehicle && trip.vehicle.VehicleNumber;
      if (!vehicleId) continue;
      if (!busSegments[vehicleId]) busSegments[vehicleId] = [];
      busSegments[vehicleId].push(trip);
    }
    const busHeads = {};
    for (const segments of Object.values(busSegments)) 
    {
      segments.sort((a, b) => a.timestamps[0] - b.timestamps[0]);
      let headPos = null;
      let vehicle = null;
      for (let i = 0; i < segments.length; i++) 
      {
        const trip = segments[i];
        const start = trip.timestamps[0];
        const end = trip.timestamps[trip.timestamps.length - 1];
        vehicle = trip.vehicle;
        if (nowSec < start) 
        {
          continue;
        } 
        else if (nowSec >= end) 
        {
          headPos = trip.path[trip.path.length - 1];
        } 
        else 
        {
          // Animated head position
          const segTime = nowSec - start;
          let idx = trip.timestamps.findIndex(t => t > segTime + start);
          if (idx === -1 || idx === 0) 
          {
            headPos = trip.path[trip.path.length - 1];
          } 
          else 
          {
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
      if (headPos && vehicle) 
      {
        busHeads[vehicle.VehicleNumber] = { pos: headPos, vehicle };
      }
    }
    const scatterData = Object.values(busHeads).map(({ pos, vehicle }) => ({ pos, vehicle }));
    const scatterLayer = new ScatterplotLayer({
      id: 'bus-points',
      data: scatterData,
      getPosition: d => d.pos,
      getFillColor: [23, 181, 160],
      getRadius: 10,
      radiusMinPixels: 2,
      pickable: true,
      opacity: 1,
      onHover: info => {
        if (info.object && info.object.vehicle && info.object.vehicle.VehicleNumber) {
          tooltipDiv.textContent = `${info.object.vehicle.VehicleNumber}`;
          tooltipDiv.style.left = info.x + 10 + 'px';
          tooltipDiv.style.top = info.y + 10 + 'px';
          tooltipDiv.classList.add('show');
        } else {
          tooltipDiv.classList.remove('show');
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
  // Hide startup info after 40 seconds
  setTimeout(() => {
    const infoBox = document.getElementById('startup-info');
    if (infoBox) infoBox.classList.add('fade-out');
  }, 20000);

  setInterval(async () => {
    await updateTrips();
    animate();
  }, FETCH_INTERVAL);
}

let isDarkMode = true;

function setTheme(dark) 
{
  const container = document.querySelector('.maplibregl-canvas-container');
  const btn = document.getElementById('toggle-theme');

  if (dark) 
    {
    document.body.classList.add('dark-map');
    btn.textContent = '☀️ Light Mode';

   // map.setStyle("https://tiles.openfreemap.org/styles/dark");

  } 
  else 
  {
    document.body.classList.remove('dark-map');
    btn.textContent = '🌙 Dark Mode';

    if (container) 
    {
      container.style.filter = '';
    }

    // map.setStyle("https://tiles.openfreemap.org/styles/liberty");
  }

  isDarkMode = dark;
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  setTheme(true);
});

document.getElementById('toggle-theme').addEventListener('click', () => {
  setTheme(!isDarkMode);
});