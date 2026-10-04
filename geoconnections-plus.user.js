// ==UserScript==
// @name         GeoConnections+
// @namespace    jago/geoconnections-solution-viewer
// @version      3.8.1
// @description  Zeigt die Lösungsboxen am Spielende untereinander statt im Blätterer "1 / 4" und ergänzt eine KI-Prompt-Box.
// @author       jago/claude
// @license      MIT
// @match        https://geotrivia.com/*
// @icon         https://geotrivia.com/geoconnections-icon.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION =
    (typeof GM_info !== 'undefined' &&
      GM_info.script &&
      GM_info.script.version) ||
    '?';
  console.log('[GC] geladen (v' + VERSION + ') auf', location.href);

  const BLOCK_ID = 'gc-prompt-block';

  // ChatGPT mit vorausgefülltem Prompt öffnen (erfordert ChatGPT-Login)
  const CHATGPT_URL = (prompt) =>
    'https://chatgpt.com/?q=' + encodeURIComponent(prompt);

  // Statik-Mapping: Kategorie-Caption -> KI-freundlicher Begriff. Hier bei Bedarf erweitern.
  const CATEGORY_PROMPT_MAP = {
    'Größe (M)': 'durchschnittliche Größe der Männer',
    'Durchschnitts-Temp.': 'Durchschnittstemperatur',
  };

  const STYLE_ID = 'gc-style';
  const TRACK_CLASS = 'gc-track';
  const NAV_CLASS = 'gc-nav';
  const UNCLIP_CLASS = 'gc-unclip';
  const HEAD_CLASS = 'gc-slide-head';
  const STYLE = `
    #${BLOCK_ID} .gc-prompt { white-space: pre-wrap; opacity: 0.9; }
    /* Blätterer -> vertikale Liste: alle Lösungsboxen untereinander */
    .${TRACK_CLASS} {
      width: 100% !important;
      transform: none !important;
      flex-direction: column !important;
      gap: 1.25rem;
    }
    .${TRACK_CLASS} > * { width: 100% !important; }
    .${NAV_CLASS},
    .${HEAD_CLASS} { display: none !important; }
    /* feste Höhe/eigener Scrollbereich aufheben, damit der äußere
       Ergebnis-Screen alles am Stück scrollt */
    .${UNCLIP_CLASS} {
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
  `;

  const COPY_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path></svg>';
  const CHECK_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>';
  const OPEN_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M224,104a8,8,0,0,1-16,0V59.31l-66.34,66.35a8,8,0,0,1-11.32-11.32L196.69,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z"></path></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function regionName(code) {
    try {
      return (
        new Intl.DisplayNames(['de'], { type: 'region' }).of(
          code.toUpperCase(),
        ) || code
      );
    } catch (e) {
      return code;
    }
  }

  // ---- initialData aus einem RSC-Flight-Text herausschneiden ----
  function extractInitialData(full) {
    const ki = full.indexOf('"initialData":');
    if (ki === -1) return null;
    let i = full.indexOf('{', ki);
    if (i === -1) return null;
    const start = i;
    let depth = 0,
      inStr = false,
      esc = false;
    for (; i < full.length; i++) {
      const ch = full[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        if (--depth === 0) {
          i++;
          break;
        }
      }
    }
    try {
      return JSON.parse(full.slice(start, i));
    } catch (e) {
      console.error('[GC] JSON-Parse fehlgeschlagen', e);
      return null;
    }
  }

  // Inline aus den Script-Tags des aktuellen Dokuments (schnell, bei echtem Seitenladen)
  function flightFromDocument() {
    let full = '';
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || t.indexOf('__next_f.push') === -1) continue;
      const m = t.match(
        /__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/s,
      );
      if (m) {
        try {
          full += JSON.parse(m[1]);
        } catch (e) {}
      }
    }
    return full;
  }

  // Aus rohem HTML-Text (für fetch-Fallback nach SPA-Navigation)
  function flightFromHtml(html) {
    let full = '';
    const re = /__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
    let m;
    while ((m = re.exec(html))) {
      try {
        full += JSON.parse(m[1]);
      } catch (e) {}
    }
    return full;
  }

  // Tagesdaten besorgen: erst inline, sonst per fetch der aktuellen Seite (gecacht)
  let DATA = null;
  let loading = false;
  async function ensureData() {
    if (DATA) return DATA;

    const inline = extractInitialData(flightFromDocument());
    if (inline && inline.groups) {
      DATA = inline;
      return DATA;
    }

    if (loading) return null;
    loading = true;
    try {
      const html = await fetch(location.href, {
        credentials: 'same-origin',
      }).then((r) => r.text());
      const fetched = extractInitialData(flightFromHtml(html));
      if (fetched && fetched.groups) DATA = fetched;
    } catch (e) {
      console.error('[GC] Nachladen der Seitendaten fehlgeschlagen', e);
    } finally {
      loading = false;
    }
    return DATA;
  }

  function pickItems(group) {
    const byType = (t) => group.items.find((it) => it.type === t);
    return {
      country:
        group.items.find((it) => it.categoryKey === 'country') ||
        byType('text'),
      flag: byType('flag'),
      shape: byType('shape'),
      stat: group.items.find(
        (it) => !['flag', 'country', 'shape'].includes(it.categoryKey),
      ),
    };
  }

  function statCaption(group, meta) {
    const { stat } = pickItems(group);
    const sk = stat ? stat.categoryKey : null;
    return (stat && stat.caption) || (sk && meta[sk] && meta[sk].label) || '';
  }

  // KI-Prompt-Box mit Copy- und ChatGPT-Button
  function buildPromptBox(prompt) {
    const box = el(
      'div',
      'bg-card border-2 border-border rounded-xl shadow-neo p-3 mt-1',
    );

    const top = el('div', 'flex items-center justify-between gap-2 mb-2');
    top.appendChild(
      el(
        'span',
        'font-sans font-bold text-xs sm:text-sm text-muted-foreground',
        'KI-Prompt',
      ),
    );

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-transparent hover:bg-secondary text-foreground transition-colors';
    btn.setAttribute('aria-label', 'Prompt kopieren');
    btn.innerHTML = COPY_ICON;

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className =
      'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-transparent hover:bg-secondary text-foreground transition-colors';
    openBtn.title = 'In ChatGPT öffnen';
    openBtn.setAttribute('aria-label', 'In ChatGPT öffnen');
    openBtn.innerHTML = OPEN_ICON;
    openBtn.addEventListener('click', () => {
      window.open(CHATGPT_URL(prompt), '_blank', 'noopener');
    });

    const actions = el('div', 'flex items-center gap-1 shrink-0');
    actions.append(openBtn, btn);
    top.appendChild(actions);

    const body = el(
      'div',
      'gc-prompt font-sans text-xs leading-snug break-words text-foreground',
    );
    body.textContent = prompt;

    let resetT = null;
    btn.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(prompt);
        ok = true;
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = prompt;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }
      btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
      btn.style.color = ok ? '#22c55e' : '';
      clearTimeout(resetT);
      resetT = setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.style.color = '';
      }, 1500);
    });

    box.append(top, body);
    return box;
  }

  function buildPrompt(groups, meta) {
    const countries = groups.map((g) =>
      regionName((g.title || '').toUpperCase()),
    );
    const cats = groups.map((g) => {
      const cap = statCaption(g, meta);
      return CATEGORY_PROMPT_MAP[cap] || cap;
    });
    const pairs = groups.map((g, i) => {
      const { stat } = pickItems(g);
      const value = stat ? stat.value : '';
      return countries[i] + '/' + cats[i] + ' (' + value + ')';
    });
    return (
      'Erstelle mir bitte ausschließlich eine Tabelle ohne Zusatzanmerkungen mit den folgenden vier Ländern ' +
      '(zeilenweise mit passendem Flaggen-Emoji) und den folgenden vier Kategorien (Spalten): ' +
      countries.join(', ') +
      ' & ' +
      cats.join(', ') +
      '. ' +
      'Recherchiere die korrekten Werte für jede Zelle. ' +
      'Hebe die folgenden Zellen hervor mit einem 🟩 und gefettet, die Werte in Klammern sollen zusätzlich neben den recherchierten Werten geklammert angezeigt werden: ' +
      pairs.join(', ') +
      '.'
    );
  }

  function buildBlock(data) {
    const wrap = el('div', 'w-full max-w-[27rem] mx-auto flex flex-col shrink-0 mb-8');
    wrap.id = BLOCK_ID;

    const meta = data.categoryMeta || {};
    // Prompt alphabetisch nach Ländern, unabhängig von der Lösungsreihenfolge
    const groups = [...data.groups].sort((a, b) =>
      regionName((a.title || '').toUpperCase()).localeCompare(
        regionName((b.title || '').toUpperCase()),
        'de',
      ),
    );

    wrap.appendChild(buildPromptBox(buildPrompt(groups, meta)));
    return wrap;
  }

  // ---- Hängepunkt: gemeinsamer Ergebnis-Screen der Daily-Spiele ----
  // Seit dem Umbau (Sept. 2026) gibt es keine Überschrift "Lösung" mehr; das
  // Spielende steht in `.daily-result-screen`: fixe Viewport-Höhe, darin ein
  // scrollender Bereich (overflow-y: auto) mit der zentrierten Ergebnis-Spalte
  // (Gruppen gelöst/Platz, Lösungs-Blätterer "1 / 4", "Tippen zum Fortfahren").
  // Die KI-Box hängen wir unten an diese Spalte (wie Geodle+). Den Scrollbereich
  // finden wir über den berechneten Style statt über Tailwind-Klassen.
  function findColumn() {
    const screen = document.querySelector('.daily-result-screen');
    if (!screen) return null; // Spiel läuft noch
    const scroll = [...screen.children].find(
      (e) => getComputedStyle(e).overflowY === 'auto',
    );
    const column = scroll && scroll.firstElementChild;
    return column ? { scroll, column } : null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = el('style');
    st.id = STYLE_ID;
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  // ---- Blätterer "‹ 1 / 4 ›" aufklappen (wie GeoRankle+) ----
  // Der Blätterer ist ein Rahmen (overflow-hidden + touch-pan-y) mit einem
  // Track, der ALLE Lösungsboxen nebeneinander enthält (style="width: 400%")
  // und per transform verschoben wird. Statt DOM umzubauen, markieren wir
  // Track, Navigation und die höhenbegrenzten Vorfahren mit eigenen Klassen
  // und kippen den Track per CSS in eine Spalte; React verwaltet das DOM weiter.
  // Länder-Überschrift einer Lösungsbox ("Ägypten") – doppelt zur Kachel
  // "Land: Ägypten". Bevorzugt ein h1–h6; sonst durch Einzel-Wrapper nach
  // unten gehen und das erste Kind nehmen, wenn es reiner Text ohne Bild
  // und ohne "Kategorie: Wert"-Doppelpunkt ist.
  function slideHeading(slide) {
    const h = slide.querySelector('h1,h2,h3,h4,h5,h6');
    if (h) return h;
    let node = slide;
    while (node.children.length === 1) node = node.firstElementChild;
    const first = node.firstElementChild;
    if (
      first &&
      node.children.length > 1 &&
      !first.querySelector('img,svg') &&
      !first.textContent.includes(':')
    )
      return first;
    return null;
  }

  function stackSolutions(target) {
    const tracks = [
      ...target.column.querySelectorAll(
        'div.overflow-hidden.touch-pan-y > div[style*="width"]',
      ),
    ].filter((t) => t.children.length > 0);
    for (const track of tracks) {
      track.classList.add(TRACK_CLASS);
      // Nicht aktuelle Boxen sind inert – jetzt alle sichtbar, also freigeben.
      for (const slide of track.children) {
        slide.removeAttribute('inert');
        const head = slideHeading(slide);
        if (head) head.classList.add(HEAD_CLASS);
      }
      // "‹ 1 / 4 ›" direkt unter dem Rahmen
      const nav = track.parentElement.nextElementSibling;
      if (nav && nav.querySelectorAll('button').length === 2)
        nav.classList.add(NAV_CLASS);
      // Liegt der Blätterer in einer gerade verborgenen Ansicht
      // (aria-hidden), Höhe nicht aufheben – sonst bliebe ein Loch.
      const visible = !track.closest('[aria-hidden="true"]');
      for (
        let e = track.parentElement;
        e && e !== target.column && e !== target.scroll;
        e = e.parentElement
      ) {
        e.classList.toggle(UNCLIP_CLASS, visible);
      }
    }
  }

  function insertBlock(data, target) {
    if (document.getElementById(BLOCK_ID)) return;
    if (!data || !data.groups) return;
    const block = buildBlock(data);
    block.style.marginTop = '1rem';
    target.column.appendChild(block);
    console.log('[GC] KI-Prompt-Box eingefügt.');
  }

  function tick() {
    if (!location.pathname.includes('geoconnections')) return; // nur auf der GeoConnections-Seite
    const target = findColumn();
    if (!target) return; // noch nicht gelöst -> nichts tun (kein Nachladen)
    ensureStyle();
    stackSolutions(target);
    // Die Seite blockiert auf dem Desktop das Mausrad außerhalb von
    // [data-allow-wheel] – ohne das Attribut wäre unten nichts erreichbar.
    target.scroll.setAttribute('data-allow-wheel', 'true');
    if (document.getElementById(BLOCK_ID)) return;
    ensureData()
      .then((data) => {
        const t = findColumn();
        if (data && t) insertBlock(data, t);
      })
      .catch((e) => console.error('[GC] tick-Fehler', e));
  }

  function safeTick() {
    try {
      tick();
    } catch (e) {
      console.error('[GC] tick-Fehler', e);
    }
  }

  // Intervall ZUERST aufsetzen, damit ein früher Fehler die Retry-Schleife nicht verhindert.
  const iv = setInterval(safeTick, 500);
  window.addEventListener('load', safeTick);
  document.addEventListener('DOMContentLoaded', safeTick);
  window.addEventListener('beforeunload', () => clearInterval(iv));
  safeTick();
})();
