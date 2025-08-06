# 🚍 Warsaw ZTM Live Map

This proof of concept displays real-time positions of trams and buses in Warsaw on an interactive map.

Data is fetched every 20 seconds from [MKuran GTFS feed](https://mkuran.pl/gtfs/) and visualized using **Deck.gl** and **Maplibre**.

🔗 **Live demo:** [warsawztm.vercel.app](https://warsawztm.vercel.app/)

> ⚠️ **Please wait ~40 seconds after opening the site before vehicle animations start.**  
> The system needs to collect at least 2 data snapshots to animate movement.

## 🗺️ Features

- Real-time vehicle tracking (updated every 20s)
- Animated vehicle trails using Deck.gl
- MapLibre-based interactive map
- Dark and light theme toggle
- Tooltip on hover showing vehicle number
- Display of live GTFS timestamp

## 🛠️ Tech Stack

- [Deck.gl](https://deck.gl/)
- [MapLibre GL](https://maplibre.org/)
- [Parcel](https://parceljs.org)
