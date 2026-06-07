(function () {
  'use strict';

  if (!window.CMTools) {
    console.error('[CMTools] Logik-Modul (window.CMTools) nicht gefunden. Ist @require korrekt?');
    return;
  }

  const {
    USERNAME, RULES,
    DEFAULT_AMOUNT, DEFAULT_LANGUAGE, DEFAULT_FIRST_ED,
    STARLIGHT_FALLBACK,
    parseGermanFloat, fmtEur, round2, throttle,
    escapeHtml, languageLabel, downloadCsv, writeLog,
    computeNewPrice, scrapeMyListings, fetchCheapestCommercial,
    scrapeAllCards, updatePrice, createListing,
  } = window.CMTools;

  // ============================================================
  // INIT – URL & DOM-State
  // ============================================================

  const pageUrl     = window.location.href;
  const urlObj      = new URL(pageUrl);
  const idExpansion = urlObj.searchParams.get('idExpansion');
  const idRarity    = urlObj.searchParams.get('idRarity');

  console.log(`[CMTools] v2 geladen. idExpansion=${idExpansion ?? '(none)'} idRarity=${idRarity ?? '(none)'}`);

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

  const rule         = rarityName ? RULES[rarityName] : null;
  const ready        = !!(idExpansion && idRarity && rule);
  const rarityDisplay = rarityName || (idRarity ? `Rarity ${idRarity}` : '–');

  // ============================================================
  // PANEL AUFBAUEN
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
      #cmtools-panel .summary-row {
        display: flex; justify-content: space-between;
      }
      #cmtools-panel .summary-row span { color: #555; }
      #cmtools-panel .summary-row strong { font-variant-numeric: tabular-nums; }
      #cmtools-panel .summary hr {
        border: none; border-top: 1px solid #C5D8F0; margin: 4px 0;
      }
      #cmtools-panel .delta-pos { color: #2E7D32; }
      #cmtools-panel .delta-neg { color: #1565C0; }
    </style>

    <header>
      <span>Cardmarket Tools</span>
      <button class="close" title="Schließen">×</button>
    </header>

    <nav class="tabs">
      <button class="tab active" data-tab="repricer">Repricer</button>
      <button class="tab"        data-tab="stockfiller">Stock Filler</button>
    </nav>

    <!-- ═══ REPRICER ═══ -->
    <div class="tab-content tab-repricer active">
      <div class="info">
        <div><span class="key">Set:</span>     <strong>${escapeHtml(setName)}</strong></div>
        <div><span class="key">Rarity:</span>  <strong>${escapeHtml(rarityDisplay)}</strong></div>
        <div><span class="key">Account:</span> <strong>${escapeHtml(USERNAME)}</strong>
          <span style="color:#888">(wird ausgefiltert)</span></div>
      </div>
      ${ready ? `
        <div class="rule-box">
          <strong>Regel:</strong> ${fmtEur(rule.deduction)} € unter günstigstem gewerblichen Anbieter
          ${rule.minimum !== null
            ? `, Mindestpreis <strong>${fmtEur(rule.minimum)} €</strong>`
            : ', kein Mindestpreis'}.
        </div>
        <button class="action rep-preview-btn">Vorschau starten</button>
        <button class="action apply  rep-apply-btn"  disabled>Preise anwenden</button>
        <button class="action export rep-export-btn" disabled>Vorschau als CSV</button>
        <div class="preview rep-preview-area"></div>
        <div class="log rep-log"></div>
      ` : `
        <div class="rule-box" style="background:#FFF3E0;border-left:3px solid #ED6C02;">
          <strong>Bitte zuerst Set und unterstützte Rarity links auswählen.</strong><br><br>
          Unterstützte Rarities: Common, Super Rare, Ultra Rare, Secret Rare, Starlight Rare.
        </div>
      `}
    </div>

    <!-- ═══ STOCK FILLER ═══ -->
    <div class="tab-content tab-stockfiller">
      <div class="info">
        <div><span class="key">Set:</span>     <strong>${escapeHtml(setName)}</strong></div>
        <div><span class="key">Rarity:</span>  <strong>${escapeHtml(rarityDisplay)}</strong></div>
        <div><span class="key">Account:</span> <strong>${escapeHtml(USERNAME)}</strong></div>
      </div>
      ${ready ? `
        <div class="rule-box">
          <strong>Defaults:</strong> Menge ${DEFAULT_AMOUNT}, Sprache Deutsch, First Edition aktiv.
          Preis = günstigster gewerblicher − ${fmtEur(rule.deduction)} €,
          Mindestpreis <strong>${fmtEur(rule.minimum ?? STARLIGHT_FALLBACK)} €</strong>.
        </div>
        <button class="action sf-find-btn">Lücken finden</button>
        <div class="sf-bulk-controls" style="display:none">
          <div class="bulk-bar">
            <label>Setze für alle:</label>
            <input type="number" min="1" placeholder="Menge" class="sf-bulk-amount" style="width:60px;">
            <button class="sf-bulk-amount-btn">Menge</button>
            <input type="text" placeholder="Preis €" class="sf-bulk-price" style="width:60px;">
            <button class="sf-bulk-price-btn">Preis</button>
            <select class="sf-bulk-language">
              <option value="">Sprache…</option>
              <option value="3">Deutsch</option>
              <option value="1">Englisch</option>
              <option value="2">Französisch</option>
              <option value="4">Spanisch</option>
              <option value="5">Italienisch</option>
              <option value="7">Japanisch</option>
            </select>
            <button class="sf-bulk-language-btn">Sprache</button>
            <select class="sf-bulk-firsted">
              <option value="">First Ed…</option>
              <option value="1">Ja</option>
              <option value="0">Nein</option>
            </select>
            <button class="sf-bulk-firsted-btn">First Ed</button>
          </div>
          <button class="action create sf-create-btn" disabled>Listings erstellen</button>
          <button class="action export sf-export-btn" disabled>Vorschau als CSV</button>
        </div>
        <div class="preview sf-preview-area"></div>
        <div class="log sf-log"></div>
      ` : `
        <div class="rule-box" style="background:#FFF3E0;border-left:3px solid #ED6C02;">
          <strong>Bitte zuerst Set und unterstützte Rarity links auswählen.</strong>
        </div>
      `}
    </div>
  `;

  document.body.appendChild(panel);

  const $  = sel => panel.querySelector(sel);
  const $$ = sel => panel.querySelectorAll(sel);

  // ============================================================
  // TAB-SWITCHER
  // ============================================================

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
      $$('.tab-content').forEach(c =>
        c.classList.toggle('active', c.classList.contains('tab-' + target))
      );
    });
  });

  $('header .close').onclick = () => panel.remove();

  if (!ready) return;

  // ============================================================
  // REPRICER
  // ============================================================

  const repArea  = $('.rep-preview-area');
  const repLogEl = $('.rep-log');
  const repLog   = (msg, isErr = false) => writeLog(repLogEl, msg, isErr, 'Repricer');

  let repData = [];

  $('.rep-preview-btn').onclick = async () => {
    repLog('Vorschau wird erstellt …');
    repSetBusy(true);
    try {
      const myListings = await scrapeMyListings(pageUrl, repLog);
      repLog(`${myListings.length} eigene Listings gefunden.`);
      if (!myListings.length) {
        repLog('Nichts zu tun. Stelle sicher, dass Listings geladen sind.', true);
        return;
      }

      const byCard = new Map();
      for (const l of myListings) {
        const key = l.cardUrl.split('?')[0];
        if (!byCard.has(key)) byCard.set(key, []);
        byCard.get(key).push(l);
      }
      const lowestIds = new Set();
      for (const group of byCard.values()) {
        group.sort((a, b) => a.currentPrice - b.currentPrice);
        lowestIds.add(group[0].articleId);
      }
      const dupCount = myListings.length - lowestIds.size;
      if (dupCount > 0) repLog(`${dupCount} Duplikat-Listings werden übersprungen.`);

      repData = [];
      let fetched = 0;
      for (let i = 0; i < myListings.length; i++) {
        const listing = myListings[i];
        if (!lowestIds.has(listing.articleId)) {
          repData.push({ ...listing, competitorPrice: null, competitorSeller: null,
                         newPrice: listing.currentPrice, action: 'skip-duplicate' });
          continue;
        }
        repLog(`(${i + 1}/${myListings.length}) ${listing.cardName} …`);
        if (fetched > 0) await throttle();
        fetched++;

        let comp = null;
        try { comp = await fetchCheapestCommercial(listing); }
        catch (err) {
          repLog(`  Fehler: ${err.message}`, true);
          if (/Cloudflare-Challenge/i.test(err.message)) throw err;
        }

        const dec = computeNewPrice(listing, comp, rule);
        repData.push({
          ...listing,
          competitorPrice:  comp?.price  ?? null,
          competitorSeller: comp?.seller ?? null,
          newPrice: dec.price,
          action:   dec.action,
        });
      }

      renderRepPreview(repData);
      $('.rep-apply-btn').disabled  = !repData.some(r => r.action === 'reprice' || r.action === 'floor');
      $('.rep-export-btn').disabled = false;
      repLog('Vorschau abgeschlossen.');
    } catch (err) {
      repLog('FEHLER: ' + err.message, true);
      console.error('[CMTools]', err);
    } finally {
      repSetBusy(false);
    }
  };

  $('.rep-apply-btn').onclick = async () => {
    const toApply = repData.filter(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
    if (!toApply.length) { alert('Keine Listings ausgewählt.'); return; }
    if (!confirm(`${toApply.length} Preise anpassen?`)) return;
    repLog('Anwenden gestartet …');
    repSetBusy(true);
    let ok = 0, fail = 0;
    for (let i = 0; i < toApply.length; i++) {
      const row = toApply[i];
      if (i > 0) await throttle();
      try {
        repLog(`(${i + 1}/${toApply.length}) ${row.cardName} → ${fmtEur(row.newPrice)} €`);
        await updatePrice(row.articleId, row.newPrice);
        ok++;
      } catch (err) {
        fail++;
        repLog(`  Fehler: ${err.message}`, true);
        if (/Cloudflare-Challenge/i.test(err.message)) break;
      }
    }
    repLog(`Fertig: ${ok} angepasst, ${fail} Fehler.`);
    repSetBusy(false);
  };

  $('.rep-export-btn').onclick = () => {
    downloadCsv(
      [
        ['Karte', 'Rarity', 'Menge', 'Alt (€)', 'Konkurrent (€)', 'Konkurrent Verkäufer', 'Neu (€)', 'Aktion'],
        ...repData.map(r => [
          r.cardName, rarityDisplay, r.amount,
          r.currentPrice.toFixed(2),
          r.competitorPrice != null ? r.competitorPrice.toFixed(2) : '',
          r.competitorSeller ?? '',
          r.action.startsWith('skip') ? '' : r.newPrice.toFixed(2),
          r.action,
        ]),
      ],
      `repricer-${setName.replace(/\s+/g, '_')}-${rarityDisplay.replace(/\s+/g, '_')}-${todayIso()}.csv`
    );
  };

  function repSetBusy(busy) {
    $('.rep-preview-btn').disabled = busy;
    if (busy) {
      $('.rep-apply-btn').disabled  = true;
      $('.rep-export-btn').disabled = true;
    }
  }

  function renderRepPreview(data) {
    if (!data.length) { repArea.innerHTML = '<em>Keine Listings.</em>'; return; }

    data.forEach(r => { r.selected = !r.action.startsWith('skip'); });

    const total    = data.length;
    const items    = data.reduce((s, r) => s + (r.amount || 1), 0);
    const curTotal = round2(data.reduce((s, r) => s + r.currentPrice * (r.amount || 1), 0));
    const newTotal = round2(data.reduce((s, r) => s + r.newPrice    * (r.amount || 1), 0));
    const delta    = round2(newTotal - curTotal);
    const deltaStr = (delta >= 0 ? '+' : '') + fmtEur(delta);
    const deltaCls = delta >= 0 ? 'delta-pos' : 'delta-neg';

    const rows = data.map((r, i) => {
      const cls = r.action === 'floor'   ? 'change-floor'
                : r.action === 'reprice' ? (r.newPrice > r.currentPrice ? 'change-up' : 'change-down')
                : 'change-skip';

      const newDisp = r.action.startsWith('skip')
        ? ({ 'skip-no-competitor': '– kein gewerbl.',
             'skip-duplicate':     '– Duplikat',
           }[r.action] ?? '– keine Änderung')
        : fmtEur(r.newPrice) + ' €';

      const compDisp = r.competitorPrice != null ? fmtEur(r.competitorPrice) + ' €' : '–';
      const dStr     = r.action.startsWith('skip') ? ''
        : ((r.newPrice - r.currentPrice >= 0) ? '+' : '') + fmtEur(r.newPrice - r.currentPrice);

      const isSkip = r.action.startsWith('skip');
      return `<tr class="${cls}">
        <td class="cb">
          <input type="checkbox" class="row-cb" data-idx="${i}"
            ${r.selected ? 'checked' : ''} ${isSkip ? 'disabled' : ''}>
        </td>
        <td>${escapeHtml(r.cardName)}</td>
        <td class="num">${r.amount || 1}</td>
        <td class="num">${fmtEur(r.currentPrice)}</td>
        <td class="num">${compDisp}</td>
        <td class="num">${newDisp}</td>
        <td class="num">${dStr}</td>
      </tr>`;
    }).join('');

    repArea.innerHTML = `
      <div class="summary" style="margin-bottom:8px;">
        <div class="summary-row"><span>Listings / Artikel</span><strong>${total} / ${items}</strong></div>
        <hr>
        <div class="summary-row"><span>Aktueller Gesamtwert</span><strong>${fmtEur(curTotal)} €</strong></div>
        <div class="summary-row"><span>Neuer Gesamtwert</span>    <strong>${fmtEur(newTotal)} €</strong></div>
        <div class="summary-row"><span>Differenz</span>           <strong class="${deltaCls}">${deltaStr} €</strong></div>
      </div>
      <table>
        <thead><tr>
          <th class="cb"><input type="checkbox" class="master-cb" checked></th>
          <th>Karte</th><th>Mng</th><th>Alt</th><th>Konk.</th><th>Neu</th><th>Δ</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    wireRepCheckboxes(repArea, data);
  }

  function wireRepCheckboxes(container, data) {
    const master = container.querySelector('.master-cb');
    master.addEventListener('change', () => {
      container.querySelectorAll('.row-cb:not(:disabled)').forEach(cb => {
        cb.checked = master.checked;
        data[+cb.dataset.idx].selected = master.checked;
      });
    });
    container.querySelectorAll('.row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        data[+cb.dataset.idx].selected = cb.checked;
        const enabled = [...container.querySelectorAll('.row-cb:not(:disabled)')];
        const all  = enabled.every(c => c.checked);
        const none = enabled.every(c => !c.checked);
        master.checked = all;
        master.indeterminate = !all && !none;
      });
    });
  }

  // ============================================================
  // STOCK FILLER
  // ============================================================

  const sfArea  = $('.sf-preview-area');
  const sfLogEl = $('.sf-log');
  const sfLog   = (msg, isErr = false) => writeLog(sfLogEl, msg, isErr, 'StockFiller');
  const sfFloor = rule.minimum ?? STARLIGHT_FALLBACK;

  let sfData = [];

  $('.sf-find-btn').onclick = async () => {
    sfLog('Lücken-Suche gestartet …');
    sfSetBusy(true);
    try {
      const myListings  = await scrapeMyListings(pageUrl, sfLog);
      const ownedSlugs  = new Set(myListings.map(l => l.cardUrl.split('?')[0]));
      sfLog(`Eigene Listings: ${myListings.length} (${ownedSlugs.size} Karten).`);

      const allCards = await scrapeAllCards(setSlug, idRarity, sfLog);
      sfLog(`Karten im Set: ${allCards.length}.`);

      const missing = allCards.filter(c => !ownedSlugs.has(c.cardUrl.split('?')[0]));
      sfLog(`Fehlende Karten: ${missing.length}.`);

      if (!missing.length) {
        sfArea.innerHTML = `<div style="padding:12px;background:#E8F5E9;border-radius:4px;color:#2E7D32;">
          <strong>Keine Lücken!</strong> Alle Karten sind bereits gelistet.</div>`;
        return;
      }

      sfData = [];
      for (let i = 0; i < missing.length; i++) {
        const card = missing[i];
        sfLog(`(${i + 1}/${missing.length}) ${card.cardName} …`);
        if (i > 0) await throttle();

        let comp = null;
        try { comp = await fetchCheapestCommercial(card); }
        catch (err) {
          sfLog(`  Fehler: ${err.message}`, true);
          if (/Cloudflare-Challenge/i.test(err.message)) throw err;
        }

        const price = comp ? Math.max(round2(comp.price - rule.deduction), sfFloor) : sfFloor;
        sfData.push({
          ...card,
          competitorPrice:  comp?.price  ?? null,
          competitorSeller: comp?.seller ?? null,
          selected: true,
          amount:   DEFAULT_AMOUNT,
          price,
          language: DEFAULT_LANGUAGE,
          firstEd:  DEFAULT_FIRST_ED,
        });
      }

      renderSfTable(sfData);
      $('.sf-bulk-controls').style.display = 'block';
      $('.sf-create-btn').disabled = false;
      $('.sf-export-btn').disabled = false;
      sfLog('Lücken-Suche abgeschlossen.');
    } catch (err) {
      sfLog('FEHLER: ' + err.message, true);
      console.error('[CMTools]', err);
    } finally {
      sfSetBusy(false);
    }
  };

  $('.sf-create-btn').onclick = async () => {
    const toCreate = sfData.filter(r => r.selected);
    if (!toCreate.length) { alert('Keine Karten ausgewählt.'); return; }
    if (!confirm(`${toCreate.length} Listings erstellen?`)) return;
    sfLog('Erstelle Listings …');
    sfSetBusy(true);
    let ok = 0, fail = 0;
    for (let i = 0; i < toCreate.length; i++) {
      const row = toCreate[i];
      if (i > 0) await throttle();
      try {
        sfLog(`(${i + 1}/${toCreate.length}) ${row.cardName} → ${row.amount}× ${fmtEur(row.price)} €`);
        await createListing(row);
        ok++;
      } catch (err) {
        fail++;
        sfLog(`  Fehler: ${err.message}`, true);
        if (/Cloudflare-Challenge/i.test(err.message)) break;
      }
    }
    sfLog(`Fertig: ${ok} erstellt, ${fail} Fehler.`);
    sfSetBusy(false);
  };

  $('.sf-bulk-amount-btn').onclick = () => {
    const v = parseInt($('.sf-bulk-amount').value, 10);
    if (!Number.isFinite(v) || v < 1) return;
    sfData.forEach(r => { r.amount = v; });
    renderSfTable(sfData);
  };
  $('.sf-bulk-price-btn').onclick = () => {
    const v = parseGermanFloat($('.sf-bulk-price').value);
    if (isNaN(v)) return;
    sfData.forEach(r => { r.price = round2(v); });
    renderSfTable(sfData);
  };
  $('.sf-bulk-language-btn').onclick = () => {
    const v = parseInt($('.sf-bulk-language').value, 10);
    if (!Number.isFinite(v)) return;
    sfData.forEach(r => { r.language = v; });
    renderSfTable(sfData);
  };
  $('.sf-bulk-firsted-btn').onclick = () => {
    const v = $('.sf-bulk-firsted').value;
    if (!v) return;
    const on = v === '1';
    sfData.forEach(r => { r.firstEd = on; });
    renderSfTable(sfData);
  };

  $('.sf-export-btn').onclick = () => {
    downloadCsv(
      [
        ['Karte', 'Konk. (€)', 'Konk. Verkäufer', 'Menge', 'Preis (€)', 'Sprache', 'First Ed', 'Auswahl'],
        ...sfData.map(r => [
          r.cardName,
          r.competitorPrice != null ? r.competitorPrice.toFixed(2) : '',
          r.competitorSeller ?? '',
          r.amount, r.price.toFixed(2),
          languageLabel(r.language), r.firstEd ? '1' : '0',
          r.selected ? 'ja' : 'nein',
        ]),
      ],
      `stockfiller-${setName.replace(/\s+/g, '_')}-${rarityDisplay.replace(/\s+/g, '_')}-${todayIso()}.csv`
    );
  };

  function sfSetBusy(busy) {
    $('.sf-find-btn').disabled = busy;
    if (busy) {
      $('.sf-create-btn').disabled = true;
      $('.sf-export-btn').disabled = true;
    }
  }

  function renderSfTable(data) {
    if (!data.length) { sfArea.innerHTML = '<em>Keine fehlenden Karten.</em>'; return; }

    const rows = data.map((r, i) => {
      const compDisp = r.competitorPrice != null ? fmtEur(r.competitorPrice) + ' €' : '–';
      return `<tr>
        <td class="cb">
          <input type="checkbox" class="row-cb" data-idx="${i}" ${r.selected ? 'checked' : ''}>
        </td>
        <td>${escapeHtml(r.cardName)}</td>
        <td class="num">${compDisp}</td>
        <td><input type="number" class="cell-input cell-amount"
              data-idx="${i}" data-field="amount" min="1" value="${r.amount}"></td>
        <td><input type="text"   class="cell-input cell-price"
              data-idx="${i}" data-field="price"  value="${fmtEur(r.price)}"></td>
        <td>
          <select class="cell-input" data-idx="${i}" data-field="language">
            ${[['3','DE'],['1','EN'],['2','FR'],['4','ES'],['5','IT'],['7','JP']].map(
              ([v, l]) => `<option value="${v}" ${r.language === +v ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </td>
        <td><input type="checkbox" class="cell-input cell-firsted"
              data-idx="${i}" data-field="firstEd" ${r.firstEd ? 'checked' : ''}></td>
      </tr>`;
    }).join('');

    const sel   = data.filter(r => r.selected);
    const items = sel.reduce((s, r) => s + (r.amount || 1), 0);
    const total = round2(sel.reduce((s, r) => s + r.price * (r.amount || 1), 0));

    sfArea.innerHTML = `
      <table>
        <thead><tr>
          <th class="cb"><input type="checkbox" class="master-cb" checked></th>
          <th>Karte</th><th>Konk.</th><th>Mng</th><th>Preis</th><th>Lang</th><th>1st</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="summary" style="margin-top:8px;" id="sf-summary">
        ${sfSummaryHtml(sel.length, items, total)}
      </div>`;

    wireSfTable(sfArea, data);
  }

  function sfSummaryHtml(cards, items, total) {
    return `
      <div class="summary-row"><span>Ausgewählte Karten / Artikel</span><strong>${cards} / ${items}</strong></div>
      <hr>
      <div class="summary-row"><span>Gesamtwert (neue Listings)</span><strong>${fmtEur(total)} €</strong></div>`;
  }

  function refreshSfSummary(data) {
    const box   = sfArea.querySelector('#sf-summary');
    if (!box) return;
    const sel   = data.filter(r => r.selected);
    const items = sel.reduce((s, r) => s + (r.amount || 1), 0);
    const total = round2(sel.reduce((s, r) => s + r.price * (r.amount || 1), 0));
    box.innerHTML = sfSummaryHtml(sel.length, items, total);
  }

  function wireSfTable(container, data) {
    const master = container.querySelector('.master-cb');
    master.addEventListener('change', () => {
      container.querySelectorAll('.row-cb').forEach(cb => {
        cb.checked = master.checked;
        data[+cb.dataset.idx].selected = master.checked;
      });
      refreshSfSummary(data);
    });

    container.querySelectorAll('.row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        data[+cb.dataset.idx].selected = cb.checked;
        const all = [...container.querySelectorAll('.row-cb')];
        master.checked = all.every(c => c.checked);
        master.indeterminate = !master.checked && all.some(c => c.checked);
        refreshSfSummary(data);
      });
    });

    container.querySelectorAll('.cell-input').forEach(input => {
      input.addEventListener('change', () => {
        const idx   = +input.dataset.idx;
        const field = input.dataset.field;
        if (field === 'amount') {
          const v = parseInt(input.value, 10);
          data[idx].amount = Number.isFinite(v) && v >= 1 ? v : 1;
          input.value = data[idx].amount;
        } else if (field === 'price') {
          const v = parseGermanFloat(input.value);
          data[idx].price = !isNaN(v) ? round2(v) : data[idx].price;
          input.value = fmtEur(data[idx].price);
        } else if (field === 'language') {
          data[idx].language = parseInt(input.value, 10);
        } else if (field === 'firstEd') {
          data[idx].firstEd = input.checked;
        }
        refreshSfSummary(data);
      });
    });
  }

  // ============================================================
  // UTILS
  // ============================================================

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

})();
