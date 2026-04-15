// GT3 Pro Dashboard — Main page logic
// Auth: relies on cookie-based session (same domain as fluxhaus-server)

const API_BASE = '/gt3';
let currentPage = 1;
const PAGE_SIZE = 20;

// Catppuccin Mocha chart palette
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
  overlay: '#6c7086',
};

Chart.defaults.color = CHART_COLORS.subtext;
Chart.defaults.borderColor = CHART_COLORS.surface;

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

const GEAR_NAMES = { 1: 'Eco', 2: 'Standard', 3: 'Sport', 4: 'Race' };
function gearName(mode) {
  if (mode == null) return 'Unknown';
  return GEAR_NAMES[mode] || `Mode ${mode}`;
}

// Weather condition → emoji mapping
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

function formatDistance(km) {
  if (km == null) return '—';
  return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(1)} km`;
}

function formatSpeed(kph) {
  return kph != null ? `${kph.toFixed(1)} km/h` : '—';
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

// Track chart instances so we can destroy before re-creating on pagination
const chartInstances = {};

function createChart(id, config) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
  }
  chartInstances[id] = new Chart(document.getElementById(id), config);
}

// ── Stats & Aggregate Charts ──────────────────────────────

async function loadStats() {
  const data = await apiFetch('/stats');
  if (!data) return;
  const s = data.summary;

  document.getElementById('stats-overview').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${parseInt(s.total_rides)}</div>
      <div class="stat-label">Total Rides</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${parseFloat(s.total_distance).toFixed(1)} km</div>
      <div class="stat-label">Total Distance</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${parseFloat(s.avg_battery_per_km).toFixed(1)}%</div>
      <div class="stat-label">Avg Battery/km</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${parseFloat(s.all_time_max_speed).toFixed(1)} km/h</div>
      <div class="stat-label">Top Speed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${parseFloat(s.overall_avg_speed).toFixed(1)} km/h</div>
      <div class="stat-label">Avg Speed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${parseFloat(s.avg_battery_per_ride).toFixed(0)}%</div>
      <div class="stat-label">Avg Battery/Ride</div>
    </div>
  `;

  // Monthly chart
  if (data.monthly && data.monthly.length > 0) {
    createChart('monthlyChart', {
      type: 'bar',
      data: {
        labels: data.monthly.map(m => {
          const d = new Date(m.month);
          return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
        }),
        datasets: [{
          label: 'Distance (km)',
          data: data.monthly.map(m => parseFloat(m.distance)),
          backgroundColor: CHART_COLORS.sky + '80',
          borderColor: CHART_COLORS.sky,
          borderWidth: 1,
          yAxisID: 'y',
        }, {
          label: 'Rides',
          data: data.monthly.map(m => parseInt(m.rides)),
          backgroundColor: CHART_COLORS.mauve + '80',
          borderColor: CHART_COLORS.mauve,
          borderWidth: 1,
          yAxisID: 'y1',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { position: 'left', title: { display: true, text: 'Distance (km)' } },
          y1: { position: 'right', title: { display: true, text: 'Rides' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // Gear mode chart
  if (data.byGearMode && data.byGearMode.length > 0) {
    createChart('gearChart', {
      type: 'bar',
      data: {
        labels: data.byGearMode.map(g => gearName(g.gear_mode)),
        datasets: [{
          label: 'Avg Speed (km/h)',
          data: data.byGearMode.map(g => parseFloat(g.avg_speed)),
          backgroundColor: CHART_COLORS.sapphire + '80',
          borderColor: CHART_COLORS.sapphire,
          borderWidth: 1,
        }, {
          label: 'Battery/km (%)',
          data: data.byGearMode.map(g => parseFloat(g.avg_battery_per_km)),
          backgroundColor: CHART_COLORS.peach + '80',
          borderColor: CHART_COLORS.peach,
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
      },
    });
  }
}

// ── Rides Table & Per-Page Charts ─────────────────────────

async function loadRides(page = 1) {
  currentPage = page;
  const data = await apiFetch(`/rides?page=${page}&limit=${PAGE_SIZE}`);
  if (!data) return;

  const tbody = document.getElementById('rides-body');
  if (!data.rides || data.rides.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:2rem">No rides found</td></tr>';
    return;
  }

  tbody.innerHTML = data.rides.map(r => `
    <tr>
      <td>${formatDate(r.start_time)}</td>
      <td>${formatDistance(r.distance)}</td>
      <td>${formatSpeed(r.max_speed)}</td>
      <td>${formatSpeed(r.avg_speed)}</td>
      <td><span class="battery-badge">${r.start_battery ?? '?'}% → ${r.end_battery ?? '?'}%</span></td>
      <td><span class="gear-badge gear-${r.gear_mode}">${gearName(r.gear_mode)}</span></td>
      <td>${r.weather_temp != null ? `${weatherEmoji(r.weather_condition)} ${r.weather_temp.toFixed(0)}°C` : '—'}</td>
      <td><a href="/gt3/ride.html?id=${r.id}" class="btn-small">Details →</a></td>
    </tr>
  `).join('');

  // Distance & battery charts from current page rides
  const rides = data.rides.slice().reverse();
  if (rides.length > 1) {
    createChart('distanceChart', {
      type: 'line',
      data: {
        labels: rides.map(r => formatDate(r.start_time)),
        datasets: [{
          label: 'Distance (km)',
          data: rides.map(r => r.distance),
          borderColor: CHART_COLORS.sky,
          backgroundColor: CHART_COLORS.sky + '20',
          fill: true,
          tension: 0.3,
        }],
      },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });

    createChart('batteryChart', {
      type: 'line',
      data: {
        labels: rides.map(r => formatDate(r.start_time)),
        datasets: [{
          label: 'Battery Used (%)',
          data: rides.map(r => r.battery_used),
          borderColor: CHART_COLORS.peach,
          backgroundColor: CHART_COLORS.peach + '20',
          fill: true,
          tension: 0.3,
        }],
      },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });
  }

  // Pagination controls
  const pag = document.getElementById('pagination');
  pag.innerHTML = '';
  if (page > 1) {
    const prev = document.createElement('button');
    prev.textContent = '← Previous';
    prev.onclick = () => loadRides(page - 1);
    pag.appendChild(prev);
  }
  if (data.rides.length === PAGE_SIZE) {
    const next = document.createElement('button');
    next.textContent = 'Next →';
    next.onclick = () => loadRides(page + 1);
    pag.appendChild(next);
  }
}

// ── Init ──────────────────────────────────────────────────

loadStats();
loadRides();
