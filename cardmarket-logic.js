/**
 * Cardmarket Tools – Logik-Modul
 *
 * Wird via @require in das Haupt-Skript eingebunden.
 * Exponiert alle Konstanten, Scraping-Funktionen und Helpers
 * als window.CMTools = { ... }.
 *
 * Keine UI-Abhängigkeiten – kein document.createElement, kein Panel.
 */
window.CMTools = (function () {
  'use strict';

  // ============================================================
  // KONFIGURATION
  // ============================================================

  const USERNAME = 'DaerhardMerhard';

  const THROTTLE_MIN_MS = 350;
  const THROTTLE_MAX_MS = 850;

  /** Preisregeln pro Rarity. Rare fehlt absichtlich → wird ignoriert. */
  const RULES = {
    'Common':         { deduction: 0.01, minimum: 0.10 },
    'Super Rare':     { deduction: 0.01, minimum: 0.23 },
    'Ultra Rare':     { deduction: 0.01, minimum: 0.48 },
    'Secret Rare':    { deduction: 0.05, minimum: 0.98 },
    'Starlight Rare': { deduction: 1.00, minimum: null  },
  };

  const DEFAULT_AMOUNT       = 1;
  const DEFAULT_LANGUAGE     = 3;     // 3 = Deutsch
  const DEFAULT_FIRST_ED     = true;
  const DEFAULT_CONDITION_ID = '2';   // 2 = Near Mint
  const STARLIGHT_FALLBACK   = 1.00;

  // ============================================================
  // ALLGEMEINE HELPERS
  // ============================================================

  /** Wandelt deutsche Preisstrings ("1,23 €") in Float um. */
  function parseGermanFloat(s) {
    if (!s) return NaN;
    const m = String(s).match(/(\d[\d.]*,\d+|\d+)/);
    if (!m) return NaN;
    return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  }

  /** Zahl auf 2 Nachkommastellen mit Komma formatieren (z. B. "1,23"). */
  function fmtEur(n) {
    return n.toFixed(2).replace('.', ',');
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Zufällige Pause zwischen THROTTLE_MIN_MS und THROTTLE_MAX_MS. */
  function throttle() {
    const span = THROTTLE_MAX_MS - THROTTLE_MIN_MS;
    return sleep(THROTTLE_MIN_MS + Math.floor(Math.random() * span));
  }

  /** Wirft einen Fehler, wenn die Antwort eine Cloudflare-Challenge enthält. */
  function assertNotChallenge(html, context) {
    if (/Just a moment|Checking your browser|cf-browser-verification|cf-challenge|_cf_chl_opt|cf-mitigated/i.test(html)) {
      throw new Error(
        `Cloudflare-Challenge bei "${context}" — bitte Cardmarket im Browser laden, ` +
        `Captcha bestätigen, dann neu starten.`
      );
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function languageLabel(id) {
    return ({ 1: 'EN', 2: 'FR', 3: 'DE', 4: 'ES', 5: 'IT', 7: 'JP' })[id] || `id=${id}`;
  }

  /**
   * Schreibt eine Log-Zeile in ein DOM-Element.
   * Fällt auf console.log zurück wenn el null ist.
   */
  function writeLog(el, msg, isErr, prefix) {
    if (!el) { console.log(`[${prefix}]`, msg); return; }
    const div = document.createElement('div');
    if (isErr) div.className = 'err';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    console.log(`[${prefix}]`, msg);
  }

  /** Erzeugt und triggert einen CSV-Download. */
  function downloadCsv(rows, filename) {
    const csv = rows
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  // ============================================================
  // REPRICER LOGIK
  // ============================================================

  /**
   * Berechnet den neuen Preis für ein Listing.
   * @param {object} listing   - { currentPrice }
   * @param {object|null} comp - { price, seller } oder null
   * @param {object} rule      - { deduction, minimum }
   * @returns {{ price: number, action: string }}
   */
  function computeNewPrice(listing, comp, rule) {
    if (!comp) return { price: listing.currentPrice, action: 'skip-no-competitor' };

    let target = round2(comp.price - rule.deduction);

    if (rule.minimum !== null && target < rule.minimum) {
      const floored = round2(rule.minimum);
      if (floored === listing.currentPrice) return { price: floored, action: 'skip-no-change' };
      return { price: floored, action: 'floor' };
    }

    if (target === listing.currentPrice) return { price: target, action: 'skip-no-change' };
    return { price: target, action: 'reprice' };
  }

  // ============================================================
  // SCRAPING
  // ============================================================

  /**
   * Liest alle eigenen Listings von der aktuellen Stock-Seite
   * (inkl. Pagination).
   *
   * @param {string}   baseUrl - window.location.href der Stock-Seite
   * @param {function} logFn   - (msg, isErr?) => void
   * @returns {Promise<Array<{articleId, cardName, cardUrl, currentPrice, amount}>>}
   */
  async function scrapeMyListings(baseUrl, logFn) {
    const log = logFn ?? (() => {});
    const listings = [];
    const seenIds  = new Set();
    const base     = new URL(baseUrl);
    let page       = 1;
    const MAX_PAGES = 50;

    while (page <= MAX_PAGES) {
      let doc;
      if (page === 1) {
        doc = document;
      } else {
        await throttle();
        const pageUrl = new URL(base.toString());
        pageUrl.searchParams.set('site', String(page));
        log(`  Lade Seite ${page} …`);
        const res = await fetch(pageUrl.toString(), { credentials: 'include' });
        if (!res.ok) break;
        const html = await res.text();
        assertNotChallenge(html, `Stock-Seite ${page}`);
        doc = new DOMParser().parseFromString(html, 'text/html');
      }

      let rows = doc.querySelectorAll('.article-row');
      if (rows.length === 0) rows = doc.querySelectorAll('[id^="articleRow"]');
      if (rows.length === 0) rows = doc.querySelectorAll('[data-article-id]');

      if (rows.length === 0) {
        if (page === 1) {
          const sampleIds = [...doc.querySelectorAll('[id]')]
            .slice(0, 8).map(el => `${el.tagName.toLowerCase()}#${el.id}`).join(', ');
          const sampleClasses = [...doc.querySelectorAll('[class]')]
            .slice(0, 5).map(el => el.className.split(' ')[0]).join(', ');
          log(`  Keine Zeilen gefunden. Erste IDs: ${sampleIds || '–'}`, true);
          log(`  Erste Klassen: ${sampleClasses || '–'}`, true);
        }
        break;
      }

      let added = 0;

      rows.forEach(row => {
        const articleId =
          row.id.match(/articleRow(\d+)/)?.[1] ||
          row.dataset.articleId ||
          row.getAttribute('data-article-id') ||
          row.querySelector('[data-article-id]')?.dataset.articleId;
        if (!articleId || seenIds.has(articleId)) return;

        const nameLink = row.querySelector('a[href*="/Products/Singles/"]');
        if (!nameLink) return;

        const priceEl = row.querySelector(
          '.price-container .color-primary, ' +
          '.mobile-offer-container .color-primary, ' +
          '.color-primary.fw-bold, ' +
          '[class*="price"] .color-primary, ' +
          '[class*="Price"] .color-primary'
        );
        const currentPrice = parseGermanFloat(priceEl?.textContent ?? '');
        if (isNaN(currentPrice)) {
          log(`  Kein Preis gefunden für articleId=${articleId} (${nameLink.textContent.trim().slice(0, 30)})`, true);
          return;
        }

        const amountInput = row.querySelector(
          'input[name="amount"], input.article-amount, input[data-amount], input[name*="amount"]'
        );
        const rawAmt = amountInput ? parseInt(amountInput.value, 10) : NaN;
        const amount = Number.isFinite(rawAmt) && rawAmt >= 1 ? rawAmt : 1;

        seenIds.add(articleId);
        listings.push({
          articleId,
          cardName:     nameLink.textContent.trim(),
          cardUrl:      new URL(nameLink.getAttribute('href'), location.origin).toString(),
          currentPrice,
          amount,
        });
        added++;
      });

      if (rows.length < 20 && added < 20) break;
      page++;
    }

    return listings;
  }

  /**
   * Ruft die Karten-Seite ab und gibt den günstigsten
   * gewerblichen Anbieter (ohne eigenen Account) zurück.
   *
   * @param {{ cardUrl: string, cardName: string }} item
   * @returns {Promise<{ seller: string, price: number }|null>}
   */
  async function fetchCheapestCommercial(item) {
    const u = new URL(item.cardUrl);
    if (!u.searchParams.has('sellerCountry')) u.searchParams.set('sellerCountry', '7');
    if (!u.searchParams.has('language'))      u.searchParams.set('language', String(DEFAULT_LANGUAGE));
    if (!u.searchParams.has('amount'))        u.searchParams.set('amount', '1');

    const res = await fetch(u.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} bei ${item.cardName}`);

    const html = await res.text();
    assertNotChallenge(html, `Anbieter-Seite ${item.cardName}`);

    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const rows = doc.querySelectorAll('.article-row');
    const candidates = [];

    for (const row of rows) {
      const sellerLink = row.querySelector('a[href*="/Users/"]');
      if (!sellerLink) continue;
      const seller = sellerLink.textContent.trim();
      if (!seller || seller === USERNAME) continue;

      const isCommercial = !!row.querySelector(
        '[class*="fonticon-users-professional"], ' +
        '[class*="fonticon-users-powerseller"], ' +
        '[class*="fonticon-users-business"]'
      );
      if (!isCommercial) continue;

      const priceEl = row.querySelector('.color-primary.fw-bold');
      const price   = parseGermanFloat(priceEl?.textContent ?? '');
      if (isNaN(price)) continue;

      candidates.push({ seller, price });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.price - b.price);
    return candidates[0];
  }

  /**
   * Liest alle Karten eines Sets + Rarity von den Produkt-Seiten.
   *
   * @param {string}   setSlug  - URL-Slug des Sets, z. B. "Phantom-Nightmare"
   * @param {string}   idRarity - Rarity-ID aus dem URL-Parameter
   * @param {function} logFn
   * @returns {Promise<Array<{ cardName: string, cardUrl: string }>>}
   */
  async function scrapeAllCards(setSlug, idRarity, logFn) {
    const log = logFn ?? (() => {});
    if (!setSlug) throw new Error(
      'Set-Slug nicht bekannt. Mindestens eine eigene Karte des Sets muss in der Liste sein.'
    );

    const cards    = [];
    const seen     = new Set();
    let page       = 1;
    const MAX_PAGES = 20;

    while (page <= MAX_PAGES) {
      if (page > 1) await throttle();

      const u = new URL(`/de/YuGiOh/Products/Singles/${setSlug}`, location.origin);
      u.searchParams.set('idRarity',  idRarity);
      u.searchParams.set('mode',      'list');
      u.searchParams.set('perSite',   '50');
      u.searchParams.set('site',      String(page));

      const res = await fetch(u.toString(), { credentials: 'include' });
      if (!res.ok) break;

      const html = await res.text();
      assertNotChallenge(html, `Set-Liste Seite ${page}`);

      const doc   = new DOMParser().parseFromString(html, 'text/html');
      const links = doc.querySelectorAll(`a[href*="/Products/Singles/${setSlug}/"]`);
      let added   = 0;

      links.forEach(a => {
        const href = a.getAttribute('href');
        if (!href) return;
        const path = href.split('?')[0];
        if (seen.has(path)) return;
        const name = a.textContent.trim();
        if (!name) return;
        seen.add(path);
        cards.push({ cardName: name, cardUrl: new URL(href, location.origin).toString() });
        added++;
      });

      if (added === 0) break;
      page++;
    }

    return cards;
  }

  // ============================================================
  // API-CALLS (Schreibend)
  // ============================================================

  /**
   * Aktualisiert den Preis eines eigenen Listings über das Edit-Modal.
   *
   * @param {string} articleId
   * @param {number} newPrice
   */
  async function updatePrice(articleId, newPrice) {
    const modalUrl = `/de/YuGiOh/Modal/Article_EditArticleModal?showUserOffersRow=1&idArticle=${encodeURIComponent(articleId)}`;
    const modalRes = await fetch(modalUrl, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!modalRes.ok) throw new Error(`Edit-Modal HTTP ${modalRes.status}`);

    const modalHtml = await modalRes.text();
    assertNotChallenge(modalHtml, `Edit-Modal ${articleId}`);

    const modalDoc = new DOMParser().parseFromString(modalHtml, 'text/html');
    const params   = new URLSearchParams();

    modalDoc.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
      const name = el.getAttribute('name');
      if (!name) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) params.set(name, el.value || 'on');
        return;
      }
      params.set(name, el.value ?? '');
    });

    if (!params.has('idArticle')) throw new Error('idArticle nicht im Modal');
    if (!params.has('__cmtkn'))  throw new Error('CSRF-Token (__cmtkn) nicht gefunden');

    params.set('price', fmtEur(newPrice));

    const res = await fetch('/de/YuGiOh/AjaxAction/Article_EditSingleArticle', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type':      'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With':  'XMLHttpRequest',
        'Accept':            'application/json, text/html, */*',
      },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Update HTTP ${res.status}`);

    const text = await res.text();
    assertNotChallenge(text, `Update ${articleId}`);

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json && json.success === false) {
        throw new Error(`Cardmarket meldete Fehler: ${json.message || text.slice(0, 200)}`);
      }
    }
  }

  /**
   * Erstellt ein neues Listing für eine fehlende Karte.
   *
   * @param {{ cardUrl, cardName, amount, language, firstEd, price }} row
   */
  async function createListing(row) {
    const cardRes = await fetch(row.cardUrl, { credentials: 'include' });
    if (!cardRes.ok) throw new Error(`Card-Page HTTP ${cardRes.status}`);

    const cardHtml = await cardRes.text();
    assertNotChallenge(cardHtml, `Single-Card ${row.cardName}`);

    const idMatch =
      cardHtml.match(/name=["']idAddProduct["'][^>]*\bvalue=["'](\d+)["']/i) ||
      cardHtml.match(/\bvalue=["'](\d+)["'][^>]*\bname=["']idAddProduct["']/i);
    if (!idMatch) throw new Error('idAddProduct nicht in Single-Card-Page gefunden');

    const tokenMatch =
      cardHtml.match(/name=["']__cmtkn["'][^>]*\bvalue=["']([a-f0-9]+)["']/i) ||
      cardHtml.match(/\bvalue=["']([a-f0-9]{40,})["'][^>]*\bname=["']__cmtkn["']/i);
    if (!tokenMatch) throw new Error('CSRF-Token nicht gefunden');

    const fd = new FormData();
    fd.append('__cmtkn',      tokenMatch[1]);
    fd.append('idAddProduct', idMatch[1]);
    fd.append('amount',       String(row.amount));
    fd.append('idLanguage',   String(row.language));
    fd.append('idCondition',  DEFAULT_CONDITION_ID);
    fd.append('comments',     '');
    fd.append('cardScanFile', new Blob([], { type: 'application/octet-stream' }), '');
    if (row.firstEd) fd.append('isFirstEd', 'X');
    fd.append('price', fmtEur(row.price));

    const res = await fetch('/de/YuGiOh/PostGetAction/Article_ListProduct', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    if (!res.ok) throw new Error(`Insert HTTP ${res.status}`);

    const text = await res.text();
    assertNotChallenge(text, `Insert ${row.cardName}`);

    if (res.url && /\/Login|\/Anmeldung/i.test(res.url)) {
      throw new Error('Cardmarket meldet "nicht eingeloggt"');
    }

    const errMatch = text.match(
      /<div[^>]*class=["'][^"']*alert-danger[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    if (errMatch) {
      const cleaned = errMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned) throw new Error(`Cardmarket-Fehler: ${cleaned.slice(0, 200)}`);
    }
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  return {
    USERNAME,
    RULES,
    DEFAULT_AMOUNT,
    DEFAULT_LANGUAGE,
    DEFAULT_FIRST_ED,
    DEFAULT_CONDITION_ID,
    STARLIGHT_FALLBACK,
    parseGermanFloat,
    fmtEur,
    round2,
    throttle,
    assertNotChallenge,
    escapeHtml,
    languageLabel,
    downloadCsv,
    writeLog,
    computeNewPrice,
    scrapeMyListings,
    fetchCheapestCommercial,
    scrapeAllCards,
    updatePrice,
    createListing,
  };
})();
