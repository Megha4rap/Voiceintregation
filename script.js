/* OpenStreetMap Voice – script.js
 * OpenStreetMap is a free, editable map of the world made by volunteers.
 * This script uses its open data to let users SPEAK a place or a route and
 * HEAR the description and walking directions.
 */
const $ = id => document.getElementById(id);
const status = $('status');
let lastText = '', myLoc = null, listening = false;

/* ---------- Map ---------- */
const map = L.map('map', { zoomControl: false }).setView([12.9716, 77.5946], 12);
const tilesStd = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
tilesStd.addTo(map);
// Dark look without a paid tile service: standard OSM tiles with a CSS filter
let darkMap = true; map.getContainer().classList.add('dark-tiles');
let layer = L.layerGroup().addTo(map);
$('zin').onclick = () => map.zoomIn();
$('zout').onclick = () => map.zoomOut();

/* ---------- Helpers ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const metres = m => m < 1000 ? Math.round(m / 10) * 10 + ' metres' : (m / 1000).toFixed(1) + ' kilometres';

function setStatus(msg, kind) {
  progress(kind);
  const col = { ok: 'border-emerald-400', bad: 'border-red-400', load: 'border-yellow-300' }[kind] || 'border-slate-500';
  status.className = 'm-4 p-3 rounded-md bg-black/25 border-l-4 ' + col;
  status.innerHTML = (kind === 'load' ? '<span class="inline-block w-4 h-4 mr-2 align-[-2px] rounded-full border-[3px] border-yellow-300 border-t-transparent animate-spin"></span>' : '') + msg;
}

function speak(text) {
  lastText = text;
  if (!('speechSynthesis' in window)) { setStatus('This browser cannot speak aloud. The text is shown on the page.', 'bad'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = +$('rate').value; u.lang = 'en-IN';
  speechSynthesis.speak(u);
}

function dist(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function compass(a, b, c, d) {
  const r = Math.PI / 180, y = Math.sin((d - b) * r) * Math.cos(c * r),
    x = Math.cos(a * r) * Math.sin(c * r) - Math.sin(a * r) * Math.cos(c * r) * Math.cos((d - b) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
}

/* ---------- Fetch + JSON ---------- */
async function getJSON(urls, label, ms = 12000) {
  urls = [].concat(urls); let lastErr;
  for (const url of urls) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(label + ' answered with status ' + r.status + '.');
      return await r.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(label + ' took too long.')
        : (e.message || '').includes('answered with status') ? e
        : new Error('Could not reach ' + label + '. Open this page in Chrome or Edge from your computer (not inside a preview window) and check your internet.');
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}
async function geocode(q) {
  if (q === 'My location' && myLoc) return myLoc;
  try {
    const d = await getJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q), 'the place search (Nominatim)');
    return Array.isArray(d) && d.length ? { name: d[0].display_name, lat: +d[0].lat, lon: +d[0].lon } : null;
  } catch (e) {
    // backup place search if Nominatim is blocked or slow
    const d = await getJSON('https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q), 'the backup place search (Photon)');
    const f = d.features && d.features[0]; if (!f) return null;
    const p = f.properties, c = f.geometry.coordinates;
    return { name: [p.name, p.street, p.city, p.country].filter(Boolean).join(', '), lat: c[1], lon: c[0] };
  }
}
async function nearby(p) {
  const q = `[out:json][timeout:15];node(around:300,${p.lat},${p.lon})["name"]["amenity"];out 40;`;
  const els = await ovp(q);
  return els.map(e => ({
    name: e.tags.name, kind: e.tags.amenity.replace(/_/g, ' '),
    m: dist(p.lat, p.lon, e.lat, e.lon), dir: compass(p.lat, p.lon, e.lat, e.lon), lat: e.lat, lon: e.lon, wc: e.tags.wheelchair
  })).sort((a, b) => a.m - b.m).slice(0, 6);
}
async function route(a, b) {
  const d = await getJSON(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${a.lon},${a.lat};${b.lon},${b.lat}?steps=true&overview=full&geometries=geojson`, 'the walking route service (OSM routing)');
  if (!d.routes || !d.routes.length) return null;
  const r = d.routes[0];
  return { total: r.distance, mins: Math.round(r.duration / 60), geo: r.geometry, steps: r.legs[0].steps.map(stepText), locs: r.legs[0].steps.map(s => s.maneuver.location) };
}
function stepText(s) {
  const m = s.maneuver, mod = m.modifier ? m.modifier.replace('slight ', 'bear ') : '', road = s.name ? ' onto ' + s.name : '';
  const v = m.type === 'depart' ? 'Start walking ' + mod + (s.name ? ' on ' + s.name : '') :
    m.type === 'arrive' ? 'You have arrived' :
    ['turn', 'end of road', 'fork'].includes(m.type) ? 'Turn ' + mod + road : 'Continue ' + (mod || 'straight') + road;
  return s.distance > 0 && m.type !== 'arrive' ? v + ', and go ' + metres(s.distance) : v;
}

/* ---------- Render ---------- */
function render(from, near, rt, toName, to) {
  layer.clearLayers(); lastFrom = from; lastRoute = rt;
  L.marker([from.lat, from.lon]).addTo(layer).bindPopup('You are here');
  near.forEach(n => L.circleMarker([n.lat, n.lon], { radius: 6, color: '#ffd54a' }).addTo(layer).bindPopup(n.name));
  if (rt && to) {
    L.marker([to.lat, to.lon]).addTo(layer).bindPopup('Destination');
    const g = L.geoJSON(rt.geo, { style: { color: '#4fc3f7', weight: 5 } }).addTo(layer);
    map.fitBounds(g.getBounds(), { padding: [40, 40] });
  } else map.setView([from.lat, from.lon], 16);

  $('sum').textContent = 'You are near ' + from.name.split(',').slice(0, 3).join(',') + '.';
  $('near').innerHTML = near.length ? near.map(n => `<li data-cat="${cat(n.kind)}" class="near-item rounded-lg bg-white/5 px-3 py-2">${EMO[cat(n.kind)]} <b>${esc(n.name)}</b>, ${esc(n.kind)}, ${metres(n.m)} ${n.dir}.${wcTag(n.wc)}</li>`).join('')
    : '<li>No named places within 300 metres. Try a busier address.</li>';
  $('steps').innerHTML = rt ? rt.steps.map(s => `<li class="step rounded-lg bg-white/5 px-3 py-2 flex gap-3 items-start border-l-4 border-transparent"><span class="text-xl" aria-hidden="true">${arrow(s)}</span><span>${esc(s)}.</span></li>`).join('')
    : '<li>' + (toName ? 'No walking route was found to that destination.' : 'Add a destination to get directions.') + '</li>';

  let t = $('sum').textContent + ' ';
  t += near.length ? 'Nearby: ' + near.slice(0, 4).map(n => `${n.kind} ${n.name}, ${metres(n.m)} ${n.dir}${wcSpeech(n.wc)}`).join('. ') + '. ' : 'No named places within 300 metres. ';
  if (rt) t += `Walking to ${toName.split(',')[0]} is ${metres(rt.total)}, about ${rt.mins} minutes. ` + rt.steps.join('. ') + '.';
  $('say').disabled = $('stop').disabled = false;
  afterRender(from, near, rt, toName);
  setStatus('Ready. Reading the results aloud.', 'ok');
  speak(t);
}

/* ---------- Validation ---------- */
function check(inp, err, required) {
  const v = inp.value.trim(); let m = '';
  if (!v && required) m = 'Say or type where you are, for example “Cubbon Park, Bengaluru”.';
  else if (v && v !== 'My location' && v.length < 3) m = 'Use at least 3 characters.';
  else if (v && /^[\d\s.,-]+$/.test(v)) m = 'Use a place name or address, not only numbers.';
  err.textContent = m; inp.setAttribute('aria-invalid', m ? 'true' : 'false');
  return !m;
}

/* ---------- Main search ---------- */
async function search() {
  const a = check($('from'), $('e1'), true), b = check($('to'), $('e2'), false);
  if (!a || !b) { setStatus('Please fix the marked field and try again.', 'bad'); speak('Please fix the marked field and try again.'); (a ? $('to') : $('from')).focus(); return; }
  $('go').disabled = true; setStatus('Searching OpenStreetMap…', 'load');
  try {
    const from = await geocode($('from').value.trim());
    if (!from) { setStatus('No place found for “' + esc($('from').value) + '”. Try adding the city name.', 'bad'); speak('No place found. Try adding the city name.'); return; }
    setStatus('Finding nearby places…', 'load');
    let nearFailed = false;
    const near = await nearby(from).catch(() => { nearFailed = true; return []; });
    let rt = null, toName = '', to = null;
    if ($('to').value.trim()) {
      setStatus('Finding a walking route…', 'load');
      to = await geocode($('to').value.trim());
      if (!to) setStatus('Your destination was not found. Showing your surroundings only.', 'bad');
      else { toName = to.name; rt = await route(from, to); }
    }
    render(from, near, rt, toName, to);
    if (nearFailed) { const m = 'Nearby places could not be loaded right now, but your route is ready.'; setStatus(m, 'bad'); }
  } catch (e) {
    setStatus(esc(e.message) + ' You can press “Sample data” to try the tool offline.', 'bad');
    speak(e.message);
  } finally { $('go').disabled = false; }
}

/* ---------- Voice input ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(button, onText) {
  if (!SR) { setStatus('Voice input is not supported in this browser. Use Chrome or Edge, or type instead.', 'bad'); return; }
  if (listening) return;
  const rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false; rec.maxAlternatives = 1;
  listening = true; button.classList.add('listening'); setStatus('Listening… speak now.', 'load');
  rec.onresult = e => onText(e.results[0][0].transcript.trim());
  rec.onerror = e => {
    const msg = { 'no-speech': 'I did not hear anything. Press the microphone and try again.',
      'not-allowed': 'Microphone permission was blocked. Allow it in the browser address bar.',
      'network': 'Voice recognition needs an internet connection.' }[e.error] || 'Voice input failed. Please try again or type.';
    setStatus(msg, 'bad'); speak(msg);
  };
  rec.onend = () => { listening = false; button.classList.remove('listening'); };
  rec.start();
}

function useMyLocation(cb) {
  if (!navigator.geolocation) { setStatus('This browser cannot find your location. Type a place instead.', 'bad'); return; }
  setStatus('Finding your location…', 'load');
  navigator.geolocation.getCurrentPosition(async p => {
    myLoc = { name: 'your current location', lat: p.coords.latitude, lon: p.coords.longitude };
    $('from').value = 'My location'; $('e1').textContent = '';
    setStatus('Location found.', 'ok'); if (cb) cb();
  }, () => { setStatus('Location permission was blocked. Type or say a place instead.', 'bad'); speak('Location permission was blocked.'); },
  { timeout: 10000 });
}

function handleCommand(t) {
  const s = t.toLowerCase().replace(/[.,]/g, '');
  if (/^(stop|be quiet|cancel)/.test(s)) { speechSynthesis.cancel(); setStatus('Stopped.', 'ok'); return; }
  if (/^(next|continue)/.test(s)) { return nextStep(1); }
  if (/^(back|previous|go back)/.test(s)) { return nextStep(-1); }
  if (/(read again|repeat)/.test(s)) { speak(lastText); return; }
  let m;
  if ((m = s.match(/from (.+?) to (.+)/))) { $('from').value = m[1]; $('to').value = m[2]; return search(); }
  if ((m = s.match(/(?:directions|route|take me|navigate|go) to (.+)/))) { $('to').value = m[1]; return useMyLocation(search); }
  if (/(where am i|around me|near me)/.test(s)) { $('to').value = ''; return useMyLocation(search); }
  if (/(food|restaurant|where.*eat)/.test(s)) return findNearby('food');
  if (/(ramp|wheelchair|accessib|lift)/.test(s)) return findAccess(lastRoute ? 'route' : 'point', false);
  $('from').value = s; $('to').value = ''; search();
}

/* ---------- EVENTS ---------- */
// 1) submit: typed search
$('form').addEventListener('submit', e => { e.preventDefault(); search(); });

// 2) click: voice and control buttons
$('micCmd').addEventListener('click', () => listen($('micCmd'), handleCommand));
$('micFrom').addEventListener('click', () => listen($('micFrom'), t => { $('from').value = t; check($('from'), $('e1'), true); setStatus('Heard: ' + esc(t), 'ok'); speak('You said ' + t); }));
$('micTo').addEventListener('click', () => listen($('micTo'), t => { $('to').value = t; check($('to'), $('e2'), false); setStatus('Heard: ' + esc(t), 'ok'); speak('Destination ' + t); }));
$('locate').addEventListener('click', () => useMyLocation());
$('say').addEventListener('click', () => speak(lastText));
$('stop').addEventListener('click', () => { speechSynthesis.cancel(); setStatus('Stopped.', 'ok'); });
$('helpBtn').addEventListener('click', () => $('helpDlg').showModal());
$('closeHelp').addEventListener('click', () => $('helpDlg').close());
$('sample').addEventListener('click', () => {
  const from = { name: 'Cubbon Park, Bengaluru, India', lat: 12.9763, lon: 77.5929 };
  const to = { lat: 12.9719, lon: 77.6012 };
  const near = [{ name: 'State Central Library', kind: 'library', m: 140, dir: 'north-east', lat: 12.9775, lon: 77.5935 },
                { name: 'High Court Canteen', kind: 'cafe', m: 220, dir: 'south', lat: 12.9743, lon: 77.5925 }];
  const rt = { total: 900, mins: 11, geo: { type: 'LineString', coordinates: [[77.5929, 12.9763], [77.5970, 12.9740], [77.6012, 12.9719]] },
    steps: ['Start walking east on Kasturba Road, and go 300 metres', 'Turn right onto MG Road, and go 500 metres', 'Turn left onto Church Street, and go 100 metres', 'You have arrived'],
    locs: [[77.5929, 12.9763], [77.5950, 12.9755], [77.5990, 12.9730], [77.6012, 12.9719]] };
  render(from, near, rt, 'Church Street, Bengaluru', to);
  setStatus('Showing built-in sample data (no network used).', 'ok');
});

// 3) keydown: shortcuts; blur and change: live validation and feedback
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') speechSynthesis.cancel();
  if (e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); $('micCmd').click(); }
  if (e.altKey && e.key.toLowerCase() === 'r' && !$('say').disabled) { e.preventDefault(); speak(lastText); }
});
$('from').addEventListener('blur', () => { if ($('from').value) check($('from'), $('e1'), true); });
$('to').addEventListener('blur', () => { if ($('to').value) check($('to'), $('e2'), false); });
$('rate').addEventListener('change', () => { if (lastText) setStatus('Voice speed changed. Press Read again to hear it.', 'ok'); });

/* ================= EXTRA FEATURES ================= */

// Progress bar under the sidebar title
let barTimer;
function progress(kind) {
  const b = $('bar'); if (!b) return;
  clearTimeout(barTimer);
  b.style.width = kind === 'load' ? '65%' : kind ? '100%' : '0';
  if (kind !== 'load') barTimer = setTimeout(() => b.style.width = '0', 900);
}

// Place categories and emoji
const EMO = { food: '🍽️', health: '💊', transport: '🚌', money: '🏧', learn: '📚', other: '📍' };
const CATS = {
  food: ['restaurant', 'cafe', 'fast food', 'food court', 'bar', 'pub', 'ice cream', 'bakery'],
  health: ['pharmacy', 'hospital', 'clinic', 'doctors', 'dentist'],
  transport: ['bus station', 'taxi', 'fuel', 'parking', 'bicycle rental', 'bus stop'],
  money: ['bank', 'atm'],
  learn: ['school', 'college', 'library', 'university', 'kindergarten']
};
const cat = kind => Object.keys(CATS).find(k => CATS[k].includes(kind)) || 'other';

// Direction arrow icon from step wording
function arrow(t) {
  t = t.toLowerCase();
  if (t.includes('arrived')) return '🏁';
  if (t.includes('turn left') || t.includes('bear left')) return '⬅️';
  if (t.includes('turn right') || t.includes('bear right')) return '➡️';
  if (t.includes('u-turn') || t.includes('uturn')) return '↩️';
  if (t.startsWith('start')) return '🚶';
  return '⬆️';
}

// Called after every successful render
let cur = null;
function afterRender(from, near, rt, toName) {
  cur = rt ? { steps: rt.steps, locs: rt.locs || [], idx: -1 } : null;
  $('stats').classList.remove('hidden');
  $('stDist').textContent = rt ? metres(rt.total) : '—';
  $('stTime').textContent = rt ? rt.mins + ' min' : '—';
  $('stPlaces').textContent = near.length;
  ['prev', 'repeat', 'next', 'copy'].forEach(id => $(id).disabled = !rt);
  applyFilter('all');
  if ($('from').value.trim() !== 'My location') saveHist($('from').value.trim(), $('to').value.trim());
  if (rt) findAccess('route', true); else accItems = [];
}

// Step-by-step walking mode: speak one step, highlight it, fly the map to it
function nextStep(d) {
  if (!cur) { speak('There are no walking steps yet. Ask for directions first.'); return; }
  cur.idx = Math.min(cur.steps.length - 1, Math.max(0, cur.idx + d));
  showStep();
}
function showStep() {
  document.querySelectorAll('#steps .step').forEach((li, i) => {
    const on = i === cur.idx;
    li.classList.toggle('border-yellow-300', on); li.classList.toggle('bg-yellow-300/20', on);
    if (on) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const loc = cur.locs[cur.idx];
  if (loc) map.flyTo([loc[1], loc[0]], 18, { duration: 0.8 });
  speak('Step ' + (cur.idx + 1) + ' of ' + cur.steps.length + '. ' + cur.steps[cur.idx]);
  if (loc) speakNearStep(loc);
}

// Nearby filter chips
function applyFilter(f) {
  document.querySelectorAll('#chips .chip').forEach(c => {
    const on = c.dataset.f === f;
    c.classList.toggle('bg-yellow-300', on); c.classList.toggle('text-black', on);
    c.classList.toggle('bg-white/10', !on); c.classList.toggle('font-semibold', on);
  });
  let shown = 0;
  document.querySelectorAll('#near .near-item').forEach(li => {
    const ok = f === 'all' || li.dataset.cat === f; li.hidden = !ok; if (ok) shown++;
  });
  const note = $('near').querySelector('.empty-note');
  if (note) note.remove();
  if (!shown && document.querySelector('#near .near-item'))
    $('near').insertAdjacentHTML('beforeend', '<li class="empty-note text-slate-400">No places in this group nearby. Try “All”.</li>');
}

// Recent searches (saved in this browser)
function loadHist() { try { return JSON.parse(localStorage.getItem('osmv_hist')) || []; } catch (e) { return []; } }
function saveHist(from, to) {
  if (!from) return;
  try {
    const h = loadHist().filter(x => !(x.from === from && x.to === to));
    h.unshift({ from, to }); localStorage.setItem('osmv_hist', JSON.stringify(h.slice(0, 5)));
  } catch (e) { /* storage blocked: ignore */ }
  renderHist();
}
function renderHist() {
  const h = loadHist();
  $('hist').innerHTML = h.length ? '<span class="text-sm text-slate-400 self-center">Recent:</span>' +
    h.map((x, i) => `<button data-i="${i}" class="rounded-full bg-white/10 hover:bg-white/20 px-3 py-1 text-sm">🕘 ${esc(x.from.split(',')[0])}${x.to ? ' → ' + esc(x.to.split(',')[0]) : ''}</button>`).join('') : '';
}
renderHist();

/* ---------- Events for the extra features ---------- */
$('chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) applyFilter(b.dataset.f); });
$('hist').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const x = loadHist()[+b.dataset.i]; if (x) { $('from').value = x.from; $('to').value = x.to; search(); }
});
$('next').addEventListener('click', () => nextStep(1));
$('prev').addEventListener('click', () => nextStep(-1));
$('repeat').addEventListener('click', () => { if (cur) { if (cur.idx < 0) cur.idx = 0; showStep(); } });
$('copy').addEventListener('click', async () => {
  if (!cur) return;
  const text = cur.steps.map((s, i) => (i + 1) + '. ' + s).join('\n');
  try { await navigator.clipboard.writeText(text); setStatus('Directions copied. You can paste them anywhere.', 'ok'); }
  catch (e) { setStatus('Could not copy. Select the steps and copy them manually.', 'bad'); }
});
$('swap').addEventListener('click', () => {
  const a = $('from').value, b = $('to').value;
  if (!a && !b) { setStatus('Nothing to swap yet. Enter a start and a destination.', 'bad'); return; }
  $('from').value = b; $('to').value = a;
  setStatus('Start and destination swapped.', 'ok');
});
$('layerBtn').addEventListener('click', () => {
  darkMap = !darkMap;
  map.getContainer().classList.toggle('dark-tiles', darkMap);
  setStatus(darkMap ? 'Dark map style on.' : 'Standard map style on.', 'ok');
});
let fs = 16;
$('fontUp').addEventListener('click', () => { fs = Math.min(24, fs + 2); document.documentElement.style.fontSize = fs + 'px'; setStatus('Text size ' + fs + '.', 'ok'); });
$('fontDown').addEventListener('click', () => { fs = Math.max(14, fs - 2); document.documentElement.style.fontSize = fs + 'px'; setStatus('Text size ' + fs + '.', 'ok'); });
document.addEventListener('keydown', e => {
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); nextStep(1); }
  if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); nextStep(-1); }
});

/* ---------- Connection test (shows which service is blocked) ---------- */
async function testApis() {
  setStatus('Testing connection to each service…', 'load');
  const tests = [
    ['Place search', 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Bengaluru'],
    ['Backup place search', 'https://photon.komoot.io/api/?limit=1&q=Bengaluru'],
    ['Nearby places', 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent('[out:json][timeout:8];node(1);out;')],
    ['Walking routes', 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/77.5929,12.9763;77.6012,12.9719?overview=false']
  ];
  const res = await Promise.allSettled(tests.map(t => getJSON(t[1], t[0])));
  const lines = res.map((r, i) => (r.status === 'fulfilled' ? '✔ ' : '✖ ') + tests[i][0]);
  const bad = res.filter(r => r.status === 'rejected').length;
  setStatus(lines.join('<br>') + (bad ? '<br>Some services are blocked. Open the page from your computer in Chrome or Edge, or use Sample data.' : '<br>All services reachable.'), bad ? 'bad' : 'ok');
}
$('testBtn').addEventListener('click', testApis);

/* ================= NEARBY BUTTONS + ACCESSIBILITY ================= */
let lastFrom = null, lastRoute = null, accItems = [];
const qlayer = L.layerGroup().addTo(map), alayer = L.layerGroup().addTo(map);

const wcTag = wc => ({ yes: ' <span class="text-sky-300">♿ wheelchair accessible</span>', limited: ' <span class="text-amber-300">♿ partly accessible</span>', no: ' <span class="text-red-300">⛔ not wheelchair accessible</span>' }[wc] || '');
const wcSpeech = wc => ({ yes: ', wheelchair accessible', limited: ', partly wheelchair accessible', no: ', not wheelchair accessible' }[wc] || '');

const OVP = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let backupUsed = false;
async function ovp(q) {
  const urls = OVP.map(u => u + '?data=' + encodeURIComponent(q));
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const d = await getJSON(urls, 'the nearby places service (Overpass)', 25000); return d.elements || []; }
    catch (e) { if (attempt) throw new Error('The nearby places service is busy or blocked on your network. Wait a few seconds and try again, or press Test connection.'); await new Promise(r => setTimeout(r, 2000)); }
  }
}
// Click-button search: Overpass first, then a backup through Nominatim (fewer details)
async function nearbyEls(c, a) {
  backupUsed = false;
  try { return await ovp(`[out:json][timeout:20];nwr(around:${c.r},${a.lat},${a.lon})${c.f};out center 40;`); }
  catch (e) {
    try {
      const dLat = c.r / 111000, dLon = c.r / (111000 * Math.cos(a.lat * Math.PI / 180));
      const vb = [a.lon - dLon, a.lat + dLat, a.lon + dLon, a.lat - dLat].join(',');
      const d = await getJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=20&bounded=1&viewbox=' + vb + '&q=' + encodeURIComponent(c.term), 'the backup place search (Nominatim)');
      backupUsed = true;
      return d.map(x => ({ lat: +x.lat, lon: +x.lon, tags: { name: x.name || x.display_name.split(',')[0], amenity: x.type } }));
    } catch (e2) { throw new Error('Nearby places could not be loaded. The map data services may be busy or blocked on your network. Press Test connection to see which one.'); }
  }
}
const pos = e => e.lat != null ? [e.lat, e.lon] : e.center ? [e.center.lat, e.center.lon] : null;
function anchor() {
  if (lastFrom) return { lat: lastFrom.lat, lon: lastFrom.lon, label: 'your searched place' };
  const c = map.getCenter(); return { lat: c.lat, lon: c.lng, label: 'the map centre' };
}
function speakQueued(t, keep) {   // adds to the speech queue without cutting off what is playing
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(t); u.rate = +$('rate').value; u.lang = 'en-IN';
  speechSynthesis.speak(u); if (!keep) lastText += ' ' + t;
}

/* ---- Click a button → list that kind of place nearby (food spots etc.) ---- */
const Q = {
  food: { label: 'food spots', term: 'restaurant', r: 500, emo: '🍽️', f: '["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]' },
  pharmacy: { label: 'pharmacies and clinics', term: 'pharmacy', r: 800, emo: '💊', f: '["amenity"~"^(pharmacy|hospital|clinic)$"]' },
  atm: { label: 'ATMs and banks', term: 'atm', r: 800, emo: '🏧', f: '["amenity"~"^(atm|bank)$"]' },
  bus: { label: 'bus stops', term: 'bus stop', r: 500, emo: '🚌', f: '["highway"="bus_stop"]' }
};
async function findNearby(key) {
  const c = Q[key], a = anchor(), box = $('qres');
  box.innerHTML = `<p class="rounded-lg bg-white/5 p-3">Looking for ${c.label}…</p>`;
  setStatus('Looking for ' + c.label + '…', 'load');
  try {
    const els = await nearbyEls(c, a);
    const items = els.map(e => {
      const p = pos(e); if (!p) return null;
      return { name: e.tags.name || c.label.replace(/s$/, ''), kind: (e.tags.amenity || '').replace(/_/g, ' '), lat: p[0], lon: p[1],
        m: dist(a.lat, a.lon, p[0], p[1]), dir: compass(a.lat, a.lon, p[0], p[1]), wc: e.tags.wheelchair };
    }).filter(Boolean).sort((x, y) => x.m - y.m).slice(0, 8);
    qlayer.clearLayers();
    if (!items.length) {
      const msg = `No ${c.label} are mapped within ${c.r} metres of ${a.label}. Search another place or move the map, then try again.`;
      box.innerHTML = `<p class="rounded-lg bg-white/5 p-3">${esc(msg)}</p>`; setStatus(msg, 'ok'); speak(msg); return;
    }
    items.forEach(n => L.circleMarker([n.lat, n.lon], { radius: 8, color: '#ff8a65', fillOpacity: .8 }).addTo(qlayer).bindPopup(n.name));
    const say = n => `${n.name}${n.kind ? ', ' + n.kind : ''}, ${metres(n.m)} ${n.dir}${wcSpeech(n.wc)}`;
    box.innerHTML = `<h3 class="font-bold mb-2">${c.emo} ${items.length} ${c.label} near ${esc(a.label)}</h3><ul class="space-y-2">` +
      items.map(n => `<li><button class="qi w-full text-left rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2" data-lat="${n.lat}" data-lon="${n.lon}" data-say="${esc(say(n))}">
        <b>${esc(n.name)}</b>, ${metres(n.m)} ${n.dir}.${wcTag(n.wc)}</button></li>`).join('') + '</ul>';
    map.fitBounds(L.latLngBounds(items.map(n => [n.lat, n.lon]).concat([[a.lat, a.lon]])), { padding: [40, 40] });
    setStatus(`Found ${items.length} ${c.label}. Click one to hear it and see it on the map.` + (backupUsed ? ' Backup search used, so there are fewer details.' : ''), 'ok');
    speak(`Found ${items.length} ${c.label} near ${a.label}. ` + items.slice(0, 4).map(say).join('. ') + '.');
  } catch (e) {
    box.innerHTML = `<p class="rounded-lg bg-red-500/20 p-3">${esc(e.message)}</p>`; setStatus(esc(e.message), 'bad'); speak(e.message);
  }
}

/* ---- Wheelchair, ramp, lift, tactile paving: near a point or ALONG the route ---- */
function accLabel(t) {
  if (t.ramp === 'yes') return 'Ramp';
  if (t.kerb === 'lowered') return 'Lowered kerb';
  if (t.highway === 'elevator') return 'Lift';
  if (t.amenity === 'toilets' && t.wheelchair === 'yes') return 'Accessible toilet';
  if (t.tactile_paving === 'yes') return 'Tactile paving for blind walkers';
  if (t.wheelchair) return (t.name || t.amenity || t.shop || 'Place') + ({ yes: ', wheelchair accessible', limited: ', partly wheelchair accessible', no: ', NOT wheelchair accessible' }[t.wheelchair] || ', wheelchair info: ' + t.wheelchair);
  return 'Accessibility feature';
}
function sampleRoute(co) {
  const step = Math.max(1, Math.ceil(co.length / 25)), out = co.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== co[co.length - 1]) out.push(co[co.length - 1]); return out;
}
async function findAccess(mode, silent) {
  const box = $('accres'), a = anchor(); let around, path = null, cum = [];
  if (mode === 'route' && lastRoute && lastRoute.geo) {
    path = sampleRoute(lastRoute.geo.coordinates);
    path.forEach((p, i) => cum.push(i ? cum[i - 1] + dist(path[i - 1][1], path[i - 1][0], p[1], p[0]) : 0));
    around = 'around:30,' + path.map(p => p[1] + ',' + p[0]).join(',');
  } else around = `around:200,${a.lat},${a.lon}`;
  const body = ['["wheelchair"]', '["ramp"="yes"]', '["kerb"="lowered"]', '["highway"="elevator"]', '["tactile_paving"="yes"]'].map(f => `nwr(${around})${f};`).join('');
  box.innerHTML = '<p class="rounded-lg bg-white/5 p-3">Checking ramps, lifts and wheelchair access' + (path ? ' along your route' : ' nearby') + '…</p>';
  if (!silent) setStatus('Checking accessibility information…', 'load');
  try {
    const els = await ovp(`[out:json][timeout:20];(${body});out center 80;`);
    let items = els.map(e => {
      const p = pos(e); if (!p) return null;
      const it = { label: accLabel(e.tags), lat: p[0], lon: p[1], bad: e.tags.wheelchair === 'no', m: dist(a.lat, a.lon, p[0], p[1]), dir: compass(a.lat, a.lon, p[0], p[1]), along: 0 };
      if (path) { let bi = 0, bd = 1e12; path.forEach((q, i) => { const d = dist(p[0], p[1], q[1], q[0]); if (d < bd) { bd = d; bi = i; } }); it.along = cum[bi]; }
      return it;
    }).filter(Boolean);
    items.sort((x, y) => path ? x.along - y.along : x.m - y.m); items = items.slice(0, 12);
    accItems = items; alayer.clearLayers();
    if (!items.length) {
      const msg = 'No ramps, lowered kerbs, lifts or wheelchair details are mapped ' + (path ? 'along this route' : 'here') + '. This usually means nobody has added them to OpenStreetMap yet, not that none exist. You can report it with the Feedback form.';
      box.innerHTML = `<p class="rounded-lg bg-white/5 p-3">${esc(msg)}</p>`; if (!silent) { setStatus(msg, 'ok'); speak(msg); } return;
    }
    const line = it => `${it.label}, ${path ? 'about ' + metres(it.along) + ' along your route' : metres(it.m) + ' ' + it.dir}`;
    items.forEach(it => L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: `<div style="font-size:22px">${it.bad ? '⛔' : '♿'}</div>` }) }).addTo(alayer).bindPopup(esc(it.label)));
    box.innerHTML = `<h3 class="font-bold mb-2">♿ ${items.length} accessibility details ${path ? 'along your route' : 'nearby'}</h3><ul class="space-y-2">` +
      items.map(it => `<li><button class="qi w-full text-left rounded-lg ${it.bad ? 'bg-red-500/15' : 'bg-sky-500/15'} px-3 py-2" data-lat="${it.lat}" data-lon="${it.lon}" data-say="${esc(line(it))}">${it.bad ? '⛔' : '♿'} ${esc(line(it))}.</button></li>`).join('') +
      '</ul><p class="text-xs text-slate-400 mt-2">From OpenStreetMap. Coverage varies, so check on the ground.</p>';
    const text = (path ? 'Accessibility on your route: ' : 'Accessibility nearby: ') + items.slice(0, 5).map(line).join('. ') + '.';
    if (silent) speakQueued(text); else { setStatus('Found ' + items.length + ' accessibility details.', 'ok'); speak(text); }
  } catch (e) {
    box.innerHTML = `<p class="rounded-lg bg-red-500/20 p-3">Accessibility details could not be loaded. ${esc(e.message)}</p>`;
    if (!silent) { setStatus(esc(e.message), 'bad'); speak(e.message); }
  }
}
function speakNearStep(loc) {   // in step-by-step mode, mention ramps close to this step
  const near = accItems.filter(it => dist(it.lat, it.lon, loc[1], loc[0]) < 40);
  if (near.length) speakQueued('Near here: ' + near.slice(0, 3).map(it => it.label).join(', ') + '.', true);
}

/* ---- Events ---- */
document.querySelectorAll('.q').forEach(b => b.addEventListener('click', () => findNearby(b.dataset.q)));
$('accBtn').addEventListener('click', () => findAccess(lastRoute ? 'route' : 'point', false));
['qres', 'accres'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('.qi'); if (!b) return;
  map.flyTo([+b.dataset.lat, +b.dataset.lon], 18, { duration: .8 }); speak(b.dataset.say);
}));

/* ================= FEEDBACK FORM ================= */
const FB = {
  name: v => !v ? 'Enter your name.' : v.length < 2 ? 'Name needs at least 2 characters.' : /^[\p{L}\s.'-]+$/u.test(v) ? '' : 'Use letters only in the name.',
  email: v => !v ? 'Enter your email.' : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Enter a valid email, like name@example.com.',
  cat: v => v ? '' : 'Choose a topic.',
  rating: v => v ? '' : 'Choose a rating.',
  msg: v => !v ? 'Write your feedback.' : v.length < 10 ? 'Write at least 10 characters.' : v.length > 500 ? 'Keep it under 500 characters.' : ''
};
function fbCheck(k) {
  const el = $('fb-' + k), m = FB[k](el.value.trim());
  $('fbe-' + k).textContent = m; el.setAttribute('aria-invalid', m ? 'true' : 'false'); return !m;
}
$('fbBtn').addEventListener('click', () => { $('fbMsg').textContent = ''; $('fbDlg').showModal(); $('fb-name').focus(); });
$('fbCancel').addEventListener('click', () => $('fbDlg').close());
Object.keys(FB).forEach(k => { $('fb-' + k).addEventListener('blur', () => fbCheck(k)); $('fb-' + k).addEventListener('change', () => { if ($('fbe-' + k).textContent) fbCheck(k); }); });
$('fb-msg').addEventListener('input', () => { const n = $('fb-msg').value.length; $('fb-count').textContent = n + ' / 500'; $('fb-count').style.color = n > 500 ? '#ff9a8a' : ''; });
$('fbForm').addEventListener('submit', e => {
  e.preventDefault();
  const bad = Object.keys(FB).filter(k => !fbCheck(k)), msg = $('fbMsg');
  if (bad.length) { msg.className = 'font-semibold text-red-300'; msg.textContent = 'Please fix ' + bad.length + ' field' + (bad.length > 1 ? 's' : '') + ' and send again.'; $('fb-' + bad[0]).focus(); return; }
  const rec = { name: $('fb-name').value.trim(), email: $('fb-email').value.trim(), topic: $('fb-cat').value, rating: +$('fb-rating').value, message: $('fb-msg').value.trim(), at: new Date().toISOString() };
  let saved = true;
  try { const all = JSON.parse(localStorage.getItem('osmv_feedback') || '[]'); all.push(rec); localStorage.setItem('osmv_feedback', JSON.stringify(all)); } catch (err) { saved = false; }
  msg.className = 'font-semibold ' + (saved ? 'text-emerald-300' : 'text-amber-300');
  msg.textContent = saved ? 'Thank you, ' + rec.name.split(' ')[0] + '! Your feedback was saved.' : 'Your feedback is valid, but this browser blocked saving it.';
  speak(msg.textContent); $('fbForm').reset(); $('fb-count').textContent = '0 / 500';
  ['name', 'email', 'cat', 'rating', 'msg'].forEach(k => $('fb-' + k).setAttribute('aria-invalid', 'false'));
});