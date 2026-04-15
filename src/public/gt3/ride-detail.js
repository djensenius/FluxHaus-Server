// GT3 Pro Dashboard — Ride detail page logic

const API_BASE = '/gt3';

const CHART_COLORS = {
  sky: '#89dceb',
  sapphire: '#74c7ec',
  mauve: '#cba6f7',
  green: '#a6e3a1',
  peach: '#fab387',
  red: '#f38ba8',
  blue: '#89b4fa',
  teal: '#94e2d5',
  pink: '#f5c2e7',
  yellow: '#f9e2af',
  text: '#cdd6f4',
  subtext: '#a6adc8',
  surface: '#313244',
};

Chart.defaults.color = CHART_COLORS.subtext;
Chart.defaults.borderColor = CHART_COLORS.surface;

const GEAR_NAMES = { 1: 'Eco', 2: 'Standard', 3: 'Sport', 4: 'Race' };
const GEAR_COLORS = { 1: '#a6e3a1', 2: '#89b4fa', 3: '#fab387', 4: '#f38ba8' };
function gearName(mode) {
  if (mode == null) return 'Unknown';
  return GEAR_NAMES[mode] || `Mode ${mode}`;
}

const WEATHER_EMOJI = {
  clear: '☀️', sunny: '☀️',
  'mostly clear': '🌤️', 'partly cloudy': '⛅',
  cloudy: '☁️', overcast: '☁️', 'mostly cloudy': '🌥️',
  rain: '🌧️', drizzle: '🌦️', showers: '🌦️', 'heavy rain': '🌧️',
  thunderstorm: '⛈️', 'thunderstorms': '⛈️',
  snow: '🌨️', sleet: '🌨️', 'freezing rain': '🌨️',
  fog: '🌫️', haze: '🌫️', mist: '🌫️',
  wind: '💨', windy: '💨', breezy: '💨',
};

function weatherEmoji(condition) {
  if (!condition) return '';
  const lower = condition.toLowerCase();
  for (const [key, emoji] of Object.entries(WEATHER_EMOJI)) {
    if (lower.includes(key)) return emoji;
  }
  return '🌡️';
}

// ── Helpers ────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/auth/login?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
    return null;
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso) - new Date(startIso);
  const min = Math.floor(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

// Handle both InfluxDB (_time) and Postgres (timestamp) column names
function sampleTime(s) {
  return s._time || s.time || s.timestamp;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const defaultChartOptions = {
  responsive: true,
  plugins: { legend: { position: 'top' } },
  scales: { x: { display: true, ticks: { maxTicksLimit: 10 } } },
  elements: { point: { radius: 0 }, line: { borderWidth: 2 } },
};

function hideCard(canvasId) {
  document.getElementById(canvasId).parentElement.style.display = 'none';
}

// ── GPX Export ────────────────────────────────────────────

function buildGPX(samples, rideName) {
  const points = samples
    .filter(s => {
      const lat = parseFloat(s.latitude);
      const lon = parseFloat(s.longitude);
      return lat && lon && lat !== 0 && lon !== 0;
    })
    .map(s => {
      const time = sampleTime(s);
      const ele = parseFloat(s.altitude) || 0;
      return `      <trkpt lat="${s.latitude}" lon="${s.longitude}">
        <ele>${ele}</ele>
        ${time ? `<time>${new Date(time).toISOString()}</time>` : ''}
      </trkpt>`;
    });

  if (points.length === 0) return null;

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GT3 Pro Dashboard"
  xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${rideName}</name>
    <trkseg>
${points.join('\n')}
    </trkseg>
  </trk>
</gpx>`;
}

// ── Main ──────────────────────────────────────────────────

async function loadRide() {
  const params = new URLSearchParams(window.location.search);
  const rideId = params.get('id');
  if (!rideId) {
    document.querySelector('main').innerHTML =
      '<p class="error" style="margin:2rem">No ride ID specified. <a href="/gt3/">Return to dashboard</a></p>';
    return;
  }

  const [ride, samplesData] = await Promise.all([
    apiFetch(`/rides/${rideId}`),
    apiFetch(`/rides/${rideId}/samples`).catch(() => null),
  ]);
  if (!ride) return;

  document.title = `Ride ${formatDate(ride.start_time)} — GT3 Pro`;

  // ── Ride info cards ─────────────────────────────────────
  document.getElementById('ride-info').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${formatDate(ride.start_time)}</div>
      <div class="stat-label">Date</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formatDuration(ride.start_time, ride.end_time)}</div>
      <div class="stat-label">Duration</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${ride.distance != null ? ride.distance.toFixed(1) + ' km' : '—'}</div>
      <div class="stat-label">Distance${ride.gps_distance != null ? ' (GPS)' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${ride.max_speed != null ? ride.max_speed.toFixed(1) + ' km/h' : '—'}</div>
      <div class="stat-label">Max Speed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${ride.avg_speed != null ? ride.avg_speed.toFixed(1) + ' km/h' : '—'}</div>
      <div class="stat-label">Avg Speed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${ride.start_battery ?? '?'}% → ${ride.end_battery ?? '?'}%</div>
      <div class="stat-label">Battery</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${gearName(ride.gear_mode)}</div>
      <div class="stat-label">Gear Mode</div>
    </div>
  `;

  // ── Weather ─────────────────────────────────────────────
  if (ride.weather_temp != null) {
    const ws = document.getElementById('weather-section');
    ws.style.display = '';
    const emoji = weatherEmoji(ride.weather_condition);
    document.getElementById('weather-detail').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${emoji} ${ride.weather_temp.toFixed(0)}°C</div>
        <div class="stat-label">${ride.weather_condition || 'Temperature'}</div>
      </div>
      ${ride.weather_feels_like != null ? `
      <div class="stat-card">
        <div class="stat-value">${ride.weather_feels_like.toFixed(0)}°C</div>
        <div class="stat-label">Feels Like</div>
      </div>` : ''}
      ${ride.weather_humidity != null ? `
      <div class="stat-card">
        <div class="stat-value">${ride.weather_humidity.toFixed(0)}%</div>
        <div class="stat-label">Humidity</div>
      </div>` : ''}
      ${ride.weather_wind_speed != null ? `
      <div class="stat-card">
        <div class="stat-value">${ride.weather_wind_speed.toFixed(0)} km/h</div>
        <div class="stat-label">Wind</div>
      </div>` : ''}
      ${ride.weather_uv_index != null ? `
      <div class="stat-card">
        <div class="stat-value">${ride.weather_uv_index.toFixed(0)}</div>
        <div class="stat-label">UV Index</div>
      </div>` : ''}
      ${ride.weather_pressure != null ? `
      <div class="stat-card">
        <div class="stat-value">${ride.weather_pressure.toFixed(0)} hPa</div>
        <div class="stat-label">Pressure</div>
      </div>` : ''}
    `;
  }

  // ── Map ─────────────────────────────────────────────────
  if (ride.gps_track && Array.isArray(ride.gps_track) && ride.gps_track.length > 0) {
    const map = L.map('map', { attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    const latLngs = ride.gps_track.map(coord => {
      if (Array.isArray(coord)) return [coord[1], coord[0]];
      return [coord.latitude ?? coord.lat, coord.longitude ?? coord.lng];
    }).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));

    if (latLngs.length > 0) {
      const polyline = L.polyline(latLngs, {
        color: CHART_COLORS.sky, weight: 4, opacity: 0.8,
      }).addTo(map);

      L.circleMarker(latLngs[0], {
        radius: 8, fillColor: CHART_COLORS.green,
        color: '#fff', weight: 2, fillOpacity: 1,
      }).addTo(map).bindPopup('Start');

      L.circleMarker(latLngs[latLngs.length - 1], {
        radius: 8, fillColor: CHART_COLORS.red,
        color: '#fff', weight: 2, fillOpacity: 1,
      }).addTo(map).bindPopup('End');

      map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
    }
  } else {
    document.getElementById('map-section').style.display = 'none';
  }

  // ── Telemetry charts ────────────────────────────────────
  if (samplesData && samplesData.samples && samplesData.samples.length > 0) {
    const samples = samplesData.samples;
    const times = samples.map(s => formatTime(sampleTime(s)));

    // Speed
    new Chart(document.getElementById('speedChart'), {
      type: 'line',
      data: {
        labels: times,
        datasets: [{
          label: 'Scooter Speed (km/h)',
          data: samples.map(s => parseFloat(s.speed) || 0),
          borderColor: CHART_COLORS.sky,
          backgroundColor: CHART_COLORS.sky + '20',
          fill: true, tension: 0.2,
        }, {
          label: 'GPS Speed (km/h)',
          data: samples.map(s => parseFloat(s.gps_speed || s.gpsSpeed) || 0),
          borderColor: CHART_COLORS.sapphire,
          borderDash: [5, 5],
          fill: false, tension: 0.2,
        }],
      },
      options: defaultChartOptions,
    });

    // Battery & BMS
    new Chart(document.getElementById('batteryChart'), {
      type: 'line',
      data: {
        labels: times,
        datasets: [{
          label: 'Battery (%)',
          data: samples.map(s => parseFloat(s.battery) || 0),
          borderColor: CHART_COLORS.green,
          fill: false, tension: 0.2, yAxisID: 'y',
        }, {
          label: 'BMS Voltage (V)',
          data: samples.map(s => parseFloat(s.bms_voltage || s.bmsVoltage) || 0),
          borderColor: CHART_COLORS.yellow,
          fill: false, tension: 0.2, yAxisID: 'y1',
        }, {
          label: 'BMS Current (A)',
          data: samples.map(s => parseFloat(s.bms_current || s.bmsCurrent) || 0),
          borderColor: CHART_COLORS.peach,
          fill: false, tension: 0.2, yAxisID: 'y1',
        }],
      },
      options: {
        ...defaultChartOptions,
        scales: {
          ...defaultChartOptions.scales,
          y: { position: 'left', title: { display: true, text: 'Battery %' }, min: 0, max: 100 },
          y1: { position: 'right', title: { display: true, text: 'V / A' }, grid: { drawOnChartArea: false } },
        },
      },
    });

    // Temperature (BMS + Body)
    const hasBmsTemp = samples.some(s => parseFloat(s.bms_temp || s.bmsTemp) > 0);
    const hasBodyTemp = samples.some(s => parseFloat(s.body_temp || s.bodyTemp) > 0);
    if (hasBmsTemp || hasBodyTemp) {
      const datasets = [];
      if (hasBmsTemp) {
        datasets.push({
          label: 'BMS Temp (°C)',
          data: samples.map(s => parseFloat(s.bms_temp || s.bmsTemp) || null),
          borderColor: CHART_COLORS.peach,
          fill: false, tension: 0.3, spanGaps: true,
        });
      }
      if (hasBodyTemp) {
        datasets.push({
          label: 'Body Temp (°C)',
          data: samples.map(s => parseFloat(s.body_temp || s.bodyTemp) || null),
          borderColor: CHART_COLORS.yellow,
          fill: false, tension: 0.3, spanGaps: true,
        });
      }
      new Chart(document.getElementById('tempChart'), {
        type: 'line',
        data: { labels: times, datasets },
        options: defaultChartOptions,
      });
    } else {
      hideCard('tempChart');
    }

    // Altitude
    const hasAlt = samples.some(s => {
      const v = parseFloat(s.altitude);
      return v && v !== 0;
    });
    if (hasAlt) {
      new Chart(document.getElementById('altitudeChart'), {
        type: 'line',
        data: {
          labels: times,
          datasets: [{
            label: 'Altitude (m)',
            data: samples.map(s => parseFloat(s.altitude) || null),
            borderColor: CHART_COLORS.teal,
            backgroundColor: CHART_COLORS.teal + '20',
            fill: true, tension: 0.3, spanGaps: true,
          }],
        },
        options: defaultChartOptions,
      });
    } else {
      hideCard('altitudeChart');
    }

    // Heart rate
    const hrSamples = samples.filter(s => parseFloat(s.heart_rate || s.heartRate) > 0);
    if (hrSamples.length > 0) {
      new Chart(document.getElementById('heartRateChart'), {
        type: 'line',
        data: {
          labels: hrSamples.map(s => formatTime(sampleTime(s))),
          datasets: [{
            label: 'Heart Rate (bpm)',
            data: hrSamples.map(s => parseFloat(s.heart_rate || s.heartRate)),
            borderColor: CHART_COLORS.red,
            backgroundColor: CHART_COLORS.red + '20',
            fill: true, tension: 0.3,
          }],
        },
        options: defaultChartOptions,
      });
    } else {
      hideCard('heartRateChart');
    }

    // Surface roughness
    const hasRoughness = samples.some(s => parseFloat(s.roughness_score || s.roughnessScore) > 0);
    if (hasRoughness) {
      new Chart(document.getElementById('roughnessChart'), {
        type: 'line',
        data: {
          labels: times,
          datasets: [{
            label: 'Roughness Score',
            data: samples.map(s => parseFloat(s.roughness_score || s.roughnessScore) || null),
            borderColor: CHART_COLORS.mauve,
            backgroundColor: CHART_COLORS.mauve + '20',
            fill: true, tension: 0.3, spanGaps: true,
          }, {
            label: 'Max Acceleration (g)',
            data: samples.map(s => parseFloat(s.max_acceleration || s.maxAcceleration) || null),
            borderColor: CHART_COLORS.pink,
            borderDash: [5, 5],
            fill: false, tension: 0.3, spanGaps: true,
          }],
        },
        options: defaultChartOptions,
      });
    } else {
      hideCard('roughnessChart');
    }

    // Gear mode breakdown — count samples per gear mode
    const gearCounts = {};
    samples.forEach(s => {
      const mode = parseInt(s.gear_mode || s.gearMode) || 0;
      if (mode > 0) gearCounts[mode] = (gearCounts[mode] || 0) + 1;
    });
    const gearModes = Object.keys(gearCounts).map(Number).sort();
    if (gearModes.length > 0) {
      const total = gearModes.reduce((sum, m) => sum + gearCounts[m], 0);
      const gearSection = document.getElementById('gear-breakdown');
      if (gearSection) {
        gearSection.style.display = '';
        gearSection.innerHTML = `
          <h3>Gear Mode Breakdown</h3>
          <div class="gear-bar" style="display:flex;border-radius:8px;overflow:hidden;height:32px;margin-bottom:1rem">
            ${gearModes.map(m => {
              const pct = (gearCounts[m] / total * 100).toFixed(1);
              const color = GEAR_COLORS[m] || CHART_COLORS.overlay;
              return `<div style="width:${pct}%;background:${color};display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:#1e1e2e;font-weight:600" title="${gearName(m)}: ${pct}%">${pct > 8 ? gearName(m) : ''}</div>`;
            }).join('')}
          </div>
          <div style="display:flex;gap:1.5rem;flex-wrap:wrap">
            ${gearModes.map(m => {
              const pct = (gearCounts[m] / total * 100).toFixed(1);
              const color = GEAR_COLORS[m] || CHART_COLORS.overlay;
              return `<span style="display:flex;align-items:center;gap:0.4rem"><span style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>${gearName(m)}: ${pct}%</span>`;
            }).join('')}
          </div>
        `;
      }
    }

    // GPX export button
    const gpxData = buildGPX(samples, `Ride ${formatDate(ride.start_time)}`);
    if (gpxData) {
      const btn = document.getElementById('gpx-export');
      btn.style.display = '';
      btn.onclick = () => {
        const blob = new Blob([gpxData], { type: 'application/gpx+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gt3-ride-${rideId.slice(0, 8)}.gpx`;
        a.click();
        URL.revokeObjectURL(url);
      };
    }
  } else {
    document.querySelectorAll('.charts-grid .card').forEach(card => {
      card.innerHTML = '<p style="color: var(--subtext0); text-align: center; padding: 2rem;">No telemetry data available for this ride</p>';
    });
  }
}

loadRide();
