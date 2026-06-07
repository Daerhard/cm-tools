window.CMCore = (function () {
  'use strict';

  // ============================================================
  // KONFIGURATION
  // ============================================================

  const USERNAME = 'DaerhardMerhard';

  const THROTTLE_MIN_MS = 200;
  const THROTTLE_MAX_MS = 450;

  const RULES = {
    'Common':         { deduction: 0.01, minimum: 0.10 },
    'Super Rare':     { deduction: 0.01, minimum: 0.23 },
    'Ultra Rare':     { deduction: 0.01, minimum: 0.48 },
    'Secret Rare':    { deduction: 0.05, minimum: 0.98 },
    'Starlight Rare': { deduction: 1.00, minimum: null  },
  };

  const DEFAULT_AMOUNT       = 1;
  const DEFAULT_LANGUAGE     = 3;
  const DEFAULT_FIRST_ED     = true;
  const DEFAULT_CONDITION_ID = '2';
  const STARLIGHT_FALLBACK   = 1.00;

  // ============================================================
  // HELPERS
  // ============================================================

  function parseGermanFloat(s) {
    if (!s) return NaN;
    const m = String(s).match(/(\d[\d.]*,\d+|\d+)/);
    if (!m) return NaN;
    return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  }

  function fmtEur(n) {
    return n.toFixed(2).replace('.', ',');
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function throttle() {
    const span = THROTTLE_MAX_MS - THROTTLE_MIN_MS;
    return sleep(THROTTLE_MIN_MS + Math.floor(Math.random() * span));
  }

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

  function writeLog(el, msg, isErr, prefix) {
    if (!el) { console.log(`[${prefix}]`, msg); return; }
    const div = document.createElement('div');
    if (isErr) div.className = 'err';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    console.log(`[${prefix}]`, msg);
  }

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

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  // ============================================================
  // SHARED SCRAPING
  // ============================================================

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
          row.id.match(/(?:articleRow|stockRow)(\d+)/)?.[1] ||
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
          'input[name="amount"], input.article-amount, input[data-amount], input[name*="amount" i]'
        );
        const rawAmt = amountInput ? parseInt(amountInput.value, 10) : NaN;
        const amount = Number.isFinite(rawAmt) && rawAmt >= 1 ? rawAmt : 1;

        const commentEl = row.querySelector(
          'textarea[name="comments"], input[name="comments"], ' +
          '.product-comments, [class*="product-comments"], .article-comment'
        );
        const comment = (commentEl?.value ?? commentEl?.textContent ?? '').trim();

        const rarityEl = row.querySelector('svg[aria-label], [aria-label*="Rare"], [aria-label*="Common"]');
        const rarity = rarityEl?.getAttribute('aria-label')?.trim() ?? '';

        seenIds.add(articleId);
        listings.push({
          articleId,
          cardName:     nameLink.textContent.trim(),
          cardUrl:      new URL(nameLink.getAttribute('href'), location.origin).toString(),
          currentPrice,
          amount,
          comment,
          rarity,
        });
        added++;
      });

      if (rows.length < 20 && added < 20) break;
      page++;
    }

    return listings;
  }

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

  // ============================================================
  // PAGE STATE
  // ============================================================

  const pageUrl     = window.location.href;
  const urlObj      = new URL(pageUrl);
  const idExpansion = urlObj.searchParams.get('idExpansion');
  const idRarity    = urlObj.searchParams.get('idRarity');

  const version = (typeof GM_info !== 'undefined' ? GM_info.script.version : '?');
  console.log(`[CMTools] v${version} geladen. idExpansion=${idExpansion ?? '(none)'} idRarity=${idRarity ?? '(none)'}`);

  let setName = idExpansion ? `Set ${idExpansion}` : '–';
  const expansionFilter = document.querySelector('select[name="idExpansion"]');
  if (expansionFilter && idExpansion) {
    const opt = expansionFilter.querySelector(`option[value="${idExpansion}"]`);
    if (opt) setName = opt.textContent.trim();
  }

  let setSlug = null;
  const sampleLink = document.querySelector('a[href*="/Products/Singles/"]');
  if (sampleLink) {
    const m = sampleLink.getAttribute('href').match(/\/Products\/Singles\/([^\/?]+)/);
    if (m) setSlug = m[1];
  }

  let rarityName = null;
  const rarityFilter = document.querySelector('select[name="idRarity"]');
  if (rarityFilter && idRarity) {
    const opt = rarityFilter.querySelector(`option[value="${idRarity}"]`);
    if (opt) rarityName = opt.textContent.trim();
  }

  const rule          = rarityName ? RULES[rarityName] : null;
  const ready         = !!(idExpansion && idRarity && rule);
  const repricerReady = true;
  const rarityDisplay = rarityName || (idRarity ? `Rarity ${idRarity}` : '–');

  // ============================================================
  // PANEL SHELL
  // ============================================================

  const panel = document.createElement('div');
  panel.id = 'cmtools-panel';
  panel.innerHTML = `
    <style>
      #cmtools-panel {
        position: fixed; top: 80px; right: 20px;
        width: 480px; max-height: calc(100vh - 100px);
        background: #fff; border: 2px solid #1F3864;
        border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.25);
        font-family: Arial, sans-serif; font-size: 13px; color: #222;
        z-index: 99999; display: flex; flex-direction: column;
      }
      #cmtools-panel header {
        background: #1F3864; color: #fff; padding: 10px 14px;
        font-weight: bold; border-radius: 6px 6px 0 0;
        display: flex; justify-content: space-between; align-items: center;
        flex-shrink: 0;
      }
      #cmtools-panel header button.close {
        background: transparent; border: none; color: #fff;
        font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1;
      }
      #cmtools-panel .tabs {
        display: flex; flex-shrink: 0;
        background: #F5F5F5; border-bottom: 2px solid #1F3864;
      }
      #cmtools-panel .tab {
        flex: 1; padding: 9px 12px; background: transparent; border: none;
        border-right: 1px solid #ddd; cursor: pointer;
        font-size: 13px; font-weight: bold; color: #555;
      }
      #cmtools-panel .tab:last-child { border-right: none; }
      #cmtools-panel .tab.active     { background: #fff; color: #1F3864; }
      #cmtools-panel .tab:hover:not(.active) { background: #EEE; }
      #cmtools-panel .tab-content         { display: none; padding: 12px 14px; overflow-y: auto; }
      #cmtools-panel .tab-content.active  { display: block; }
      #cmtools-panel .info { margin-bottom: 10px; line-height: 1.6; }
      #cmtools-panel .info .key { color: #777; display: inline-block; width: 60px; }
      #cmtools-panel .rule-box {
        background: #F2F6FB; padding: 8px 10px; border-radius: 4px;
        margin-bottom: 10px; font-size: 12px; line-height: 1.5;
      }
      #cmtools-panel button.action {
        display: block; width: 100%; padding: 8px; margin-top: 6px;
        background: #1F3864; color: #fff; border: none; border-radius: 4px;
        cursor: pointer; font-weight: bold; font-size: 13px;
      }
      #cmtools-panel button.action:hover:not(:disabled) { background: #2E4F8B; }
      #cmtools-panel button.action:disabled { background: #aaa; cursor: not-allowed; }
      #cmtools-panel button.action.apply  { background: #B71C1C; }
      #cmtools-panel button.action.apply:hover:not(:disabled) { background: #D32F2F; }
      #cmtools-panel button.action.create { background: #2E7D32; }
      #cmtools-panel button.action.create:hover:not(:disabled) { background: #388E3C; }
      #cmtools-panel button.action.export { background: #555; }
      #cmtools-panel .preview {
        margin-top: 10px; max-height: 340px; overflow-y: auto;
      }
      #cmtools-panel table { width: 100%; border-collapse: collapse; font-size: 11px; }
      #cmtools-panel th, #cmtools-panel td {
        padding: 4px 6px; border-bottom: 1px solid #eee;
        text-align: left; vertical-align: middle;
      }
      #cmtools-panel th { background: #f5f5f5; position: sticky; top: 0; z-index: 1; }
      #cmtools-panel td.num { text-align: right; font-variant-numeric: tabular-nums; }
      #cmtools-panel td.cb, #cmtools-panel th.cb { width: 26px; text-align: center; }
      #cmtools-panel input.row-cb, #cmtools-panel input.master-cb { cursor: pointer; }
      #cmtools-panel input.row-cb:disabled { cursor: not-allowed; opacity: .35; }
      #cmtools-panel .change-up    { color: #2E7D32; }
      #cmtools-panel .change-down  { color: #1565C0; }
      #cmtools-panel .change-floor { color: #ED6C02; font-style: italic; }
      #cmtools-panel .change-skip  { color: #888; }
      #cmtools-panel .change-error { color: #C62828; font-style: italic; }
      #cmtools-panel input.cell-input {
        width: 100%; padding: 2px 4px; border: 1px solid #ccc;
        border-radius: 3px; font-size: 11px; box-sizing: border-box;
      }
      #cmtools-panel input.cell-price  { width: 60px; }
      #cmtools-panel input.cell-amount { width: 40px; }
      #cmtools-panel select.cell-input { width: 70px; padding: 2px; font-size: 11px; }
      #cmtools-panel .bulk-bar {
        background: #FAFAFA; padding: 8px; border: 1px solid #eee;
        border-radius: 4px; margin: 8px 0;
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px;
      }
      #cmtools-panel .bulk-bar label { color: #555; }
      #cmtools-panel .bulk-bar input, #cmtools-panel .bulk-bar select {
        padding: 2px 4px; font-size: 11px; border: 1px solid #ccc; border-radius: 3px;
      }
      #cmtools-panel .bulk-bar button {
        padding: 3px 8px; font-size: 11px;
        border: 1px solid #1F3864; background: #fff;
        color: #1F3864; border-radius: 3px; cursor: pointer;
      }
      #cmtools-panel .log {
        margin-top: 8px; padding: 6px 8px; background: #FAFAFA;
        font-family: ui-monospace, monospace; font-size: 11px;
        max-height: 110px; overflow-y: auto;
        border: 1px solid #eee; border-radius: 4px; line-height: 1.4;
      }
      #cmtools-panel .log .err { color: #C62828; }
      #cmtools-panel .summary {
        background: #F2F6FB; border: 1px solid #C5D8F0; border-radius: 4px;
        padding: 8px 10px; font-size: 12px; line-height: 1.7;
      }
      #cmtools-panel .summary-row { display: flex; justify-content: space-between; }
      #cmtools-panel .summary-row span { color: #555; }
      #cmtools-panel .summary-row strong { font-variant-numeric: tabular-nums; }
      #cmtools-panel .summary hr { border: none; border-top: 1px solid #C5D8F0; margin: 4px 0; }
      #cmtools-panel .delta-pos { color: #2E7D32; }
      #cmtools-panel .delta-neg { color: #1565C0; }
      #cmtools-panel tr.row-greyed td { color: #bbb; font-style: italic; }
      #cmtools-panel .greyed-included tr.row-greyed td { color: inherit; font-style: normal; background: #FFFDE7; }
    </style>
    <header>
      <span>Cardmarket Tools</span>
      <button class="close" title="Schließen">×</button>
    </header>
    <nav class="tabs">
      <button class="tab active" data-tab="repricer">Repricer</button>
      <button class="tab"        data-tab="stockfiller">Stock Filler</button>
    </nav>
    <div class="tab-content tab-repricer active"></div>
    <div class="tab-content tab-stockfiller"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      panel.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      panel.querySelectorAll('.tab-content').forEach(c =>
        c.classList.toggle('active', c.classList.contains('tab-' + target))
      );
    });
  });
  panel.querySelector('header .close').onclick = () => panel.remove();

  // ============================================================
  // PUBLIC API
  // ============================================================
  return {
    USERNAME, RULES,
    DEFAULT_AMOUNT, DEFAULT_LANGUAGE, DEFAULT_FIRST_ED, DEFAULT_CONDITION_ID, STARLIGHT_FALLBACK,
    parseGermanFloat, fmtEur, round2, throttle,
    assertNotChallenge, escapeHtml, languageLabel, downloadCsv, writeLog, todayIso,
    scrapeMyListings, fetchCheapestCommercial,
    pageUrl, idExpansion, idRarity, setName, setSlug, rarityName, rule, ready, repricerReady, rarityDisplay,
    panel,
  };
})();
