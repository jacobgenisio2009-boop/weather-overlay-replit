# NWS Warning Bubble Overlay

A simple, modern overlay that displays National Weather Service (NWS) warnings as a bubble in the bottom right corner of your screen. No API key required. Monitors all U.S. warnings in real time.

## Features

- 🚨 Shows new NWS warnings as they are issued
- 📍 Covers all U.S. warnings (uses NWS public API)
- 🟡 Modern, attention-grabbing warning bubble
- ⏱️ Auto-hides after 10 seconds, or click to dismiss
- 🔄 Rotates through multiple new warnings
- 🧠 Remembers shown warnings (no repeats)
- ⚡ No backend or API key needed

## Quick Start

1. Download or clone this repository
2. Open `index.html` in your web browser

## How It Works

- The overlay fetches all active NWS warnings from the [NWS Alerts API](https://api.weather.gov/alerts/active)
- When a new warning is found, a bubble appears in the bottom right with the warning info
- The bubble auto-hides after 10 seconds, or you can click the × to dismiss
- Already-shown warnings are remembered in your browser (localStorage)
- The overlay checks for new warnings every 60 seconds

## Customization

- **Bubble Style:** Edit `styles.css` to change colors, size, or animation
- **Auto-hide Time:** Change `AUTO_HIDE_MS` in `script.js`
- **Polling Interval:** Change the `setInterval` value in `script.js`
- **Area:** By default, all U.S. warnings are shown. To filter by state or area, modify the API URL in `script.js`.

## For Streaming or Desktop
- Add `index.html` as a browser source in OBS or your streaming software
- Or, leave it open in a browser window for desktop notifications

## License

MIT License

---

**Stay safe and weather-aware!** 🚨 