(function () {
  'use strict';

  if (!window.CMCore) {
    console.error('[CMTools] cardmarket-core.js nicht geladen.');
    return;
  }

  const {
    USERNAME, RULES,
    fmtEur, round2, throttle,
    escapeHtml, writeLog,
    scrapeMyListings, fetchCheapestCommercial,
    pageUrl, repricerReady, rarityDisplay, setName, panel,
  } = window.CMCore;

  // ============================================================
  // LOGIK
  // ============================================================

  function computeNewPrice(listing, comp, r) {
    if (!comp) return { price: listing.currentPrice, action: 'skip-no-competitor' };
    const target = round2(comp.price - r.deduction);
    if (r.minimum !== null && target < r.minimum) {
      const floored = round2(r.minimum);
      if (floored === listing.currentPrice) return { price: floored, action: 'skip-no-change' };
      return { price: floored, action: 'floor' };
    }
    if (target === listing.currentPrice) return { price: target, action: 'skip-no-change' };
    return { price: target, action: 'reprice' };
  }

  async function updatePrice(articleId, newPrice) {
    const modalRes = await fetch(
      `/de/YuGiOh/Modal/Article_EditArticleModal?showUserOffersRow=1&idArticle=${encodeURIComponent(articleId)}`,
      { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );
    if (!modalRes.ok) throw new Error(`Edit-Modal HTTP ${modalRes.status}`);

    const modalHtml = await modalRes.text();
    window.CMCore.assertNotChallenge(modalHtml, `Edit-Modal ${articleId}`);

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
      method: 'POST', credentials: 'include',
      headers: {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json, text/html, */*',
      },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Update HTTP ${res.status}`);

    const text = await res.text();
    window.CMCore.assertNotChallenge(text, `Update ${articleId}`);

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json && json.success === false)
        throw new Error(`Cardmarket meldete Fehler: ${json.message || text.slice(0, 200)}`);
    }
  }

  async function fetchPool(items, fn, concurrency) {
    const results = new Array(items.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  // ============================================================
  // TAB AUFBAUEN
  // ============================================================

  const tab = panel.querySelector('.tab-repricer');

  tab.innerHTML = `
    <div class="tool-info-bar">
      <span><span class="key">Set</span> <strong>${escapeHtml(setName)}</strong></span>
      <span><span class="key">Rarity</span> <strong>${escapeHtml(rarityDisplay)}</strong></span>
      <span style="color:#ccc;font-size:10px;">${escapeHtml(USERNAME)}</span>
    </div>
    ${repricerReady ? `
      <div class="tool-toolbar">
        <button class="action rep-load-btn">&#9654; Karten laden</button>
        <button class="action rep-include-btn" style="display:none;background:#6D4C41;">Einbeziehen</button>
        <button class="action apply rep-apply-btn" disabled>&#10003; Anwenden</button>
      </div>
      <div class="batch-selector rep-batch-selector" style="display:none;"></div>
      <div class="preview rep-preview-area"></div>
      <div class="log rep-log"></div>
    ` : `
      <div style="padding:12px 14px;">
        <div style="background:#FFF3E0;border-left:3px solid #ED6C02;padding:8px 10px;border-radius:4px;font-size:12px;">
          <strong>Keine Listings gefunden.</strong>
        </div>
      </div>
    `}
  `;

  if (!repricerReady) return;

  const $            = sel => tab.querySelector(sel);
  const repArea      = $('.rep-preview-area');
  const repLogEl     = $('.rep-log');
  const batchSel     = $('.rep-batch-selector');
  const repLog       = (msg, isErr = false) => writeLog(repLogEl, msg, isErr, 'Repricer');

  const BATCH_SIZE   = 50;

  let repData        = [];
  let greyedIncluded = false;
  let allMyListings  = [];
  let primaryListings = [];
  let activeBatchIdx = -1;
  const doneBatches  = new Set();

  // ============================================================
  // PHASE 1 — KARTEN LADEN
  // ============================================================

  $('.rep-load-btn').onclick = async () => {
    repLog('Lade eigene Listings …');
    repSetBusy(true);
    greyedIncluded = false;
    activeBatchIdx = -1;
    repData = [];
    repArea.innerHTML = '';
    batchSel.style.display = 'none';
    $('.rep-include-btn').style.display = 'none';
    doneBatches.clear();

    try {
      allMyListings = await scrapeMyListings(pageUrl, repLog);
      repLog(`${allMyListings.length} eigene Listings gefunden.`);
      if (!allMyListings.length) {
        repLog('Nichts gefunden. Stelle sicher, dass Listings geladen sind.', true);
        return;
      }

      // Group by card URL, mark duplicates
      const byCard = new Map();
      for (const l of allMyListings) {
        const key = l.cardUrl.split('?')[0];
        if (!byCard.has(key)) byCard.set(key, []);
        byCard.get(key).push(l);
      }
      for (const group of byCard.values()) {
        group.sort((a, b) => a.currentPrice - b.currentPrice);
        for (let i = 1; i < group.length; i++) group[i].greyedType = 'duplicate';
      }

      // Mark HR
      for (const l of allMyListings) {
        if (!l.greyedType && l.comment.trim().toUpperCase() === 'HR') l.greyedType = 'hr';
      }

      // Mark unsupported rarity
      const skippedRarity = [];
      for (const l of allMyListings) {
        if (!l.greyedType && l.rarity && !RULES[l.rarity]) {
          l.greyedType = 'unsupported-rarity';
          skippedRarity.push(l.rarity);
        }
      }
      if (skippedRarity.length)
        repLog(`Übersprungen (nicht unterstützte Rarity): ${[...new Set(skippedRarity)].join(', ')}`);

      const dupCount = allMyListings.filter(l => l.greyedType === 'duplicate').length;
      const hrCount  = allMyListings.filter(l => l.greyedType === 'hr').length;
      if (dupCount > 0) repLog(`${dupCount} Duplikate ausgegraut.`);
      if (hrCount  > 0) repLog(`${hrCount} HR-Karten ausgegraut.`);

      primaryListings = [...byCard.values()].map(g => g[0]);
      renderBatchSelector();
      repLog(`${primaryListings.length} einzigartige Karten — Batch wählen.`);

    } catch (err) {
      repLog('FEHLER: ' + err.message, true);
      console.error('[Repricer]', err);
    } finally {
      repSetBusy(false);
    }
  };

  // ============================================================
  // BATCH SELECTOR
  // ============================================================

  function renderBatchSelector() {
    const batchTotal = Math.ceil(primaryListings.length / BATCH_SIZE);
    batchSel.innerHTML = '';

    for (let i = 0; i < batchTotal; i++) {
      const from = i * BATCH_SIZE + 1;
      const to   = Math.min((i + 1) * BATCH_SIZE, primaryListings.length);
      const pill = document.createElement('button');
      pill.className  = 'batch-pill' + (doneBatches.has(i) ? ' done' : '');
      pill.textContent = `${from}–${to}`;
      pill.dataset.batch = i;
      pill.onclick = () => loadBatch(i);
      batchSel.appendChild(pill);
    }

    batchSel.style.display = 'flex';
  }

  function updateBatchPills() {
    batchSel.querySelectorAll('.batch-pill').forEach(pill => {
      const i = +pill.dataset.batch;
      pill.className = 'batch-pill'
        + (doneBatches.has(i) ? ' done' : '')
        + (i === activeBatchIdx ? ' active' : '');
    });
  }

  // ============================================================
  // PHASE 2 — BATCH LADEN & REPRICING
  // ============================================================

  async function loadBatch(bIdx) {
    if (activeBatchIdx === bIdx) return; // already loaded

    activeBatchIdx = bIdx;
    greyedIncluded = false;
    repData = [];
    repArea.innerHTML = '';
    repArea.classList.remove('greyed-included');
    $('.rep-include-btn').style.display = 'none';
    $('.rep-apply-btn').disabled = true;
    updateBatchPills();

    const batch      = primaryListings.slice(bIdx * BATCH_SIZE, (bIdx + 1) * BATCH_SIZE);
    const batchTotal = Math.ceil(primaryListings.length / BATCH_SIZE);
    const offset     = bIdx * BATCH_SIZE;

    repLog(`Batch ${bIdx + 1}/${batchTotal} (${batch.length} Karten) — lade Konkurrenzpreise …`);
    repSetBusy(true);

    try {
      const compMap = new Map();
      let done = 0;

      await fetchPool(batch, async (primary) => {
        if (done > 0) await throttle();
        done++;
        repLog(`(${offset + done}/${primaryListings.length}) ${primary.cardName} …`);

        let comp = null;
        let fetchError = null;
        try {
          comp = await fetchCheapestCommercial(primary);
        } catch (err) {
          fetchError = err.message;
          repLog(`  Fehler: ${err.message}`, true);
          if (/Cloudflare-Challenge/i.test(err.message)) throw err;
          if (/HTTP 429/.test(err.message)) {
            repLog('  Rate-Limit — warte 45 Sekunden …');
            await window.CMCore.sleep(45000);
          } else {
            await throttle();
          }
          try {
            comp = await fetchCheapestCommercial(primary);
            fetchError = null;
            repLog('  Retry erfolgreich.');
          } catch (err2) {
            repLog(`  Retry fehlgeschlagen: ${err2.message}`, true);
            if (/Cloudflare-Challenge/i.test(err2.message)) throw err2;
            if (/HTTP 429/.test(err2.message))
              throw new Error('Rate-Limit nach Wartezeit — bitte einige Minuten warten.');
          }
        }

        const key = primary.cardUrl.split('?')[0];
        compMap.set(key, fetchError ? { error: fetchError } : { comp });
      }, 1);

      const batchKeys = new Set(batch.map(p => p.cardUrl.split('?')[0]));

      repData = allMyListings
        .filter(l => batchKeys.has(l.cardUrl.split('?')[0]))
        .map(listing => {
          const key   = listing.cardUrl.split('?')[0];
          const entry = compMap.get(key) ?? { comp: null };
          const r     = RULES[listing.rarity] ?? null;

          if (listing.greyedType === 'unsupported-rarity')
            return { ...listing, competitorPrice: null, competitorSeller: null,
                     newPrice: listing.currentPrice, action: 'skip-no-rule', selected: false };
          if (entry.error)
            return { ...listing, competitorPrice: null, competitorSeller: null,
                     newPrice: listing.currentPrice, action: 'skip-error',
                     errorMsg: entry.error, selected: false };
          if (!r)
            return { ...listing, competitorPrice: null, competitorSeller: null,
                     newPrice: listing.currentPrice, action: 'skip-no-rule', selected: false };

          const dec = computeNewPrice(listing, entry.comp, r);
          return {
            ...listing,
            competitorPrice:  entry.comp?.price  ?? null,
            competitorSeller: entry.comp?.seller ?? null,
            newPrice:  dec.price,
            action:    dec.action,
            selected: !listing.greyedType,
          };
        });

      renderRepPreview(repData);

      const hasGreyed = repData.some(r => r.greyedType);
      $('.rep-include-btn').style.display = hasGreyed ? 'block' : 'none';
      $('.rep-apply-btn').disabled =
        !repData.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));

      const errCount = repData.filter(r => r.action === 'skip-error').length;
      repLog(`Batch ${bIdx + 1}/${batchTotal} bereit.${errCount ? ` ${errCount} Fehler.` : ''}`);

    } catch (err) {
      repLog('FEHLER: ' + err.message, true);
      console.error('[Repricer]', err);
    } finally {
      repSetBusy(false);
    }
  }

  // ============================================================
  // AUSGEBLENDETE EINBEZIEHEN
  // ============================================================

  $('.rep-include-btn').onclick = () => {
    greyedIncluded = !greyedIncluded;
    repArea.classList.toggle('greyed-included', greyedIncluded);
    repData.forEach(r => {
      if (!r.greyedType) return;
      r.selected = greyedIncluded && !r.action.startsWith('skip');
    });
    repArea.querySelectorAll('.row-cb[data-greyed]').forEach(cb => {
      cb.disabled = !greyedIncluded;
      cb.checked  = greyedIncluded;
    });
    $('.rep-include-btn').textContent = greyedIncluded ? 'Ausblenden' : 'Einbeziehen';
    $('.rep-apply-btn').disabled =
      !repData.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
    refreshRepSummary(repData);
  };

  // ============================================================
  // PREISE ANWENDEN
  // ============================================================

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
    doneBatches.add(activeBatchIdx);
    activeBatchIdx = -1;
    updateBatchPills();
    repSetBusy(false);
  };

  // ============================================================
  // HELPERS
  // ============================================================

  function repSetBusy(busy) {
    $('.rep-load-btn').disabled    = busy;
    $('.rep-include-btn').disabled = busy;
    if (busy) $('.rep-apply-btn').disabled = true;
    batchSel.querySelectorAll('.batch-pill').forEach(p => p.disabled = busy);
  }

  function refreshRepSummary(data) {
    const box = repArea.querySelector('#rep-summary');
    if (!box) return;
    const sel      = data.filter(r => r.selected);
    const total    = sel.length;
    const items    = sel.reduce((s, r) => s + (r.amount || 1), 0);
    const curTotal = round2(sel.reduce((s, r) => s + r.currentPrice * (r.amount || 1), 0));
    const newTotal = round2(sel.reduce((s, r) => s + r.newPrice    * (r.amount || 1), 0));
    const delta    = round2(newTotal - curTotal);
    const deltaStr = (delta >= 0 ? '+' : '') + fmtEur(delta);
    const deltaCls = delta >= 0 ? 'delta-pos' : 'delta-neg';
    box.innerHTML = `
      <div class="summary-row"><span>Ausgewählte Listings / Artikel</span><strong>${total} / ${items}</strong></div>
      <hr>
      <div class="summary-row"><span>Aktueller Gesamtwert</span><strong>${fmtEur(curTotal)} €</strong></div>
      <div class="summary-row"><span>Neuer Gesamtwert</span>    <strong>${fmtEur(newTotal)} €</strong></div>
      <div class="summary-row"><span>Differenz</span>           <strong class="${deltaCls}">${deltaStr} €</strong></div>
    `;
  }

  // ============================================================
  // RENDER
  // ============================================================

  function renderRepPreview(data) {
    if (!data.length) { repArea.innerHTML = '<em>Keine Listings.</em>'; return; }

    const rows = data.map((r, i) => {
      const cls = r.action === 'floor'      ? 'change-floor'
                : r.action === 'reprice'    ? (r.newPrice > r.currentPrice ? 'change-up' : 'change-down')
                : r.action === 'skip-error' ? 'change-error'
                : 'change-skip';
      const isSkip = r.action.startsWith('skip');
      const newDisp = isSkip
        ? ({ 'skip-no-competitor': '– kein gewerbl.',
             'skip-no-change':     '– keine Änderung',
             'skip-no-rule':       '– Rarity n/a',
             'skip-error':         '– Fehler',
           }[r.action] ?? '– keine Änderung')
        : fmtEur(r.newPrice) + ' €';
      const compDisp = r.competitorPrice != null ? fmtEur(r.competitorPrice) + ' €' : '–';
      const dStr = isSkip ? ''
        : ((r.newPrice - r.currentPrice >= 0) ? '+' : '') + fmtEur(r.newPrice - r.currentPrice);
      const isGreyed           = !!r.greyedType;
      const isGreyedToggleable = isGreyed && !isSkip;
      const greyedLabel = r.greyedType === 'hr'        ? ' [HR]'
                        : r.greyedType === 'duplicate' ? ' [Duplikat]'
                        : '';
      return `<tr class="${cls}${isGreyed ? ' row-greyed' : ''}">
        <td class="cb">
          <input type="checkbox" class="row-cb" data-idx="${i}"
            ${r.selected ? 'checked' : ''}
            ${(isSkip || isGreyed) ? 'disabled' : ''}
            ${isGreyedToggleable ? 'data-greyed="1"' : ''}>
        </td>
        <td>${escapeHtml(r.cardName)}<span style="color:#aaa;font-size:10px;">${greyedLabel}</span></td>
        <td class="num" style="font-size:10px;color:#888;">${escapeHtml(r.rarity || '–')}</td>
        <td class="num">${r.amount || 1}</td>
        <td class="num">${fmtEur(r.currentPrice)}</td>
        <td class="num">${compDisp}</td>
        <td class="num">${newDisp}</td>
        <td class="num">${dStr}</td>
      </tr>`;
    }).join('');

    repArea.innerHTML = `
      <div class="summary" style="margin-bottom:8px;" id="rep-summary"></div>
      <table>
        <thead><tr>
          <th class="cb"><input type="checkbox" class="master-cb"></th>
          <th>Karte</th><th>Rar.</th><th>Mng</th><th>Alt</th><th>Konk.</th><th>Neu</th><th>Δ</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    refreshRepSummary(data);
    wireRepCheckboxes(repArea, data);
  }

  function wireRepCheckboxes(container, data) {
    const master = container.querySelector('.master-cb');
    const updateMaster = () => {
      const enabled = [...container.querySelectorAll('.row-cb:not(:disabled)')];
      master.checked       = enabled.length > 0 && enabled.every(c => c.checked);
      master.indeterminate = !master.checked && enabled.some(c => c.checked);
    };
    master.addEventListener('change', () => {
      container.querySelectorAll('.row-cb:not(:disabled)').forEach(cb => {
        cb.checked = master.checked;
        data[+cb.dataset.idx].selected = master.checked;
      });
      $('.rep-apply-btn').disabled =
        !data.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
      refreshRepSummary(data);
    });
    container.querySelectorAll('.row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        data[+cb.dataset.idx].selected = cb.checked;
        updateMaster();
        $('.rep-apply-btn').disabled =
          !data.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
        refreshRepSummary(data);
      });
    });
    updateMaster();
  }

})();
