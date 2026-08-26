// ================================================================
// StayFinder AI — main.js
// ================================================================

const CONFIG = window.STAYFINDER_CONFIG || { MAPBOX_TOKEN: '', API_BASE: '/api/chat' };
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN || '';
const API_BASE = CONFIG.API_BASE || '/api/chat';

// ── State ────────────────────────────────────────────────────────
const state = {
  prefs: {},              // user's travel preferences collected from chat
  isTyping: false,
  messageCount: 0,
  conversationHistory: [], // full Anthropic-format message log sent each turn
  pendingToolResults: [],  // tool_result blocks owed before the next user turn
  backendReachable: null,  // null = unknown, true/false once checked
  listening: false,        // mic active
  speakingBtn: null,       // currently-speaking read-aloud button, if any
  demoCity: null,
  currentListings: [],    // Array of listing objects from latest search
  compareList: [],        // Up to 3 listing IDs the user selected for comparison
  map: null,               // Mapbox map instance
  mapOpen: false,
  markers: [],             // active map marker objects
};

// ── DOM / escaping helpers ──────────────────────────────────────
const $ = id => document.getElementById(id);
const messages = $('messages');
function show(id) { $(id).style.display = ''; }
function hide(id) { $(id).style.display = 'none'; }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str === null || str === undefined ? '' : String(str);
  // Text-node serialization escapes & < > but NOT quotes; escape them too so
  // interpolating into an HTML attribute value (data-*, aria-label, href…)
  // can't break out of the surrounding quotes.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only allow http(s) URLs through as href values — blocks javascript: etc.
// Tag colours land inside a class="" attribute, where escaping isn't enough —
// a value like `x" onmouseover="…` would break out. tagColors isn't in the
// present_listings schema, but listing data originates from web_search results,
// so treat it as untrusted and allow only known palette names.
const TAG_COLORS = ['gold', 'amber', 'green'];
function safeTagColor(c) { return TAG_COLORS.includes(c) ? c : 'gold'; }

function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url, location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch { return ''; }
}

// ================================================================
// SAVED SEARCHES  &  SHARE LINK
// ================================================================
const SAVED_SEARCHES_KEY = 'sf_saved_searches';

function getSavedSearches() {
  try { return JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || '[]'); }
  catch { return []; }
}

function saveCurrentSearch() {
  const prefs = state.prefs;
  if (!prefs.destination && !state.demoCity) {
    showToast('Start a search first before saving.');
    return;
  }

  const destination = prefs.destination || state.demoCity || 'Unknown';
  const searches = getSavedSearches();

  const isDupe = searches.some(s =>
    s.destination === destination &&
    s.budget_max  === prefs.budget_max
  );
  if (isDupe) { showToast('This search is already saved.'); return; }

  const entry = {
    id:          Date.now(),
    savedAt:     new Date().toISOString(),
    destination,
    prefs:       { ...prefs },
    demoCity:    state.demoCity,
    label:       buildSearchLabel(prefs, state.demoCity),
  };

  searches.unshift(entry);
  if (searches.length > 10) searches.pop();
  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches));
  renderSavedSearches();
  showToast('Search saved! ✓');
}

function deleteSavedSearch(id) {
  const updated = getSavedSearches().filter(s => s.id !== id);
  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(updated));
  renderSavedSearches();
}

function loadSavedSearch(entry) {
  state.prefs    = { ...entry.prefs };
  state.demoCity = entry.demoCity || entry.destination;

  updatePreferences(entry.prefs);

  closeSidebar();
  $('chat-input').value =
    `Find me the best options in ${entry.destination} based on my saved preferences`;
  sendMessage();
}

function buildSearchLabel(prefs, demoCity) {
  const dest   = prefs.destination || demoCity || 'Somewhere';
  const guests = prefs.num_guests  ? `${prefs.num_guests} guests` : '';
  const budget = prefs.budget_max  ? `up to $${prefs.budget_max}/night` : '';
  return [dest, guests, budget].filter(Boolean).join(' · ');
}

function renderSavedSearches() {
  const list = getSavedSearches();
  const container = $('saved-searches-list');
  if (!container) return;

  const parent = $('sec-saved');
  if (!parent) return;

  if (list.length === 0) {
    parent.style.display = 'none';
    return;
  }

  parent.style.display = '';
  container.innerHTML = list.map((entry, i) => {
    const date = new Date(entry.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `
      <div class="saved-search-item">
        <button type="button" class="saved-search-main" data-saved-index="${i}" aria-label="Reload search: ${escapeHtml(entry.label)}, saved ${escapeHtml(date)}">
          <div class="saved-search-label">${escapeHtml(entry.label)}</div>
          <div class="saved-search-date">${escapeHtml(date)}</div>
        </button>
        <button type="button" class="saved-search-del" data-del-id="${entry.id}" aria-label="Remove saved search: ${escapeHtml(entry.label)}">✕</button>
      </div>`;
  }).join('');

  // Listeners instead of inline JSON in onclick attributes (avoids HTML-attribute injection)
  container.querySelectorAll('[data-saved-index]').forEach(el => {
    el.addEventListener('click', () => loadSavedSearch(list[Number(el.dataset.savedIndex)]));
  });
  container.querySelectorAll('[data-del-id]').forEach(el => {
    el.addEventListener('click', () => deleteSavedSearch(Number(el.dataset.delId)));
  });
}

function shareSearch() {
  const prefs = state.prefs;
  if (!prefs.destination && !state.demoCity) {
    showToast('Start a search first to share it.');
    return;
  }

  const payload = { ...prefs, destination: prefs.destination || state.demoCity };
  const encoded  = btoa(encodeURIComponent(JSON.stringify(payload)));
  const shareUrl = `${location.origin}${location.pathname}?search=${encoded}`;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(shareUrl).then(() => showShareToast(shareUrl)).catch(() => fallbackCopy(shareUrl));
  } else {
    fallbackCopy(shareUrl);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  showShareToast(text);
}

function showShareToast(url) {
  document.getElementById('share-toast')?.remove();

  const t = document.createElement('div');
  t.id = 'share-toast';
  t.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:var(--bark);border:1px solid rgba(200,151,42,0.4);
    color:var(--cream);padding:14px 20px;border-radius:var(--radius);
    font-size:13px;z-index:200;animation:fade-in 0.2s ease;
    max-width:min(420px,90vw);box-shadow:0 8px 30px rgba(0,0,0,0.5);`;
  t.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-size:16px;">🔗</span>
      <strong style="color:var(--gold-light);">Link copied to clipboard!</strong>
    </div>
    <div style="font-size:11px;color:var(--cream-faint);word-break:break-all;line-height:1.5;
      background:rgba(255,255,255,0.05);padding:8px 10px;border-radius:6px;">
      ${escapeHtml(url.length > 80 ? url.slice(0, 80) + '…' : url)}
    </div>
    <button id="share-toast-dismiss"
      style="margin-top:10px;width:100%;background:none;border:1px solid rgba(200,151,42,0.25);
      color:var(--cream-dim);padding:6px;border-radius:6px;font-family:var(--font-body);
      font-size:12px;cursor:pointer;">Dismiss</button>`;
  document.body.appendChild(t);
  t.querySelector('#share-toast-dismiss').addEventListener('click', () => t.remove());
  setTimeout(() => t?.remove(), 6000);
}

// Only these keys ever populate state.prefs from a share link. A share link
// is JSON an attacker could hand-craft and send to someone else, so we can't
// Object.assign it in wholesale — a "__proto__" key would let it repoint
// state.prefs's prototype for the rest of the session. Allowlisting known
// fields (rather than blocking "__proto__"/"constructor" specifically) keeps
// this safe by construction as fields get added later.
const SHARE_PREF_KEYS = [
  'destination', 'check_in', 'check_out', 'num_guests', 'num_adults', 'num_children',
  'children_ages', 'budget_min', 'budget_max', 'budget_currency', 'accommodation_type',
  'transportation_needs', 'activities', 'amenities', 'pet_friendly', 'accessible',
];
function sanitizeSharedPrefs(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of SHARE_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

function readSharedUrl() {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('search');
  if (!encoded) return;

  try {
    const prefs = sanitizeSharedPrefs(JSON.parse(decodeURIComponent(atob(encoded))));
    state.prefs    = prefs;
    state.demoCity = prefs.destination || null;
    updatePreferences(prefs);

    setTimeout(() => {
      $('chat-input').value =
        `Find me the best options in ${prefs.destination || 'my destination'} based on the shared preferences`;
      sendMessage();
    }, 600);

    history.replaceState(null, '', location.pathname);
    showToast('🔗 Shared search loaded!');
  } catch {
    // Malformed param — silently ignore
  }
}

// ── Mobile sidebar ───────────────────────────────────────────────
// ── Focus management for overlay panels ──────────────────────────
// Each panel remembers what had focus right before ITS OWN explicit open, so
// closing it (Escape, close button, or backdrop) returns focus there instead
// of losing it to <body>. Kept per-panel (not one shared variable) because
// panels can be open simultaneously or in any order — e.g. the map can
// auto-open after a search while the compare modal is already open.
const focusReturn = { sidebar: null, map: null, compare: null };

function trapTabKey(container, e) {
  if (e.key !== 'Tab') return;
  const focusable = container.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('compare-modal').classList.contains('open')) { closeCompare(); }
  else if (state.mapOpen)                            { hideMap(); }
  else if ($('sidebar').classList.contains('open'))  { closeSidebar(); }
});

document.addEventListener('keydown', (e) => {
  if ($('compare-modal').classList.contains('open')) trapTabKey($('compare-modal'), e);
});

function openSidebar()  {
  focusReturn.sidebar = document.activeElement;
  $('sidebar').classList.add('open');  $('sidebar-overlay').classList.add('active');  document.body.style.overflow = 'hidden';
  document.querySelector('.sidebar-close').focus({ preventScroll: true });
}
function closeSidebar() {
  $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('active'); document.body.style.overflow = '';
  focusReturn.sidebar?.focus?.({ preventScroll: true });
  focusReturn.sidebar = null;
}

// ================================================================
// MAP
// ================================================================
function initMap(city, listings) {
  if (!MAPBOX_TOKEN) {
    showMapPlaceholder(city, listings);
    return;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  if (state.map) { state.map.remove(); state.map = null; }
  state.markers.forEach(m => m.remove());
  state.markers = [];

  const center = listings.length
    ? [listings[0].lng, listings[0].lat]
    : getCityCoords(city);

  state.map = new mapboxgl.Map({
    container: 'mapbox-container',
    style: 'mapbox://styles/mapbox/dark-v11',
    center,
    zoom: 13,
    attributionControl: false,
  });

  state.map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  state.map.on('load', () => {
    listings.forEach((listing) => {
      const el = document.createElement('button');
      el.className = 'map-marker';
      el.textContent = `$${listing.price}`;
      el.setAttribute('data-id', listing.id);

      const popup = new mapboxgl.Popup({ offset: 25, closeButton: true })
        .setHTML(`
          <div class="map-popup-title">${escapeHtml(listing.title)}</div>
          <div class="map-popup-price">$${Number(listing.price) || '?'}/night</div>
          <div class="map-popup-rating">★ ${Number(listing.rating) || '—'} · ${Number(listing.reviews) || 0} reviews</div>
        `);

      const marker = new mapboxgl.Marker(el)
        .setLngLat([listing.lng, listing.lat])
        .setPopup(popup)
        .addTo(state.map);

      el.addEventListener('click', () => {
        highlightListingCard(listing.id);
        document.querySelectorAll('.map-marker').forEach(m => m.classList.remove('active'));
        el.classList.add('active');
      });

      state.markers.push(marker);
    });

    if (listings.length > 1) {
      const bounds = listings.reduce((b, l) =>
        b.extend([l.lng, l.lat]),
        new mapboxgl.LngLatBounds([listings[0].lng, listings[0].lat], [listings[0].lng, listings[0].lat])
      );
      state.map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    }
  });

  $('map-count').textContent = `${listings.length} listings`;
}

function showMapPlaceholder(city, listings) {
  const container = $('mapbox-container');
  container.style.overflow = 'auto';
  container.innerHTML = `
    <div style="padding:20px;">
      <div style="background:rgba(200,151,42,0.1);border:1px solid rgba(200,151,42,0.25);border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.6;color:var(--cream-dim);">
        <div style="color:var(--gold-light);font-weight:500;margin-bottom:4px;">Add a Mapbox token to see the map</div>
        Sign up free at <a href="https://mapbox.com" style="color:var(--teal-light);" target="_blank" rel="noopener noreferrer">mapbox.com</a>, copy your public token, URL-restrict it to your domain, then put it in <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;">config.local.js</code> (copy from <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;">config.example.js</code>).
      </div>
      <div style="font-size:11px;color:var(--cream-faint);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;">Listings near ${escapeHtml(city || 'your destination')}</div>
      ${listings.map((l) => `
        <button type="button" class="map-placeholder-item" data-listing-id="${escapeHtml(l.id)}" aria-label="Highlight ${escapeHtml(l.title)} in the chat" style="display:block;width:100%;text-align:left;font-family:inherit;background:var(--driftwood);border:1px solid rgba(200,151,42,0.15);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:border-color 0.2s;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="font-family:var(--font-display);font-size:15px;color:var(--cream);font-weight:500;">${escapeHtml(l.title)}</div>
            <div style="font-size:14px;color:var(--gold-light);white-space:nowrap;margin-left:8px;">$${Number(l.price) || '?'}<span style="font-size:10px;color:var(--cream-faint)">/night</span></div>
          </div>
          <div style="font-size:12px;color:var(--cream-dim);margin-top:3px;">📍 ${escapeHtml(l.location)}</div>
          <div style="font-size:12px;color:var(--gold);margin-top:2px;">★ ${Number(l.rating) || '—'} · ${Number(l.reviews) || 0} reviews</div>
        </button>`).join('')}
    </div>`;
  container.querySelectorAll('[data-listing-id]').forEach(el => {
    el.addEventListener('click', () => highlightListingCard(el.dataset.listingId));
    el.addEventListener('mouseover', () => el.style.borderColor = 'rgba(200,151,42,0.4)');
    el.addEventListener('mouseout',  () => el.style.borderColor = 'rgba(200,151,42,0.15)');
    el.addEventListener('focus',     () => el.style.borderColor = 'rgba(200,151,42,0.4)');
    el.addEventListener('blur',      () => el.style.borderColor = 'rgba(200,151,42,0.15)');
  });
  $('map-count').textContent = `${listings.length} listings`;
}

function toggleMap() {
  if (state.mapOpen) { hideMap(); return; }
  // Explicit user action (clicked the Map button) — move focus in, and
  // remember where to send it back on close. Auto-opens after a search
  // (registerListings) call showMap() directly and skip this, since
  // grabbing focus away from an in-progress chat would be disorienting.
  focusReturn.map = document.activeElement;
  showMap();
  document.querySelector('.map-close-btn').focus({ preventScroll: true });
}

function showMap() {
  state.mapOpen = true;
  $('map-panel').classList.add('open');
  $('map-toggle-btn').classList.add('active');
  if (state.map) setTimeout(() => state.map.resize(), 350);
}

function hideMap() {
  state.mapOpen = false;
  $('map-panel').classList.remove('open');
  $('map-toggle-btn').classList.remove('active');
  focusReturn.map?.focus?.({ preventScroll: true });
  focusReturn.map = null;
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function highlightListingCard(id) {
  const card = document.querySelector(`[data-listing-id="${CSS.escape(String(id))}"]`);
  if (card) {
    card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    card.style.borderColor = 'rgba(200,151,42,0.8)';
    setTimeout(() => card.style.borderColor = '', 1500);
  }
}

// ================================================================
// COMPARISON
// ================================================================
function toggleCompare(id, checked) {
  if (checked) {
    if (state.compareList.length >= 3) {
      const cb = document.querySelector(`#compare-cb-${CSS.escape(String(id))}`);
      if (cb) cb.checked = false;
      showToast('You can compare up to 3 listings at a time.');
      return;
    }
    state.compareList.push(id);
  } else {
    state.compareList = state.compareList.filter(i => i !== id);
  }
  updateCompareBar();
}

function updateCompareBar() {
  let bar = $('compare-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'compare-bar';
    bar.className = 'compare-bar';
    bar.innerHTML = `
      <span class="compare-bar-text"><strong id="compare-bar-count">0</strong> selected</span>
      <button class="compare-bar-btn" onclick="openCompare()">Compare</button>
      <button class="compare-bar-clear" onclick="clearCompare()" aria-label="Clear comparison selection">✕</button>`;
    document.body.appendChild(bar);
  }

  const count = state.compareList.length;
  $('compare-bar-count').textContent = count;
  if (count >= 2) bar.classList.add('visible');
  else bar.classList.remove('visible');
}

function clearCompare() {
  state.compareList = [];
  document.querySelectorAll('.listing-compare-check input').forEach(cb => cb.checked = false);
  const bar = $('compare-bar');
  if (bar) bar.classList.remove('visible');
}

function openCompare() {
  const selected = state.currentListings.filter(l => state.compareList.includes(l.id));
  if (selected.length < 2) return;

  const rows = [
    { label: 'Price / night', key: l => `<span class="compare-price">$${Number(l.price) || '?'}<span>/night</span></span>` },
    { label: 'Rating',        key: l => `<span class="compare-rating">★ ${Number(l.rating) || '—'}</span> <span style="font-size:12px;color:var(--cream-faint)">${Number(l.reviews) || 0} reviews</span>` },
    { label: 'Type',          key: l => l.type === 'airbnb' ? '🏠 Airbnb' : '🏨 Hotel' },
    { label: 'Location',      key: l => escapeHtml(l.location) },
    { label: 'Amenities',     key: l => `<div class="compare-tags">${(l.amenities||[]).map(a => `<span class="tag tag-green">${escapeHtml(a)}</span>`).join('')}</div>` },
    { label: 'Highlights',    key: l => `<div class="compare-tags">${(l.tags||[]).map((t,i) => `<span class="tag tag-${safeTagColor((l.tagColors||[])[i])}">${escapeHtml(t)}</span>`).join('')}</div>` },
  ];

  const bestPrice  = Math.min(...selected.map(l => Number(l.price) || Infinity));
  const bestRating = Math.max(...selected.map(l => Number(l.rating) || 0));

  const html = `
    <table class="compare-table">
      <thead>
        <tr>
          <th></th>
          ${selected.map(l => `<th class="listing-col">${escapeHtml(l.title)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${row.label}</td>
            ${selected.map(l => {
              let cell = row.key(l);
              if (row.label === 'Price / night' && Number(l.price) === bestPrice)
                cell += `<div class="compare-win">Best price</div>`;
              if (row.label === 'Rating' && Number(l.rating) === bestRating)
                cell += `<div class="compare-win">Top rated</div>`;
              return `<td>${cell}</td>`;
            }).join('')}
          </tr>`).join('')}
      </tbody>
    </table>`;

  $('compare-body').innerHTML = html;
  $('compare-overlay').classList.add('active');
  $('compare-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  focusReturn.compare = document.activeElement;
  document.querySelector('.compare-close').focus({ preventScroll: true });
}

function closeCompare() {
  $('compare-overlay').classList.remove('active');
  $('compare-modal').classList.remove('open');
  document.body.style.overflow = '';
  focusReturn.compare?.focus?.({ preventScroll: true });
  focusReturn.compare = null;
}

// ── Toast notification ───────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--driftwood);border:1px solid rgba(200,151,42,0.3);color:var(--cream-dim);padding:10px 18px;border-radius:20px;font-size:13px;z-index:100;animation:fade-in 0.2s ease;white-space:nowrap;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ── Date normalisation ───────────────────────────────────────────
// Airbnb and Booking.com both require a strict YYYY-MM-DD `checkin`/`checkout`.
// The model fills these from free-form chat ("September 20th"), so the raw
// value often isn't ISO. Booking.com does NOT reject an unparseable date — it
// silently ignores it and returns today/tomorrow results, which is worse than
// no date at all: the user lands on the right city with the wrong dates and
// wrong prices. So we normalise here and, when we can't, omit the param and
// let the site ask rather than send a date it will quietly get wrong.
function toISODate(value) {
  if (!value) return null;
  const s = String(value).trim();

  // Already ISO — return as-is. Never round-trip through `new Date()`: it
  // parses ISO as UTC, so "2026-09-20" comes back as Sep 19 west of GMT.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Ordinal suffixes ("20th") make Date.parse return Invalid Date.
  const cleaned = s.replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // V8's legacy parser is extremely permissive: it discards words it doesn't
  // recognise and latches onto any stray number, so "next friday 2026" yields
  // January 1st rather than failing. Only trust a parse whose day-of-month
  // actually appears in the input — otherwise we'd invent a date outright.
  const parse = str => {
    const d = new Date(str);
    if (isNaN(d)) return null;
    return new RegExp(`(^|\\D)${d.getDate()}(\\D|$)`).test(cleaned) ? d : null;
  };

  if (/\b\d{4}\b/.test(cleaned)) return parse(cleaned) ? fmt(parse(cleaned)) : null;

  // No year given. Date.parse would invent one (V8 reads "September 20" as
  // 2001), so anchor to the next occurrence: this year, else next year.
  const year = new Date().getFullYear();
  const thisYear = parse(`${cleaned} ${year}`);
  if (!thisYear) return null;
  // Allow a day of slack so an in-progress trip doesn't jump 12 months.
  if (thisYear.getTime() >= Date.now() - 864e5) return fmt(thisYear);
  const nextYear = parse(`${cleaned} ${year + 1}`);
  return nextYear ? fmt(nextYear) : null;
}

// ── Honest booking deep links (we don't book — we point to real search results) ──
function bookingUrl(kind, listing) {
  const dest = encodeURIComponent(listing.location || state.prefs.destination || state.demoCity || '');
  const checkIn  = toISODate(state.prefs.check_in);
  const checkOut = toISODate(state.prefs.check_out);
  // Both sites price adults and children differently, so passing the combined
  // guest count as the adult count overprices a family and can filter out
  // places that would actually fit them. Derive the split when we know it.
  const agesRaw = Array.isArray(state.prefs.children_ages) ? state.prefs.children_ages : [];
  const ages = agesRaw.filter(a => Number.isFinite(a) && a >= 0 && a < 18);
  const children = state.prefs.num_children || ages.length;
  const adults = state.prefs.num_adults || Math.max(1, (state.prefs.num_guests || 1) - children);
  if (kind === 'airbnb') {
    // Airbnb bills under-2s as infants, who don't count toward occupancy.
    // Without ages we can't tell them apart, so everyone lands in `children`.
    const infants = ages.filter(a => a < 2).length;
    const kids = ages.length ? ages.length - infants : children;
    let url = `https://www.airbnb.com/s/${dest}/homes?adults=${adults}`;
    if (kids)     url += `&children=${kids}`;
    if (infants)  url += `&infants=${infants}`;
    if (checkIn)  url += `&checkin=${checkIn}`;
    if (checkOut) url += `&checkout=${checkOut}`;
    return url;
  }
  let url = `https://www.booking.com/searchresults.html?ss=${dest}&group_adults=${adults}`;
  // Booking.com needs one `age` per child alongside the count. If we only know
  // the count it still beats counting kids as adults — the site prompts for
  // ages instead of quietly returning adult-priced results.
  if (children) url += `&group_children=${children}`;
  for (const age of ages) url += `&age=${age}`;
  if (checkIn)  url += `&checkin=${checkIn}`;
  if (checkOut) url += `&checkout=${checkOut}`;
  return url;
}

// ── Build listing card HTML ──────────────────────────────────────
function buildListingCard(listing) {
  const tagHtml = (listing.tags || []).map((t, i) => {
    const color = safeTagColor((listing.tagColors || [])[i]);
    return `<span class="tag tag-${color}">${escapeHtml(t)}</span>`;
  }).join('');

  const directUrl = safeUrl(listing.url);
  const id = escapeHtml(listing.id);

  return `
    <div class="listing-card" data-listing-id="${id}">
      <label class="listing-compare-check">
        <input type="checkbox" class="compare-toggle" id="compare-cb-${id}" data-compare-id="${id}"> Compare
      </label>
      <div class="listing-card-header">
        <div class="listing-title">${escapeHtml(listing.title)}</div>
        <div class="listing-price">$${Number(listing.price) || '?'} <span>/ night</span></div>
      </div>
      <div class="listing-location">📍 ${escapeHtml(listing.location)}</div>
      <div class="listing-rating">${listing.rating ? `★ ${Number(listing.rating)} · ${Number(listing.reviews) || 0} reviews` : ''}</div>
      <div class="listing-tags">${tagHtml}</div>
      <div class="listing-links">
        ${directUrl ? `<a class="listing-link-btn" href="${directUrl}" target="_blank" rel="noopener noreferrer">🔗 View Listing</a>` : ''}
        <a class="listing-link-btn" href="${escapeHtml(bookingUrl('airbnb', listing))}" target="_blank" rel="noopener noreferrer">Search Airbnb</a>
        <a class="listing-link-btn" href="${escapeHtml(bookingUrl('booking', listing))}" target="_blank" rel="noopener noreferrer">Search Booking.com</a>
      </div>
    </div>`;
}

// ── Message rendering ────────────────────────────────────────────
function addMessage(role, content, isHtml = false) {
  const welcome = $('welcome-screen');
  if (welcome) welcome.remove();

  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.style.animationDelay = `${Math.min(state.messageCount * 0.04, 0.1)}s`;

  const avatar = document.createElement('div');
  avatar.className = `avatar avatar-${role === 'assistant' ? 'ai' : 'user'}`;
  avatar.textContent = role === 'assistant' ? '✦' : 'You';

  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${role === 'assistant' ? 'ai' : 'user'}`;

  if (isHtml) bubble.innerHTML = content;
  else        bubble.innerHTML = formatText(content);

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);

  if (role === 'assistant' && 'speechSynthesis' in window) {
    const plainText = bubble.textContent.trim();
    if (plainText) {
      const readBtn = document.createElement('button');
      readBtn.className = 'read-aloud-btn';
      readBtn.title = 'Read aloud';
      readBtn.setAttribute('aria-label', 'Read message aloud');
      readBtn.textContent = '🔊';
      readBtn.addEventListener('click', () => toggleReadAloud(readBtn, plainText));
      wrap.appendChild(readBtn);
    }
  }

  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  state.messageCount++;
  return bubble;
}

function formatText(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/\*(.*?)\*/g, '<em>$1</em>');
  safe = safe.replace(/\n\n/g, '</p><p>');
  safe = safe.replace(/\n/g, '<br>');
  return `<p>${safe}</p>`;
}

function buildAssistantBubbleHtml(text, listings) {
  let html = formatText(text || "Here's what I found.");
  if (listings && listings.length) {
    html += listings.map(l => buildListingCard(l)).join('');
  }
  return html;
}

// ── Typing / search progress ──────────────────────────────────────
function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'message assistant'; wrap.id = 'typing-indicator';
  const avatar = document.createElement('div');
  avatar.className = 'avatar avatar-ai'; avatar.textContent = '✦';
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(avatar); wrap.appendChild(typing);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}
function removeTyping() { const t = $('typing-indicator'); if (t) t.remove(); }

const SEARCH_STEPS = ['Reading your preferences','Scanning listings','Comparing prices','Checking availability','Ranking best matches'];

function showSearchProgress(city) {
  removeTyping();
  const wrap = document.createElement('div');
  wrap.className = 'message assistant'; wrap.id = 'search-progress-indicator';
  const avatar = document.createElement('div');
  avatar.className = 'avatar avatar-ai'; avatar.textContent = '✦';
  const box = document.createElement('div');
  box.className = 'search-progress';
  box.innerHTML = `
    <div class="search-progress-label">Searching ${city ? `in ${escapeHtml(city)}` : 'for stays'}…</div>
    <div class="search-steps">
      ${SEARCH_STEPS.map((s,i) => `<div class="search-step" id="sstep-${i}"><span class="step-dot"></span><span class="step-check">✓</span>${s}</div>`).join('')}
    </div>`;
  wrap.appendChild(avatar); wrap.appendChild(box);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;

  let cur = 0;
  const interval = setInterval(() => {
    const prev = document.getElementById(`sstep-${cur-1}`);
    const el   = document.getElementById(`sstep-${cur}`);
    if (prev) prev.className = 'search-step done';
    if (el)   el.className   = 'search-step active';
    cur++;
    if (cur > SEARCH_STEPS.length) clearInterval(interval);
  }, 600);
  wrap._interval = interval;
}

function removeSearchProgress() {
  const el = $('search-progress-indicator');
  if (el) { if (el._interval) clearInterval(el._interval); el.remove(); }
}

// ── Preference sidebar ───────────────────────────────────────────
function updatePreferences(data) {
  if (!data || typeof data !== 'object') return;
  Object.assign(state.prefs, data);
  const p = state.prefs;

  hide('pref-empty'); show('pref-content');

  const fields = ['destination','num_guests','budget_max','check_in','accommodation_type','amenities','transportation_needs','activities'];
  const filled = fields.filter(f => p[f] && (Array.isArray(p[f]) ? p[f].length > 0 : true)).length;
  const pct = Math.round((filled / fields.length) * 100);
  $('progress-fill').style.width = pct + '%';
  $('progress-pct').textContent = pct + '%';
  $('progress-text').textContent = pct < 25 ? 'Just getting started' : pct < 55 ? 'Looking good' : pct < 80 ? 'Almost ready' : 'Ready to search!';
  show('sec-progress'); show('div-0');

  if (p.destination) { $('pref-destination').textContent = p.destination; $('pref-destination').classList.remove('pending'); show('sec-destination'); }
  if (p.check_in || p.check_out) {
    // Show the same date the booking links will use, so the panel never
    // disagrees with where the user actually lands. Unparseable values fall
    // back to the raw text rather than a misleading normalised guess.
    const fmt = d => { if(!d) return '?'; const iso = toISODate(d); if(!iso) return String(d); const [y,m,dy]=iso.split('-'); return `${m}/${dy}/${y.slice(2)}`; };
    $('pref-dates').textContent = `${fmt(p.check_in)} → ${fmt(p.check_out)}`; show('sec-dates');
  }
  if (p.num_guests) {
    let g=`${p.num_guests} guest${p.num_guests>1?'s':''}`;
    if(p.num_adults||p.num_children) g+=` (${p.num_adults||0} adults, ${p.num_children||0} children)`;
    // Ages drive child pricing on both sites, so show them back for confirmation.
    const ages=(Array.isArray(p.children_ages)?p.children_ages:[]).filter(a=>Number.isFinite(a));
    if(ages.length) g+=` · ages ${ages.join(', ')}`;
    $('pref-guests').textContent=g; show('sec-guests');
  }
  show('div-1');
  if (p.budget_max || p.budget_min) {
    const sym = (p.budget_currency==='EUR')?'€':(p.budget_currency==='GBP')?'£':'$';
    let html = p.budget_min ? `<span>${sym}${p.budget_min}</span><span class="sep">–</span>` : '';
    html += `<span>${sym}${p.budget_max||p.budget_min}</span>`;
    $('pref-budget').innerHTML = html; show('sec-budget');
  }
  if (p.accommodation_type) { const labels={airbnb:'🏠 Airbnb',hotel:'🏨 Hotel',both:'🏠🏨 Both'}; $('pref-type').textContent=labels[p.accommodation_type]||p.accommodation_type; show('sec-type'); }
  show('div-2');
  if (p.transportation_needs) { $('pref-transport').textContent=p.transportation_needs; show('sec-transport'); }
  if (p.activities&&p.activities.length) { renderTags('pref-activities',p.activities,'tag-gold'); show('sec-activities'); }
  const al=[...(p.amenities||[])]; if(p.pet_friendly) al.push('pet-friendly'); if(p.accessible) al.push('accessible');
  if (al.length) { renderTags('pref-amenities',al,'tag-green'); show('sec-amenities'); }
  show('div-3');
  if (p.destination && p.num_guests) {
    show('search-btn');
    $('api-notice').style.display = state.backendReachable ? 'block' : 'none';
  }
}

function renderTags(containerId, items, cls) {
  const el = $(containerId); el.innerHTML = '';
  items.forEach((item, i) => {
    const tag = document.createElement('span');
    tag.className = `tag ${cls} pref-tag`;
    tag.style.animationDelay = `${i*0.05}s`;
    tag.textContent = item;
    el.appendChild(tag);
  });
}

// ── Suggested reply chips ────────────────────────────────────────
function renderChips(options) {
  const row = $('chips-row');
  if (!row) return;
  row.innerHTML = (options || []).map((o, i) =>
    `<button class="reply-chip" data-chip-index="${i}">${escapeHtml(o)}</button>`
  ).join('');
  row.querySelectorAll('[data-chip-index]').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      $('chat-input').value = options[i];
      sendMessage();
    });
  });
}
function clearChips() { const row = $('chips-row'); if (row) row.innerHTML = ''; }

// ── Voice input (Web Speech API) ─────────────────────────────────
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('mic-btn');
  if (!SR) { showToast('Voice input is not supported in this browser.'); return; }

  if (state.listening) {
    state._recognition?.stop();
    return;
  }

  const recognition = new SR();
  state._recognition = recognition;
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => { state.listening = true; btn.classList.add('listening'); };
  recognition.onerror = () => { state.listening = false; btn.classList.remove('listening'); };
  recognition.onend   = () => { state.listening = false; btn.classList.remove('listening'); };
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    const input = $('chat-input');
    input.value = (input.value ? input.value + ' ' : '') + text;
    autoResize(input);
  };

  try { recognition.start(); } catch { /* already started */ }
}

// ── Read-aloud (SpeechSynthesis) ─────────────────────────────────
function toggleReadAloud(btn, text) {
  if (!('speechSynthesis' in window)) return;

  if (state.speakingBtn === btn) {
    speechSynthesis.cancel();
    state.speakingBtn = null;
    btn.classList.remove('speaking');
    return;
  }

  speechSynthesis.cancel();
  if (state.speakingBtn) state.speakingBtn.classList.remove('speaking');

  const utter = new SpeechSynthesisUtterance(text);
  utter.onend = () => { btn.classList.remove('speaking'); state.speakingBtn = null; };
  state.speakingBtn = btn;
  btn.classList.add('speaking');
  speechSynthesis.speak(utter);
}

// ================================================================
// BACKEND — secure proxy call + tool-use handling
// ================================================================
async function callBackend() {
  // Abort a hung request so the spinner can't spin forever and the demo
  // fallback in sendMessage() actually fires.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.conversationHistory }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Backend error ${res.status}`);
  }

  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];

  let text = '';
  let listings = null;

  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      if (block.name === 'present_listings' && Array.isArray(block.input?.listings)) {
        listings = block.input.listings;
        registerListings(listings, state.prefs.destination || state.demoCity);
      } else if (block.name === 'update_preferences') {
        updatePreferences(block.input || {});
      } else if (block.name === 'suggest_replies' && Array.isArray(block.input?.options)) {
        renderChips(block.input.options);
      }
      // Client tools need an acknowledgment before the next user turn, or the
      // next API call is rejected — queue it, sent alongside the human's next message.
      state.pendingToolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
    }
    // server_tool_use / web_search_tool_result blocks: Anthropic already resolved
    // these server-side; no client action needed beyond keeping them in history below.
  }

  // Record the assistant turn exactly as returned so tool_use ids stay valid.
  state.conversationHistory.push({ role: 'assistant', content: blocks });

  return { text: text.trim(), listings };
}

// ── Register listings (map + compare state) ───────────────────────
function registerListings(listings, city) {
  state.currentListings = listings;
  state.compareList     = [];
  $('map-toggle-btn').style.display = '';
  initMap(city || '', listings);
  if (!state.mapOpen) showMap();
}

// ================================================================
// DEMO MODE — offline fallback when the backend is unreachable
// ================================================================
const CITY_ALIASES = {
  'nyc':'New York City, NY','new york':'New York City, NY',
  'la':'Los Angeles, CA','los angeles':'Los Angeles, CA',
  'sf':'San Francisco, CA','san francisco':'San Francisco, CA',
  'miami':'Miami Beach, FL','miami beach':'Miami Beach, FL',
  'chicago':'Chicago, IL','portland':'Portland, OR',
  'denver':'Denver, CO','colorado':'Denver, CO',
  'austin':'Austin, TX','nashville':'Nashville, TN',
  'seattle':'Seattle, WA','boston':'Boston, MA',
  'new orleans':'New Orleans, LA',
  'las vegas':'Las Vegas, NV','vegas':'Las Vegas, NV',
  'hawaii':'Honolulu, HI','honolulu':'Honolulu, HI',
  'barcelona':'Barcelona, Spain','paris':'Paris, France',
  'london':'London, UK','tokyo':'Tokyo, Japan',
  'rome':'Rome, Italy','amsterdam':'Amsterdam, Netherlands',
};

const CITY_COORDS = {
  'Miami Beach, FL':    [-80.13, 25.79],
  'New York City, NY':  [-74.00, 40.71],
  'Los Angeles, CA':    [-118.24, 34.05],
  'San Francisco, CA':  [-122.42, 37.77],
  'Chicago, IL':        [-87.63, 41.88],
  'Portland, OR':       [-122.68, 45.52],
  'Denver, CO':         [-104.99, 39.74],
  'Austin, TX':         [-97.74, 30.27],
  'Nashville, TN':      [-86.78, 36.17],
  'Seattle, WA':        [-122.33, 47.61],
  'Las Vegas, NV':      [-115.14, 36.17],
  'Barcelona, Spain':   [2.17, 41.39],
  'Paris, France':      [2.35, 48.86],
  'London, UK':         [-0.12, 51.51],
  'Tokyo, Japan':       [139.69, 35.69],
};

function getCityCoords(city) { return CITY_COORDS[city] || [-74.00, 40.71]; }

function detectCity(msg) {
  const lower = msg.toLowerCase();
  // Word-boundary match, not substring — plain .includes() let short aliases like
  // "la" fire inside unrelated words (e.g. "portLAnd", "atLAnta"), silently hijacking
  // the detected city. Longest alias first so "los angeles" wins over "la" either way.
  const aliases = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return CITY_ALIASES[alias];
  }
  const match = lower.match(/\bin\s+([a-z\s]+?)(?:\s+for|\s+with|\s*[,\.!?]|$)/);
  if (match) { const c = match[1].trim(); if (c.length>2&&c.length<40) return c.charAt(0).toUpperCase()+c.slice(1); }
  return null;
}
function detectGuests(msg) {
  const lower = msg.toLowerCase();
  // Digits first — more explicit signal than a spelled-out number.
  const m = lower.match(/(\d+)\s*(?:guest|person|people|adult)/);
  if (m) return parseInt(m[1]);
  // Word-boundary match, not substring — "one"/"two" as plain .includes() fired
  // inside "honeymoon", "someone", "phone", silently reporting 1 guest for any of them.
  const numWords={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8};
  for(const [w,n] of Object.entries(numWords)) if(new RegExp(`\\b${w}\\b`,'i').test(lower)) return n;
  return null;
}
function detectBudget(msg) {
  const lower=msg.toLowerCase();
  const m=lower.match(/\$?(\d+)(?:\s*[-–to]+\s*\$?(\d+))?/);
  if(m){const min=parseInt(m[1]);const max=m[2]?parseInt(m[2]):null;if(min>=30&&min<=2000)return{min,max:max||min+100};}
  if(lower.includes('cheap')||lower.includes('budget'))return{min:60,max:120};
  if(lower.includes('luxury')||lower.includes('splurge'))return{min:300,max:600};
  return null;
}
function detectType(msg) {
  const lower=msg.toLowerCase();
  if(lower.includes('airbnb')||lower.includes('rental')||lower.includes('house'))return'airbnb';
  if(lower.includes('hotel'))return'hotel';
  if(lower.includes('both')||lower.includes('either'))return'both';
  return null;
}
function detectAmenities(msg) {
  const lower=msg.toLowerCase(); const found=[];
  const map={pool:['pool'],kitchen:['kitchen','cook'],wifi:['wifi'],parking:['parking'],'pet-friendly':['pet','dog'],'hot tub':['hot tub','jacuzzi'],gym:['gym']};
  for(const [a,ks] of Object.entries(map)) if(ks.some(k=>lower.includes(k))) found.push(a);
  return found;
}

function generateDemoListings(city, budget, type) {
  const coords = getCityCoords(city) || [-74, 40.71];
  const shortCity = (city||'the area').split(',')[0];
  const min  = budget?.min  || 100;
  const max  = budget?.max  || 200;
  const isAirbnb = !type || type === 'airbnb' || type === 'both';
  const spread = 0.02;

  return [
    { id:'l1', title:`${shortCity} ${isAirbnb?'Cozy Studio':'Boutique Hotel'} — Central`,
      location:`Downtown ${shortCity}`, lat:coords[1]+spread*0.2, lng:coords[0]-spread*0.3,
      price:Math.round(min*1.05), rating:4.91, reviews:184, type:isAirbnb?'airbnb':'hotel',
      amenities:['Wifi','Kitchen','AC'], tags:['Great location',isAirbnb?'Superhost':'Free breakfast'], tagColors:['gold','amber'] },
    { id:'l2', title:`${shortCity} Modern 1BR w/ Views`,
      location:`${shortCity} — near center`, lat:coords[1]-spread*0.3, lng:coords[0]+spread*0.4,
      price:Math.round((min+max)/2), rating:4.78, reviews:97, type:isAirbnb?'airbnb':'hotel',
      amenities:['Pool','AC','Washer'], tags:['City views','Quiet block'], tagColors:['gold','green'] },
    { id:'l3', title:`${shortCity} ${type==='hotel'?'Premium Hotel':'Spacious Apartment'}`,
      location:`Prime ${shortCity}`, lat:coords[1]+spread*0.5, lng:coords[0]+spread*0.1,
      price:Math.round(max*0.95), rating:4.95, reviews:312, type:type==='hotel'?'hotel':'airbnb',
      amenities:['Fast Wifi','Gym','Concierge'], tags:['Top rated','Most popular'], tagColors:['amber','gold'] },
  ];
}

function getCityBlurb(city) {
  const blurbs={'New York City':'One of the most exciting cities in the world.','Miami Beach':'Sun, sand, and incredible energy 🌴','Los Angeles':'Endless sunshine and so much to explore 🌅','San Francisco':'Stunning views everywhere 🌉','Chicago':'Amazing architecture, food, and lakefront 🌆','Paris':'La Ville Lumière — there is truly nowhere like it 🥐','London':'A world-class city with something for everyone 🇬🇧','Tokyo':'One of the most fascinating cities on earth 🗾'};
  return blurbs[city] || 'Sounds like a wonderful trip!';
}

async function simulateResponse(msg) {
  const city     = detectCity(msg);
  const guests   = detectGuests(msg);
  const budget   = detectBudget(msg);
  const type     = detectType(msg);
  const amenities = detectAmenities(msg);

  if (city)    state.demoCity = city;
  if (guests)  state.prefs.num_guests = guests;
  if (budget)  { state.prefs.budget_min=budget.min; state.prefs.budget_max=budget.max; }
  if (type)    state.prefs.accommodation_type = type;
  if (amenities.length) state.prefs.amenities = amenities;

  const currentCity   = state.demoCity;
  const currentGuests = state.prefs.num_guests;
  const currentBudget = state.prefs.budget_min ? {min:state.prefs.budget_min,max:state.prefs.budget_max} : null;
  const currentType   = state.prefs.accommodation_type;

  const prefUpdate = {
    ...(currentCity   && {destination:currentCity}),
    ...(currentGuests && {num_guests:currentGuests}),
    ...(currentBudget && {budget_min:currentBudget.min,budget_max:currentBudget.max}),
    ...(currentType   && {accommodation_type:currentType}),
    ...(amenities.length && {amenities}),
  };
  if (Object.keys(prefUpdate).length > 0) setTimeout(() => updatePreferences(prefUpdate), 200);

  if (!currentCity) return `Welcome to **StayFinder AI** — running in demo mode right now (no backend reachable). 🌍\n\nWhere are you headed? Tell me the destination and we'll find the perfect stay.`;

  const shortCity = currentCity.split(',')[0];
  if (!currentGuests) return `**${currentCity}** — great choice! ${getCityBlurb(shortCity)}\n\nHow many guests will be staying, and do you have travel dates in mind?`;
  if (!currentBudget) return `Perfect — **${currentGuests} guest${currentGuests>1?'s':''}** in ${shortCity}.\n\nWhat's your **budget per night**? Also, any preference for **Airbnb** vs **hotel**?`;
  if (!state.prefs._askedAmenities) {
    state.prefs._askedAmenities = true;
    return `$${currentBudget.min}–$${currentBudget.max}/night in ${shortCity} gives us solid options.\n\nAny must-haves? Pool, kitchen, parking, pet-friendly? Or say **"find me something"** and I'll search now!`;
  }

  await new Promise(resolve => {
    showSearchProgress(shortCity);
    setTimeout(() => { removeSearchProgress(); resolve(); }, 3200);
  });

  const listings = generateDemoListings(currentCity, currentBudget, currentType);
  registerListings(listings, currentCity);

  const cardsHtml = listings.map(l => buildListingCard(l)).join('');
  return `Here are the top matches for your stay in **${shortCity}** 🏡 (demo data — connect the backend for real, live listings)\n\nSelect up to 3 listings to compare side-by-side, or open the map to see locations.\n\n${cardsHtml}`;
}

// ── Backend reachability check (for the honest "AI Concierge Active" badge) ──
async function checkBackend() {
  try {
    const res = await fetch(API_BASE, { method: 'GET' });
    // The proxy only accepts POST, so a deployed function replies 405/403 fast.
    state.backendReachable = res.status === 405 || res.status === 403 || res.ok;
  } catch {
    state.backendReachable = false;
  }
  updateHeaderStatus();
}

function updateHeaderStatus() {
  const wrap = document.querySelector('.header-status');
  if (!wrap) return;
  wrap.innerHTML = state.backendReachable
    ? '<div class="status-dot"></div>AI Concierge Active'
    : '<div class="status-dot" style="background:var(--cream-faint);animation:none;"></div>Demo Mode';
}

// ── Send message ─────────────────────────────────────────────────
async function sendMessage() {
  const input = $('chat-input');
  const text  = input.value.trim();
  if (!text || state.isTyping) return;

  input.value = ''; input.style.height = 'auto';
  state.isTyping = true; $('send-btn').disabled = true;
  addMessage('user', text);
  clearChips();

  // Capture the tool_result acknowledgments we're about to send so we can
  // re-queue them if this call fails — otherwise the preceding assistant
  // tool_use turn is left dangling and every future real call 400s.
  const sentToolResults = state.pendingToolResults;
  const userBlocks = [...sentToolResults, { type: 'text', text }];
  state.pendingToolResults = [];
  state.conversationHistory.push({ role: 'user', content: userBlocks });

  const hasEnough = (state.prefs.destination || state.demoCity) && state.prefs.num_guests;
  if (hasEnough) showSearchProgress(state.prefs.destination || state.demoCity || '');
  else showTyping();

  try {
    const { text: replyText, listings } = await callBackend();
    removeTyping(); removeSearchProgress();
    addMessage('assistant', buildAssistantBubbleHtml(replyText, listings), true);
  } catch (err) {
    removeTyping(); removeSearchProgress();
    // Roll back the optimistic turn so a later successful call isn't corrupted.
    state.conversationHistory.pop();
    // Re-queue the tool_result acks that were bundled into the popped turn, so
    // the still-present assistant tool_use turn gets satisfied on the next send
    // instead of being left dangling (which would 400 every future real call).
    state.pendingToolResults = sentToolResults;
    console.warn('Backend call failed, falling back to demo mode:', err.message);
    const reply = await simulateResponse(text);
    const isHtml = reply.includes('listing-card');
    addMessage('assistant', reply, isHtml);
  }

  state.isTyping = false; $('send-btn').disabled = false; input.focus();
}

function quickSend(el) {
  $('chat-input').value = el.textContent.replace(/^[\u{1F300}-\u{1FFFF}\s]+/u,'').trim();
  sendMessage();
}

function triggerSearch() {
  const dest = state.demoCity || state.prefs.destination || 'my destination';
  $('chat-input').value = `Find me the best options in ${dest} based on everything we discussed`;
  sendMessage();
}

function resetChat() {
  if (!confirm('Start a new search?')) return;
  state.prefs = {}; state.conversationHistory = []; state.pendingToolResults = [];
  state.messageCount = 0; state.demoCity = null; state.currentListings = []; state.compareList = [];
  if (state.map) { state.map.remove(); state.map = null; }
  state.markers = []; hideMap();
  $('map-toggle-btn').style.display = 'none';
  const bar = $('compare-bar'); if(bar) bar.classList.remove('visible');
  clearChips();

  messages.innerHTML = '';
  const welcome = document.createElement('div');
  welcome.className = 'welcome'; welcome.id = 'welcome-screen';
  welcome.innerHTML = `
    <div class="welcome-eyebrow">Powered by Claude AI</div>
    <div class="welcome-title">Find your perfect<br><em>place to stay</em></div>
    <div class="welcome-sub">Tell me where you're headed and I'll find the best Airbnbs and hotels — matched to your budget, style, and every preference.</div>
    <div class="quick-prompts">
      <div class="quick-prompt" onclick="quickSend(this)">🌴 Beach trip for 2 in Miami</div>
      <div class="quick-prompt" onclick="quickSend(this)">🏙️ NYC hotel under $200/night</div>
      <div class="quick-prompt" onclick="quickSend(this)">🐾 Pet-friendly Airbnb in Portland</div>
      <div class="quick-prompt" onclick="quickSend(this)">🎿 Ski cabin in Colorado, 6 guests</div>
      <div class="quick-prompt" onclick="quickSend(this)">🌆 Business trip to Chicago, near transit</div>
    </div>`;
  messages.appendChild(welcome);
  hide('pref-content'); show('pref-empty'); closeSidebar();
}

function handleKey(e) { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; }

// ── Boot ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderSavedSearches();
  readSharedUrl();
  checkBackend();

  // Delegated handler for listing "Compare" checkboxes. Covers both live and
  // demo cards (both injected into #messages) without inline handlers, so a
  // model-supplied listing id can never become executable attribute content.
  messages.addEventListener('change', (e) => {
    const cb = e.target.closest('.compare-toggle');
    if (cb) toggleCompare(cb.dataset.compareId, cb.checked);
  });

  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    const mic = $('mic-btn');
    if (mic) { mic.disabled = true; mic.title = 'Voice input not supported in this browser'; }
  }
});
