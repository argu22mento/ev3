/* EV3 · Carga inteligente — PWA
   Kia EV3 · batería 84,1 kWh · cargador 3,7 kW · precios PVPC de REE */
(() => {
  'use strict';

  const POWER = 3.7;          // kW
  const BATTERY = 84.1;       // kWh
  const CONSUMPTION = 16;     // kWh/100 km (estimación para "≈ km")
  const BONO = 0.5;           // descuento bono social sobre el kWh
  const FULL_MIN = Math.round(BATTERY / POWER * 60); // ≈ 22 h 44 min

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // ---------- Formato ----------
  const nf = d => new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  const f2 = nf(2), f4 = nf(4), f1 = nf(1), f0 = nf(0);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseDT = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = (time || '00:00').split(':').map(Number); return new Date(y, m - 1, d, h || 0, mi || 0, 0, 0); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const durTxt = min => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`; };
  const dayLabel = date => new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).format(parseDT(date, '12:00')).replace(/\./g, '');
  const num = s => { if (typeof s === 'number') return s; const v = parseFloat(String(s || '').trim().replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isNaN(v) ? NaN : v; };
  const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- Almacenamiento ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  // Movimientos: type 'home' (recarga en casa) | 'super' (supercarga) | 'gasto' (mantenimiento y otros)
  let charges = store.get('ev3.charges', []).map(c => ({ type: 'home', ...c }));
  const saveCharges = () => store.set('ev3.charges', charges);
  const TYPE_TXT = { home: 'Recarga casa', super: 'Supercarga', gasto: 'Gasto' };

  // ---------- Precios REE ----------
  const priceCache = store.get('ev3.prices', {});
  const inflight = {};
  const missUntil = {};

  function parseREE(json) {
    const inc = (json && json.included) || [];
    const s = inc.find(x => x.id === '1001') || inc.find(x => /pvpc/i.test((x.attributes && x.attributes.title) || x.type || ''));
    if (!s) return null;
    const b = Array.from({ length: 24 }, () => []);
    for (const v of s.attributes.values || []) {
      const h = parseInt(String(v.datetime).slice(11, 13), 10);
      if (h >= 0 && h < 24 && typeof v.value === 'number') b[h].push(v.value);
    }
    return b.map(a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length / 1000).toFixed(5) : null);
  }

  async function fetchPrices(date) {
    try {
      const r = await fetch(`/api/precios?date=${date}`, { cache: 'no-store' });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        if (r.ok && Array.isArray(j.hours)) return j.hours;
        if (j.error === 'no-data') return null;
      }
    } catch {}
    try {
      const url = `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${date}T00:00&end_date=${date}T23:59&time_trunc=hour&geo_trunc=electric_system&geo_limit=peninsular&geo_ids=8741`;
      const r = await fetch(url);
      if (r.ok) return parseREE(await r.json());
    } catch {}
    throw new Error('network');
  }

  function getPrices(date) {
    const c = priceCache[date];
    if (c && c.hours.filter(v => v != null).length >= 23) return Promise.resolve(c.hours);
    if (inflight[date]) return inflight[date];
    if (missUntil[date] > Date.now()) return Promise.resolve(c ? c.hours : null);
    inflight[date] = fetchPrices(date).then(hours => {
      delete inflight[date];
      if (hours && hours.some(v => v != null)) {
        priceCache[date] = { hours, t: Date.now() };
        const keys = Object.keys(priceCache).sort();
        while (keys.length > 120) delete priceCache[keys.shift()];
        store.set('ev3.prices', priceCache);
        return hours;
      }
      missUntil[date] = Date.now() + 5 * 60000;
      return null;
    }).catch(err => {
      delete inflight[date];
      missUntil[date] = Date.now() + 60000;
      if (c) return c.hours;
      throw err;
    });
    return inflight[date];
  }

  function levelsFor(hours) {
    const v = (hours || []).filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return () => 'na';
    const t1 = v[Math.floor((v.length - 1) / 3)], t2 = v[Math.floor((v.length - 1) * 2 / 3)];
    return p => p == null ? 'na' : p <= t1 ? 'b' : p <= t2 ? 'm' : 'c';
  }
  const LV_TXT = { b: 'Barato', m: 'Medio', c: 'Caro', na: 'Sin dato' };

  // ---------- Cálculo de carga en casa ----------
  async function calcCharge(date, start, end, bono = false) {
    const s = parseDT(date, start);
    let e = parseDT(date, end);
    if (e <= s) e = addDays(e, 1);
    const durMin = (e - s) / 60000;
    const k = bono ? BONO : 1;
    const slots = [];
    let t = new Date(s), kwh = 0, cost = 0, missing = 0;
    while (t < e) {
      const next = new Date(t); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
      const segEnd = next < e ? next : e;
      const mins = (segEnd - t) / 60000;
      const day = ymd(t), h = t.getHours();
      let hours = null;
      try { hours = await getPrices(day); } catch {}
      const price = hours ? hours[h] : null;
      const kw = POWER * mins / 60;
      kwh += kw;
      if (price == null) missing++; else cost += kw * price * k;
      slots.push({ day, h, mins, price, lv: levelsFor(hours)(price) });
      t = segEnd;
    }
    return { kwh, cost, costFull: bono ? cost / BONO : cost, missing, slots, durMin, avg: kwh ? cost / kwh : 0 };
  }

  // ---------- UI helpers ----------
  let toastT;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
  }
  const tip = $('#tooltip');
  function showTip(html, x, y) { tip.innerHTML = html; tip.style.left = x + 'px'; tip.style.top = (y - 10) + 'px'; tip.classList.add('show'); }
  function hideTip() { tip.classList.remove('show'); }

  function confirmBox(title, msg, okTxt = 'Eliminar', destructive = true) {
    return new Promise(res => {
      $('#alertTitle').textContent = title; $('#alertMsg').textContent = msg;
      const ok = $('#alertOk'); ok.textContent = okTxt; ok.classList.toggle('destructive', destructive);
      const a = $('#alert'); a.hidden = false;
      const done = v => { a.hidden = true; ok.onclick = $('#alertCancel').onclick = null; res(v); };
      ok.onclick = () => done(true);
      $('#alertCancel').onclick = () => done(false);
    });
  }

  let openSheetEl = null;
  function openSheet(el) {
    if (openSheetEl && openSheetEl !== el) openSheetEl.classList.remove('open');
    openSheetEl = el; el.classList.add('open'); $('#sheetBackdrop').classList.add('open');
    el.scrollTop = 0;
  }
  function closeSheet() {
    if (openSheetEl) openSheetEl.classList.remove('open');
    openSheetEl = null; $('#sheetBackdrop').classList.remove('open'); editId = null;
  }
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  function setupSeg(el, onChange) {
    const btns = [...el.querySelectorAll('button')];
    const thumb = el.querySelector('.seg-thumb');
    thumb.style.width = `calc((100% - 4px) / ${btns.length})`;
    const set = (i, fire = true) => {
      btns.forEach((b, j) => b.classList.toggle('on', j === i));
      thumb.style.transform = `translateX(${i * 100}%)`;
      if (fire) onChange(btns[i].dataset.v);
    };
    btns.forEach((b, i) => b.addEventListener('click', () => set(i)));
    set(0, false);
  }

  // ---------- Navegación ----------
  let view = 'inicio';
  const VIEWS = ['inicio', 'simulador', 'acumulado', 'gastos'];
  function go(v) {
    view = v;
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
    if (v === 'inicio') renderInicio();
    if (v === 'simulador') renderSim();
    if (v === 'acumulado') renderAcc();
    if (v === 'gastos') { renderGastos(); playIntro(); } else stopIntro();
    try { history.replaceState(null, '', v === 'inicio' ? location.pathname : '#' + v); } catch {}
  }
  $$('.rail-btn').forEach(b => b.addEventListener('click', () => { go(b.dataset.view); window.scrollTo({ top: 0, behavior: 'smooth' }); }));

  // ---------- Coche: morphing entre apartados + animación de entrada (Otros gastos) ----------
  const hero = $('.hero'), carBox = $('#car'), introVid = $('#gastoVideo');
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Posición del coche dentro de cada imagen (fracciones): centro, largo y proporción del archivo
  const GEO = {
    still: { ar: 478 / 1024, cx: 0.523, cy: 0.464, len: 0.793 },
    video: { ar: 640 / 554, cx: 0.556, cy: 0.470, len: 0.818 }
  };
  function carRect(g, W, H) {
    let w, h; if (W / H > g.ar) { h = H; w = H * g.ar; } else { w = W; h = W / g.ar; }
    return { x: (W - w) / 2 + g.cx * w, y: (H - h) / 2 + g.cy * h, len: g.len * h };
  }
  // transform que coloca el coche de "from" exactamente encima del coche de "to"
  function morph(from, to, W, H) {
    const a = carRect(from, W, H), b = carRect(to, W, H), s = b.len / a.len;
    const tx = b.x - W / 2 - s * (a.x - W / 2), ty = b.y - H / 2 - s * (a.y - H / 2);
    return `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
  }
  function layoutMorph() {
    const W = carBox.clientWidth, H = carBox.clientHeight; if (!W || !H) return;
    carBox.style.setProperty('--tv', morph(GEO.video, GEO.still, W, H));
    carBox.style.setProperty('--ts', morph(GEO.still, GEO.video, W, H));
  }
  window.addEventListener('resize', layoutMorph);

  let introTimer = null;
  function introFinal() { if (view !== 'gastos') return; hero.classList.remove('intro-play'); hero.classList.add('gasto', 'intro-final'); }
  function playIntro() {
    clearTimeout(introTimer);
    layoutMorph();
    hero.classList.remove('intro-final', 'intro-play');
    if (reducedMotion) { introFinal(); return; }
    try { introVid.pause(); introVid.currentTime = 0; } catch {}
    // El morph empieza cuando el vídeo ya está en marcha (su primer segundo es el coche solo)
    const onPlaying = () => { clearTimeout(introTimer); if (view === 'gastos') hero.classList.add('gasto', 'intro-play'); };
    introVid.addEventListener('playing', onPlaying, { once: true });
    const p = introVid.play();
    if (p && p.catch) p.catch(() => { introVid.removeEventListener('playing', onPlaying); introFinal(); });
    introTimer = setTimeout(() => { if (!hero.classList.contains('intro-play')) { introVid.removeEventListener('playing', onPlaying); introFinal(); } }, 2000);
  }
  function stopIntro() {
    clearTimeout(introTimer);
    hero.classList.remove('gasto', 'intro-play', 'intro-final');
    setTimeout(() => { if (view !== 'gastos') try { introVid.pause(); } catch {} }, 850);
  }
  // Al terminar, el vídeo se queda en su último fotograma (sin bucle)

  // ---------- Arranque: el coche "se abre" (doble parpadeo de intermitentes) ----------
  let booting = true;
  function finishBoot() {
    if (!booting) return;
    booting = false;
    hero.classList.remove('boot', 'blink');
    renderStatus();
  }
  function bootSequence() {
    layoutMorph();
    if (reducedMotion) { finishBoot(); return; }
    const imgs = [$('.car-img.reposo'), $('.car-img.lit')];
    const ready = Promise.all(imgs.map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
    const start = () => {
      if (!booting || !hero.classList.contains('boot')) return;
      requestAnimationFrame(() => {
        hero.classList.remove('boot');                     // aparece el coche
        setTimeout(() => {
          const lit = $('.car-img.lit');
          lit.addEventListener('animationend', finishBoot, { once: true });
          hero.classList.add('blink');                     // parpadeo × 2
          setTimeout(finishBoot, 2200);                    // por seguridad
        }, 700);
      });
    };
    Promise.race([ready, new Promise(r => setTimeout(r, 1500))]).then(start);
  }

  // ---------- Estado de carga (coche) ----------
  let live = store.get('ev3.live', null);

  function activeCharge(now = new Date()) {
    for (const c of charges) {
      if (c.type !== 'home') continue;
      const s = parseDT(c.date, c.start); let e = parseDT(c.date, c.end); if (e <= s) e = addDays(e, 1);
      if (now >= s && now < e) return { c, e };
    }
    return null;
  }

  function renderStatus() {
    const now = new Date();
    let charging = false, msg = 'En reposo';
    if (live) {
      const s = new Date(live.start), min = Math.max(0, (now - s) / 60000);
      charging = true;
      msg = `Cargando · desde ${hm(s)} · ${f1.format(Math.min(BATTERY, POWER * min / 60))} kWh`;
    } else {
      const a = activeCharge(now);
      if (a) { charging = true; msg = `Cargando · hasta ${hm(a.e)}`; }
    }
    $('.hero').classList.toggle('charging', charging && !booting);
    $('#status').classList.toggle('on', charging);
    $('#statusText').textContent = msg;
    const btn = $('#liveBtn');
    btn.classList.toggle('on', !!live);
    btn.setAttribute('aria-label', live ? 'Detener carga' : 'Iniciar carga');
  }

  $('#liveBtn').addEventListener('click', async () => {
    if (!live) {
      const n = new Date(); n.setSeconds(0, 0);
      live = { start: n.toISOString() }; store.set('ev3.live', live);
      toast('Carga iniciada'); renderStatus();
    } else {
      if (!(await confirmBox('¿Detener la carga?', 'Podrás revisarla y registrarla en Recargas.', 'Detener', false))) return;
      const s = new Date(live.start), e = new Date();
      live = null; store.set('ev3.live', null); renderStatus();
      simState = { date: ymd(s), start: hm(s), end: hm(e) };
      go('simulador'); toast('Revisa y registra la carga');
    }
  });

  // ---------- INICIO ----------
  let dayIdx = 0, selHour = null, lastDay = null, dayData = null;
  let bonoPref = store.get('ev3.bono', false);

  async function renderInicio() {
    const today = new Date();
    const date = ymd(addDays(today, dayIdx));
    const chart = $('#chart');
    if (lastDay !== date) { selHour = null; lastDay = date; }

    let hours = null, err = false;
    try { hours = await getPrices(date); } catch { err = true; }
    if (ymd(addDays(new Date(), dayIdx)) !== date) return;

    const has = hours && hours.some(v => v != null);
    chart.innerHTML = '';
    chart.classList.remove('has-sel');
    $('#bestCard').hidden = true;
    $('#chartCard').classList.toggle('clickable', !!has);
    dayData = has ? { date, hours } : null;

    if (!has) {
      $('#priceValue').textContent = '—';
      const b = $('#priceBadge'); b.className = 'badge'; b.textContent = 'Sin datos';
      $('#priceLabel').textContent = dayIdx ? 'Mañana' : 'Precio ahora';
      const m = err ? 'No se han podido cargar los precios. Revisa la conexión.'
        : dayIdx ? 'REE publica los precios de mañana a partir de las 20:15 h.'
        : 'Aún no hay precios disponibles para hoy.';
      $('#priceHour').textContent = m;
      for (let h = 0; h < 24; h++) chart.insertAdjacentHTML('beforeend', `<div class="bar na"><i style="height:${18 + 10 * Math.sin(h / 3.5) ** 2}%"></i></div>`);
      chart.insertAdjacentHTML('beforeend', `<div class="chart-empty">${m}</div>`);
      $('#dayStats').innerHTML = '';
      return;
    }

    const lv = levelsFor(hours);
    const valid = hours.map((p, h) => ({ p, h })).filter(x => x.p != null);
    const max = Math.max(...valid.map(x => x.p));
    const min = Math.min(...valid.map(x => x.p));
    const nowH = dayIdx === 0 ? today.getHours() : null;
    if (selHour == null) selHour = nowH != null ? nowH : valid.reduce((a, b) => b.p < a.p ? b : a).h;

    hours.forEach((p, h) => {
      const bar = document.createElement('div');
      bar.className = `bar ${lv(p)}${h === nowH ? ' now' : ''}${h === selHour ? ' sel' : ''}`;
      bar.innerHTML = `<i style="height:0%"></i>`;
      const html = `${pad(h)}:00 – ${pad((h + 1) % 24)}:00<br><b>${p == null ? '—' : f4.format(p)}</b> €/kWh · ${LV_TXT[lv(p)]}`;
      bar.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { const r = bar.getBoundingClientRect(); showTip(html, r.left + r.width / 2, r.top); } });
      bar.addEventListener('pointerleave', hideTip);
      bar.addEventListener('click', ev => { ev.stopPropagation(); hideTip(); selHour = h; updateSel(); openPriceSheet(h); });
      chart.appendChild(bar);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.firstChild.style.height = p == null ? '4%' : `${Math.max(6, (p / max) * 100)}%`;
      }));
    });
    chart.classList.add('has-sel');

    function updateSel() {
      [...chart.children].forEach((b, i) => b.classList.toggle('sel', i === selHour));
      const p = hours[selHour], l = lv(p);
      $('#priceLabel').textContent = selHour === nowH ? 'Precio ahora' : `Precio a las ${pad(selHour)}:00${dayIdx ? ' · mañana' : ''}`;
      $('#priceValue').textContent = p == null ? '—' : f4.format(p);
      const b = $('#priceBadge'); b.className = `badge ${l}`; b.textContent = LV_TXT[l];
      $('#priceHour').textContent = `${pad(selHour)}:00 – ${pad((selHour + 1) % 24)}:00` + (p == null ? '' : ` · ${f2.format(p * POWER * (bonoPref ? BONO : 1))} € por hora de carga${bonoPref ? ' (bono social)' : ''}`);
    }
    updateSel();

    const avg = valid.reduce((a, x) => a + x.p, 0) / valid.length;
    const minH = valid.find(x => x.p === min).h, maxH = valid.find(x => x.p === max).h;
    $('#dayStats').innerHTML = `
      <div><small>Mínimo · ${pad(minH)}h</small><b>${f4.format(min)}</b></div>
      <div><small>Media</small><b>${f4.format(avg)}</b></div>
      <div><small>Máximo · ${pad(maxH)}h</small><b>${f4.format(max)}</b></div>`;

    const W = 4, from = nowH != null ? nowH : 0;
    let best = null;
    for (let h = from; h + W <= 24; h++) {
      const seg = hours.slice(h, h + W);
      if (seg.some(v => v == null)) continue;
      const m = seg.reduce((a, b) => a + b, 0) / W;
      if (!best || m < best.m) best = { h, m };
    }
    if (best) {
      const kwh = POWER * W, k = bonoPref ? BONO : 1;
      $('#bestText').textContent = `${pad(best.h)}:00 – ${pad((best.h + W) % 24)}:00`;
      $('#bestSub').textContent = `Media ${f4.format(best.m)} €/kWh · ${f1.format(kwh)} kWh por ${f2.format(kwh * best.m * k)} € · Toca para simular`;
      const card = $('#bestCard'); card.hidden = false;
      card.onclick = () => { simState = { date, start: `${pad(best.h)}:00`, end: `${pad((best.h + W) % 24)}:00` }; go('simulador'); };
    }
  }

  // Pop-up con el detalle de las 24 horas
  function openPriceSheet(focusH) {
    if (!dayData) return;
    const { date, hours } = dayData;
    const lv = levelsFor(hours);
    const k = bonoPref ? BONO : 1;
    const nowH = date === ymd(new Date()) ? new Date().getHours() : null;
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    $('#psTitle').textContent = `${dayIdx ? 'Mañana' : 'Hoy'} · ${dayLabel(date)}`;
    $('#psSub').textContent = `PVPC con impuestos · coste de 1 h de carga a 3,7 kW${bonoPref ? ' con bono social (−50 %)' : ''}`;
    $('#psCostHead').textContent = bonoPref ? '1 h (bono)' : '1 h carga';
    $('#psRows').innerHTML = hours.map((p, h) => {
      const l = lv(p);
      return `<div class="ptr ${h === focusH ? 'focus' : ''} ${h === nowH ? 'now' : ''}" data-h="${h}">
        <span><i class="lvdot ${l}"></i>${pad(h)}:00 – ${pad((h + 1) % 24)}:00${h === nowH ? '<em>ahora</em>' : ''}</span>
        <span>${p == null ? '—' : f4.format(p)}</span>
        <span><b>${p == null ? '—' : f2.format(p * POWER * k) + ' €'}</b><small class="lvtxt ${l}">${LV_TXT[l]}</small></span>
      </div>`;
    }).join('');
    const valid = hours.filter(v => v != null);
    const sum = valid.reduce((a, b) => a + b, 0);
    $('#psStats').innerHTML = `
      <div><small>Media del día</small><b>${f4.format(sum / valid.length)}</b></div>
      <div><small>24 h de carga</small><b>${f2.format(sum * POWER * k)} €</b></div>
      <div><small>Energía 24 h</small><b>${f1.format(POWER * valid.length)} kWh</b></div>`;
    openSheet($('#priceSheet'));
    const row = $(`#psRows .ptr[data-h="${focusH}"]`);
    if (row) setTimeout(() => row.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
  }
  $('#chart').addEventListener('click', () => openPriceSheet(selHour));
  $('#chart').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPriceSheet(selHour); } });

  setupSeg($('[data-seg="day"]'), v => { dayIdx = +v; renderInicio(); });

  // ---------- RECARGAS: casa ----------
  let simState = null, simResult = null, simSeq = 0;
  $('#simBono').checked = bonoPref;

  function renderSim() {
    if (simState) {
      $('#simDate').value = simState.date; $('#simStart').value = simState.start; $('#simEnd').value = simState.end;
      simState = null;
    }
    if (!$('#simDate').value) $('#simDate').value = ymd(new Date());
    if (!$('#supDate').value) { const n = new Date(); $('#supDate').value = ymd(n); $('#supTime').value = hm(n); }
    runSim(); updateSuper();
  }

  async function runSim() {
    const date = $('#simDate').value, start = $('#simStart').value, end = $('#simEnd').value, bono = $('#simBono').checked;
    const btn = $('#simSave'), warn = $('#simWarn');
    if (!date || !start || !end) { btn.disabled = true; return; }
    const seq = ++simSeq;
    btn.disabled = true;
    const r = await calcCharge(date, start, end, bono);
    if (seq !== simSeq) return;
    simResult = { date, start, end, bono, ...r };

    $('#simKwh').textContent = f2.format(r.kwh);
    $('#simCost').textContent = r.missing === r.slots.length ? '—' : f2.format(r.cost);
    $('#simCostNote').textContent = bono && !r.missing ? `€ · sin bono ${f2.format(r.costFull)} €` : '€';
    $('#simDur').textContent = durTxt(r.durMin);
    $('#simAvg').textContent = r.missing ? '—' : `${f4.format(r.avg)} €`;
    $('#simPct').textContent = `+${f0.format(Math.min(100, r.kwh / BATTERY * 100))} %`;

    const pmax = Math.max(0.0001, ...r.slots.map(s => s.price || 0));
    $('#simBreak').innerHTML = r.slots.map(s =>
      `<div class="bar ${s.lv}" title="${s.day.slice(8)}/${s.day.slice(5, 7)} ${pad(s.h)}:00 · ${s.price == null ? 'sin precio' : f4.format(s.price) + ' €/kWh'}"><i style="height:${s.price == null ? 30 : Math.max(10, s.price / pmax * 100)}%"></i></div>`).join('');

    const msgs = [];
    if (r.missing) msgs.push(`Faltan precios de ${r.missing} ${r.missing === 1 ? 'hora' : 'horas'}. REE publica los del día siguiente a partir de las 20:15 h.`);
    if (r.kwh > BATTERY) msgs.push(`La energía supera la capacidad de la batería (84,1 kWh). Una carga completa de 0 a 100 % dura ${durTxt(FULL_MIN)}.`);
    warn.hidden = !msgs.length; warn.textContent = msgs.join(' ');
    btn.disabled = !!r.missing || r.kwh <= 0;
  }

  ['#simDate', '#simStart', '#simEnd'].forEach(s => $(s).addEventListener('input', runSim));
  $('#simBono').addEventListener('change', e => { bonoPref = e.target.checked; store.set('ev3.bono', bonoPref); runSim(); });
  $('#simChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = parseDT($('#simDate').value || ymd(new Date()), $('#simStart').value || '00:00');
    const mins = b.dataset.full != null ? FULL_MIN : +b.dataset.h * 60;
    $('#simEnd').value = hm(new Date(s.getTime() + mins * 60000));
    runSim();
  });
  $('#simSave').addEventListener('click', () => {
    if (!simResult || simResult.missing) return;
    const { date, start, end, kwh, cost, costFull, bono } = simResult;
    charges.push({ id: uid(), type: 'home', date, start, end, kwh: +kwh.toFixed(3), cost: +cost.toFixed(4), costFull: +costFull.toFixed(4), bono, createdAt: new Date().toISOString() });
    saveCharges(); renderStatus();
    toast(`Carga registrada · ${f2.format(cost)} €${bono ? ' (bono social)' : ''}`);
  });

  // ---------- RECARGAS: supercarga ----------
  function updateSuper() {
    const kwh = num($('#supKwh').value), cost = num($('#supCost').value);
    const ok = $('#supDate').value && kwh > 0 && cost >= 0 && !isNaN(cost);
    $('#supSave').disabled = !ok;
    $('#supAvg').textContent = ok && kwh ? `${f4.format(cost / kwh)} €` : '—';
    $('#supPct').textContent = kwh > 0 ? `+${f0.format(Math.min(100, kwh / BATTERY * 100))} %` : '—';
    const today = priceCache[ymd(new Date())];
    if (ok && kwh && today) {
      const v = today.hours.filter(x => x != null), avg = v.reduce((a, b) => a + b, 0) / v.length * (bonoPref ? BONO : 1);
      $('#supVs').textContent = `×${f1.format((cost / kwh) / avg)}`;
    } else $('#supVs').textContent = '—';
  }
  ['#supDate', '#supKwh', '#supCost'].forEach(s => $(s).addEventListener('input', updateSuper));
  $('#supSave').addEventListener('click', () => {
    const kwh = num($('#supKwh').value), cost = num($('#supCost').value);
    if (!(kwh > 0) || isNaN(cost)) return;
    charges.push({ id: uid(), type: 'super', date: $('#supDate').value, start: $('#supTime').value || '', end: '', kwh: +kwh.toFixed(3), cost: +cost.toFixed(4), place: $('#supPlace').value.trim(), createdAt: new Date().toISOString() });
    saveCharges();
    $('#supKwh').value = ''; $('#supCost').value = ''; $('#supPlace').value = '';
    updateSuper();
    toast(`Supercarga añadida · ${f2.format(cost)} €`);
  });

  // ---------- OTROS GASTOS ----------
  function renderGastos() {
    if (!$('#gDate').value) $('#gDate').value = ymd(new Date());
    updateGasto();
    const list = charges.filter(c => c.type === 'gasto').sort(sortDesc);
    const year = String(new Date().getFullYear());
    const tot = list.filter(c => c.date.startsWith(year)).reduce((a, c) => a + c.cost, 0);
    $('#gTotal').textContent = list.length ? `${year}: ${f2.format(tot)} €` : '';
    $('#gList').innerHTML = list.length ? list.slice(0, 30).map(itemHtml).join('') : `<li class="empty">Aún no hay gastos</li>`;
  }
  function updateGasto() {
    const a = num($('#gAmount').value);
    $('#gSave').disabled = !($('#gDate').value && a > 0);
  }
  ['#gDate', '#gAmount'].forEach(s => $(s).addEventListener('input', updateGasto));
  $('#gSave').addEventListener('click', () => {
    const a = num($('#gAmount').value); if (!(a > 0)) return;
    const cat = $('#gCat').value, concept = $('#gConcept').value.trim();
    charges.push({ id: uid(), type: 'gasto', date: $('#gDate').value, start: '', end: '', kwh: 0, cost: +a.toFixed(2), category: cat, concept, createdAt: new Date().toISOString() });
    saveCharges();
    $('#gAmount').value = ''; $('#gConcept').value = '';
    renderGastos();
    toast(`Gasto añadido · ${f2.format(a)} €`);
  });
  $('#gList').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) openEdit(li.dataset.id); });

  // ---------- ACUMULADO ----------
  let period = 'week', offset = 0;
  const typeFilter = new Set();
  const sortDesc = (a, b) => (b.date + (b.start || '')).localeCompare(a.date + (a.start || ''));

  function periodRange() {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let from, to, label;
    if (period === 'week') {
      const dow = (now.getDay() + 6) % 7;
      from = addDays(now, -dow + offset * 7); to = addDays(from, 7);
      const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
      label = offset === 0 ? 'Esta semana' : `${fmt.format(from)} – ${fmt.format(addDays(to, -1))}`.replace(/\./g, '');
    } else if (period === 'month') {
      from = new Date(now.getFullYear(), now.getMonth() + offset, 1); to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
      label = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(from);
    } else {
      from = new Date(now.getFullYear() + offset, 0, 1); to = new Date(from.getFullYear() + 1, 0, 1);
      label = String(from.getFullYear());
    }
    return { from: ymd(from), to: ymd(to), label };
  }

  const ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M4 10.5 12 4l8 6.5V20H4z"/><path d="M12.8 10.5 10.5 14h3l-2.3 3.5"/></svg>',
    super: '<svg viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>',
    gasto: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.5-.6-.6-2.5z"/></svg>'
  };

  function itemHtml(c) {
    let sub = '', right2 = '';
    if (c.type === 'home') {
      const s = parseDT(c.date, c.start); let e = parseDT(c.date, c.end); if (e <= s) e = addDays(e, 1);
      sub = `${c.start} – ${c.end} · ${durTxt((e - s) / 60000)}${c.bono ? ' · <span class="tag">Bono social</span>' : ''}`;
      right2 = `${f1.format(c.kwh)} kWh`;
    } else if (c.type === 'super') {
      sub = `Supercarga${c.start ? ' · ' + c.start : ''}${c.place ? ' · ' + escH(c.place) : ''}`;
      right2 = `${f1.format(c.kwh)} kWh`;
    } else {
      sub = `${escH(c.category || 'Gasto')}${c.concept ? ' · ' + escH(c.concept) : ''}`;
      right2 = escH(c.category || '');
    }
    return `<li data-id="${c.id}">
      <span class="ic ${c.type}">${ICONS[c.type]}</span>
      <span class="main"><b>${dayLabel(c.date)}</b><span>${sub}</span></span>
      <span class="amt"><b>${f2.format(c.cost)} €</b><span>${c.type === 'gasto' ? '' : right2}</span></span>
      <svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
    </li>`;
  }

  function renderAcc() {
    const { from, to, label } = periodRange();
    $('#periodLabel').textContent = label;
    $('#nextPeriod').disabled = offset >= 0;
    $$('#typeChips button').forEach(b => b.classList.toggle('on', typeFilter.has(b.dataset.t)));
    const inPeriod = charges.filter(c => c.date >= from && c.date < to);
    const list = inPeriod.filter(c => !typeFilter.size || typeFilter.has(c.type)).sort(sortDesc);
    const energy = list.filter(c => c.type !== 'gasto');
    const kwh = energy.reduce((a, c) => a + c.kwh, 0);
    const eCost = energy.reduce((a, c) => a + c.cost, 0);
    const cost = list.reduce((a, c) => a + c.cost, 0);
    $('#accCost').textContent = f2.format(cost);
    $('#accKwh').textContent = f1.format(kwh);
    $('#accN').textContent = list.length;
    $('#accAvg').textContent = kwh ? `${f4.format(eCost / kwh)} €` : '—';
    $('#accKm').textContent = kwh ? f0.format(kwh / CONSUMPTION * 100) : '—';

    const parts = ['home', 'super', 'gasto'].filter(t => !typeFilter.size || typeFilter.has(t))
      .map(t => ({ t, v: list.filter(c => c.type === t).reduce((a, c) => a + c.cost, 0) }));
    const NAMES = { home: 'Casa', super: 'Supercargas', gasto: 'Mantenimientos' };
    $('#accSplit').innerHTML = cost > 0
      ? `<div class="split-bar">${parts.filter(p => p.v > 0).map(p => `<i class="${p.t}" style="flex:${p.v}"></i>`).join('')}</div>
         <div class="split-legend">${parts.map(p => `<span><i class="dot-t ${p.t}"></i>${NAMES[p.t]} <b>${f2.format(p.v)} €</b></span>`).join('')}</div>`
      : '';

    const names = [...typeFilter].map(t => ({ home: 'recargas', super: 'supercargas', gasto: 'mantenimientos' }[t]));
    $('#listTitle').textContent = names.length ? `Movimientos · ${names.join(', ')}` : 'Movimientos';
    const ul = $('#accList');
    ul.innerHTML = list.length ? list.map(itemHtml).join('') : `<li class="empty">No hay movimientos en este periodo</li>`;
  }

  setupSeg($('[data-seg="period"]'), v => { period = v; offset = 0; renderAcc(); });
  $('#typeChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.t; typeFilter.has(t) ? typeFilter.delete(t) : typeFilter.add(t);
    renderAcc();
  });
  $('#prevPeriod').addEventListener('click', () => { offset--; renderAcc(); });
  $('#nextPeriod').addEventListener('click', () => { if (offset < 0) { offset++; renderAcc(); } });
  $('#accList').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) openEdit(li.dataset.id); });

  // ---------- Hoja de edición ----------
  let editId = null;
  function openEdit(id) {
    const c = charges.find(x => x.id === id); if (!c) return;
    editId = id;
    const sh = $('#sheet');
    sh.querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(c.type); });
    $('#sheetTitle').textContent = { home: 'Editar recarga', super: 'Editar supercarga', gasto: 'Editar gasto' }[c.type];
    $('#edDate').value = c.date;
    $('#edStart').value = c.start || ''; $('#edEnd').value = c.end || '';
    $('#edTime').value = c.type === 'super' ? (c.start || '') : '';
    $('#edPlace').value = c.place || '';
    $('#edCat').value = c.category || 'Otros';
    $('#edConcept').value = c.concept || '';
    $('#edBono').checked = !!c.bono;
    $('#edKwh').value = f2.format(c.kwh || 0);
    $('#edCost').value = f2.format(c.cost || 0);
    $('#edCostLabel').textContent = c.type === 'gasto' ? 'Importe (€)' : 'Coste (€)';
    openSheet(sh);
  }

  async function recalcEdit() {
    const c = charges.find(x => x.id === editId); if (!c || c.type !== 'home') return;
    const d = $('#edDate').value, s = $('#edStart').value, e = $('#edEnd').value;
    if (!d || !s || !e) return;
    const r = await calcCharge(d, s, e, $('#edBono').checked);
    $('#edKwh').value = f2.format(r.kwh);
    $('#edCost').value = f2.format(r.cost);
    if (r.missing) toast(`Faltan precios de ${r.missing} h`);
  }
  ['#edDate', '#edStart', '#edEnd'].forEach(s => $(s).addEventListener('change', () => { const c = charges.find(x => x.id === editId); if (c && c.type === 'home') recalcEdit(); }));
  $('#edBono').addEventListener('change', recalcEdit);
  $('#edRecalc').addEventListener('click', async () => { await recalcEdit(); toast('Recalculado con REE'); });

  function refreshAll() { renderStatus(); if (view === 'acumulado') renderAcc(); if (view === 'gastos') renderGastos(); }

  $('#edSave').addEventListener('click', () => {
    const c = charges.find(x => x.id === editId); if (!c) return;
    const cost = num($('#edCost').value), kwh = num($('#edKwh').value);
    if (!$('#edDate').value || isNaN(cost)) { toast('Revisa los datos'); return; }
    c.date = $('#edDate').value; c.cost = +cost.toFixed(4); c.updatedAt = new Date().toISOString();
    if (c.type === 'home') {
      if (!$('#edStart').value || !$('#edEnd').value || isNaN(kwh)) { toast('Revisa los datos'); return; }
      Object.assign(c, { start: $('#edStart').value, end: $('#edEnd').value, kwh, bono: $('#edBono').checked });
      c.costFull = c.bono ? +(c.cost / BONO).toFixed(4) : c.cost;
    } else if (c.type === 'super') {
      if (isNaN(kwh)) { toast('Revisa los datos'); return; }
      Object.assign(c, { start: $('#edTime').value, kwh, place: $('#edPlace').value.trim() });
    } else {
      Object.assign(c, { category: $('#edCat').value, concept: $('#edConcept').value.trim() });
    }
    saveCharges(); closeSheet(); refreshAll(); toast('Cambios guardados');
  });
  $('#edDelete').addEventListener('click', async () => {
    const id = editId;
    if (!(await confirmBox('¿Eliminar este movimiento?', 'Esta acción no se puede deshacer.'))) return;
    charges = charges.filter(x => x.id !== id);
    saveCharges(); closeSheet(); refreshAll(); toast('Eliminado');
  });

  // ---------- Excel: exportar / importar ----------
  const HEAD = ['ID', 'Tipo', 'Fecha', 'Inicio', 'Fin', 'kWh', 'Coste (€)', '€/kWh', 'Bono social', 'Categoría', 'Concepto / lugar'];

  function exportExcel() {
    if (!window.XLSXLite) { toast('No se pudo cargar el módulo de Excel'); return; }
    const all = [...charges].sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
    const H = HEAD.map(v => ({ v, s: 'b' }));
    const rows = all.map(c => [
      c.id, TYPE_TXT[c.type], { v: c.date, s: 'date' },
      c.type === 'gasto' ? '' : (c.start || ''), c.type === 'home' ? c.end : '',
      c.type === 'gasto' ? '' : { v: +(+c.kwh).toFixed(3) },
      { v: +(+c.cost).toFixed(2), s: 'money' },
      c.type !== 'gasto' && c.kwh ? +(c.cost / c.kwh).toFixed(4) : '',
      c.type === 'home' ? (c.bono ? 'Sí' : 'No') : '',
      c.type === 'gasto' ? (c.category || '') : '',
      c.type === 'gasto' ? (c.concept || '') : (c.place || '')
    ]);
    // Resumen mensual
    const months = {};
    for (const c of all) {
      const k = c.date.slice(0, 7), m = months[k] || (months[k] = { home: 0, homeK: 0, super: 0, superK: 0, gasto: 0 });
      m[c.type] += c.cost; if (c.type === 'home') m.homeK += c.kwh; if (c.type === 'super') m.superK += c.kwh;
    }
    const mf = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
    const RH = ['Mes', 'Recargas casa (€)', 'kWh casa', 'Supercargas (€)', 'kWh supercargas', 'Mantenimientos y otros (€)', 'Total (€)'].map(v => ({ v, s: 'b' }));
    const tot = { home: 0, homeK: 0, super: 0, superK: 0, gasto: 0 };
    const rrows = Object.keys(months).sort().map(k => {
      const m = months[k]; Object.keys(tot).forEach(x => tot[x] += m[x]);
      const [y, mo] = k.split('-').map(Number);
      return [mf.format(new Date(y, mo - 1, 1)), { v: +m.home.toFixed(2), s: 'money' }, +m.homeK.toFixed(2), { v: +m.super.toFixed(2), s: 'money' }, +m.superK.toFixed(2), { v: +m.gasto.toFixed(2), s: 'money' }, { v: +(m.home + m.super + m.gasto).toFixed(2), s: 'money' }];
    });
    rrows.push([{ v: 'Total', s: 'b' }, { v: +tot.home.toFixed(2), s: 'bmoney' }, +tot.homeK.toFixed(2), { v: +tot.super.toFixed(2), s: 'bmoney' }, +tot.superK.toFixed(2), { v: +tot.gasto.toFixed(2), s: 'bmoney' }, { v: +(tot.home + tot.super + tot.gasto).toFixed(2), s: 'bmoney' }]);

    const blob = XLSXLite.write([
      { name: 'Movimientos', cols: [14, 14, 12, 8, 8, 9, 11, 9, 11, 16, 30], rows: [H, ...rows] },
      { name: 'Resumen', cols: [18, 17, 10, 16, 15, 24, 11], rows: [RH, ...rrows] }
    ]);
    const name = `EV3-movimientos-${ymd(new Date())}.xlsx`;
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      navigator.share({ files: [file], title: name }).catch(() => {});
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    toast(`Excel exportado · ${all.length} movimientos`);
  }
  $('#exportBtn').addEventListener('click', exportExcel);

  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9€/]/g, '');
  function cellDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return XLSXLite.serialToYMD(v);
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return null;
  }
  function cellTime(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { const mins = Math.round((v % 1) * 1440) % 1440; return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; }
    const m = /(\d{1,2})[:.h](\d{2})/.exec(String(v)); return m ? `${pad(+m[1])}:${m[2]}` : '';
  }

  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const sheets = await XLSXLite.read(await f.arrayBuffer());
      const sh = sheets.find(s => norm(s.name) === 'movimientos') || sheets[0];
      if (!sh || !sh.rows.length) throw new Error('vacío');
      const hi = sh.rows.findIndex(r => r && r.some(v => norm(v) === 'tipo') && r.some(v => norm(v) === 'fecha'));
      if (hi < 0) throw new Error('cabecera');
      const head = sh.rows[hi].map(norm);
      const col = (...names) => head.findIndex(h => names.includes(h));
      const C = { id: col('id'), tipo: col('tipo'), fecha: col('fecha'), ini: col('inicio', 'hora'), fin: col('fin'), kwh: col('kwh'),
        coste: col('coste€', 'coste', 'importe', 'importe€'), bono: col('bonosocial', 'bono'), cat: col('categoria'), conc: col('concepto/lugar', 'concepto', 'lugar') };
      const parsed = [];
      for (const r of sh.rows.slice(hi + 1)) {
        if (!r || r.every(v => v == null || v === '')) continue;
        const date = cellDate(r[C.fecha]); if (!date) continue;
        const tt = norm(r[C.tipo]);
        const type = /super/.test(tt) ? 'super' : /gasto|mant|recamb|otro|seguro|itv|neum/.test(tt) ? 'gasto' : 'home';
        const cost = num(r[C.coste]); if (isNaN(cost)) continue;
        const o = { id: (C.id >= 0 && r[C.id] != null && String(r[C.id]).trim()) ? String(r[C.id]).trim() : uid(), type, date, cost: +cost.toFixed(4) };
        if (type === 'gasto') Object.assign(o, { start: '', end: '', kwh: 0, category: C.cat >= 0 ? String(r[C.cat] ?? '') || 'Otros' : 'Otros', concept: C.conc >= 0 ? String(r[C.conc] ?? '') : '' });
        else {
          const kwh = num(r[C.kwh]);
          o.kwh = isNaN(kwh) ? 0 : +kwh.toFixed(3);
          o.start = cellTime(r[C.ini]);
          if (type === 'home') {
            o.end = cellTime(r[C.fin]) || o.start || '00:00'; o.start = o.start || '00:00';
            o.bono = C.bono >= 0 && /^(si|s|true|1|x|yes)$/.test(norm(r[C.bono]));
            o.costFull = o.bono ? +(o.cost / BONO).toFixed(4) : o.cost;
          } else { o.end = ''; o.place = C.conc >= 0 ? String(r[C.conc] ?? '') : ''; }
        }
        parsed.push(o);
      }
      if (!parsed.length) { toast('No se encontraron movimientos en el Excel'); return; }
      const ids = new Map(charges.map((c, i) => [c.id, i]));
      const nNew = parsed.filter(p => !ids.has(p.id)).length, nUpd = parsed.length - nNew;
      const ok = await confirmBox('Subir Excel', `${nNew} movimientos nuevos${nUpd ? ` y ${nUpd} actualizados` : ''}. Los que ya tienes y no estén en el Excel se mantienen.`, 'Importar', false);
      if (!ok) return;
      for (const p of parsed) { if (ids.has(p.id)) charges[ids.get(p.id)] = { ...charges[ids.get(p.id)], ...p }; else charges.push({ ...p, createdAt: new Date().toISOString() }); }
      saveCharges(); refreshAll();
      toast(`${parsed.length} movimientos importados`);
    } catch (err) {
      console.error(err);
      toast('No se pudo leer el Excel');
    }
  });

  // ---------- Arranque ----------
  renderStatus();
  go('inicio');            // la app arranca siempre en Inicio
  bootSequence();
  getPrices(ymd(addDays(new Date(), 1))).catch(() => {});

  let lastTick = ymd(new Date()) + new Date().getHours();
  setInterval(() => {
    renderStatus();
    const k = ymd(new Date()) + new Date().getHours();
    if (k !== lastTick) { lastTick = k; selHour = null; if (view === 'inicio') renderInicio(); }
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderStatus(); if (view === 'inicio') renderInicio(); } });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
