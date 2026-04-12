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
function gearName(mode) { return GEAR_NAMES[mode] || `Mode ${mode}` || 'Unknown'; }

// ── Helpers ────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/auth/login?redirect=' + encodeURIComponent(window.location.pathname);
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

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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
      <div class="stat-label">Distance</div>
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
    ${ride.weather_temp != null ? `
    <div class="stat-card">
      <div class="stat-value">${ride.weather_temp.toFixed(0)}°C ${ride.weather_condition || ''}</div>
      <div class="stat-label">Weather</div>
    </div>` : ''}
  `;

  // ── Map ─────────────────────────────────────────────────
  if (ride.gps_track && Array.isArray(ride.gps_track) && ride.gps_track.length > 0) {
    const map = L.map('map', { attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    // gps_track: array of [lng, lat, alt?] (GeoJSON order) or {lat, lng} objects
    const latLngs = ride.gps_track.map(coord => {
      if (Array.isArray(coord)) return [coord[1], coord[0]];
      return [coord.latitude || coord.lat, coord.longitude || coord.lng];
    }).filter(c => c[0] && c[1]);

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
    const times = samples.map(s => formatTime(s._time || s.time));

    const chartOptions = {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { x: { display: true, ticks: { maxTicksLimit: 10 } } },
      elements: { point: { radius: 0 }, line: { borderWidth: 2 } },
    };

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
          data: samples.map(s => parseFloat(s.gps_speed) || 0),
          borderColor: CHART_COLORS.sapphire,
          borderDash: [5, 5],
          fill: false, tension: 0.2,
        }],
      },
      options: chartOptions,
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
          data: samples.map(s => parseFloat(s.bms_voltage) || 0),
          borderColor: CHART_COLORS.yellow,
          fill: false, tension: 0.2, yAxisID: 'y1',
        }, {
          label: 'BMS Current (A)',
          data: samples.map(s => parseFloat(s.bms_current) || 0),
          borderColor: CHART_COLORS.peach,
          fill: false, tension: 0.2, yAxisID: 'y1',
        }],
      },
      options: {
        ...chartOptions,
        scales: {
          ...chartOptions.scales,
          y: { position: 'left', title: { display: true, text: 'Battery %' }, min: 0, max: 100 },
          y1: { position: 'right', title: { display: true, text: 'V / A' }, grid: { drawOnChartArea: false } },
        },
      },
    });

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
        options: chartOptions,
      });
    } else {
      document.getElementById('altitudeChart').parentElement.style.display = 'none';
    }

    // Heart rate
    const hrSamples = samples.filter(s => parseFloat(s.heart_rate) > 0);
    if (hrSamples.length > 0) {
      new Chart(document.getElementById('heartRateChart'), {
        type: 'line',
        data: {
          labels: hrSamples.map(s => formatTime(s._time || s.time)),
          datasets: [{
            label: 'Heart Rate (bpm)',
            data: hrSamples.map(s => parseFloat(s.heart_rate)),
            borderColor: CHART_COLORS.red,
            backgroundColor: CHART_COLORS.red + '20',
            fill: true, tension: 0.3,
          }],
        },
        options: chartOptions,
      });
    } else {
      document.getElementById('heartRateChart').parentElement.style.display = 'none';
    }
  } else {
    document.querySelectorAll('.charts-grid .card').forEach(card => {
      card.innerHTML = '<p style="color: var(--subtext0); text-align: center; padding: 2rem;">No telemetry data available for this ride</p>';
    });
  }
}

loadRide();
