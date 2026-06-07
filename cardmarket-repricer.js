(function () {
  'use strict';

  if (!window.CMCore) {
    console.error('[CMTools] cardmarket-core.js nicht geladen.');
    return;
  }

  const {
    USERNAME, RULES,
    fmtEur, round2, throttle,
    escapeHtml, writeLog, todayIso,
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
    const modalUrl = `/de/YuGiOh/Modal/Article_EditArticleModal?showUserOffersRow=1&idArticle=${encodeURIComponent(articleId)}`;
    const modalRes = await fetch(modalUrl, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
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
    window.CMCore.assertNotChallenge(text, `Update ${articleId}`);

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json && json.success === false) {
        throw new Error(`Cardmarket meldete Fehler: ${json.message || text.slice(0, 200)}`);
      }
    }
  }

  // Runs up to `concurrency` fetches in parallel
  async function fetchPool(items, fn, concurrency) {
    const results = new Array(items.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  // ============================================================
  // TAB AUFBAUEN
  // ============================================================

  const tab = panel.querySelector('.tab-repricer');

  tab.innerHTML = `
    <div class="info">
      <div><span class="key">Set:</span>     <strong>${escapeHtml(setName)}</strong></div>
      <div><span class="key">Rarity:</span>  <strong>${escapeHtml(rarityDisplay)}</strong></div>
      <div><span class="key">Account:</span> <strong>${escapeHtml(USERNAME)}</strong>
        <span style="color:#888">(wird ausgefiltert)</span></div>
    </div>
    ${repricerReady ? `
      <div class="rule-box">
        Verarbeitet alle sichtbaren Listings. Preis wird pro Karte anhand der Rarität berechnet.<br>
        Unterstützte Rarities: Common, Super Rare, Ultra Rare, Secret Rare, Starlight Rare.
      </div>
      <button class="action rep-preview-btn">Vorschau starten</button>
      <button class="action apply rep-apply-btn" disabled>Preise anwenden</button>
      <button class="action rep-include-btn" style="display:none;background:#6D4C41;">
        Ausgeblendete einbeziehen
      </button>
      <div class="preview rep-preview-area"></div>
      <div class="log rep-log"></div>
    ` : `
      <div class="rule-box" style="background:#FFF3E0;border-left:3px solid #ED6C02;">
        <strong>Keine Listings gefunden.</strong>
      </div>
    `}
  `;

  if (!repricerReady) return;

  const $        = sel => tab.querySelector(sel);
  const repArea  = $('.rep-preview-area');
  const repLogEl = $('.rep-log');
  const repLog   = (msg, isErr = false) => writeLog(repLogEl, msg, isErr, 'Repricer');

  let repData        = [];
  let greyedIncluded = false;

  // ============================================================
  // VORSCHAU
  // ============================================================

  $('.rep-preview-btn').onclick = async () => {
    repLog('Vorschau wird erstellt …');
    repSetBusy(true);
    greyedIncluded = false;
    $('.rep-include-btn').textContent = 'Ausgeblendete einbeziehen';
    repArea.classList.remove('greyed-included');

    try {
      const myListings = await scrapeMyListings(pageUrl, repLog);
      repLog(`${myListings.length} eigene Listings gefunden.`);
      if (!myListings.length) {
        repLog('Nichts zu tun. Stelle sicher, dass Listings geladen sind.', true);
        return;
      }

      // 1. Group by card URL, mark non-cheapest as duplicate
      const byCard = new Map();
      for (const l of myListings) {
        const key = l.cardUrl.split('?')[0];
        if (!byCard.has(key)) byCard.set(key, []);
        byCard.get(key).push(l);
      }
      for (const group of byCard.values()) {
        group.sort((a, b) => a.currentPrice - b.currentPrice);
        for (let i = 1; i < group.length; i++) group[i].greyedType = 'duplicate';
      }

      // 2. Mark HR speculation cards
      for (const l of myListings) {
        if (!l.greyedType && l.comment.trim().toUpperCase() === 'HR') {
          l.greyedType = 'hr';
        }
      }

      // 3. Skip listings with unsupported rarity
      const skippedRarity = [];
      for (const l of myListings) {
        if (!l.greyedType && l.rarity && !RULES[l.rarity]) {
          l.greyedType = 'unsupported-rarity';
          skippedRarity.push(l.rarity);
        }
      }
      if (skippedRarity.length) {
        const unique = [...new Set(skippedRarity)];
        repLog(`Übersprungen (nicht unterstützte Rarity): ${unique.join(', ')}`);
      }

      const dupCount = myListings.filter(l => l.greyedType === 'duplicate').length;
      const hrCount  = myListings.filter(l => l.greyedType === 'hr').length;
      if (dupCount > 0) repLog(`${dupCount} Duplikat-Listings werden ausgegraut.`);
      if (hrCount  > 0) repLog(`${hrCount} Spekulationskarten (HR) werden ausgegraut.`);

      // 4. Fetch competitor once per unique card, 2 in parallel
      const primaryListings = [...byCard.values()].map(g => g[0]);
      const total = primaryListings.length;

      const compMap = new Map();
      let done = 0;

      await fetchPool(primaryListings, async (primary) => {
        if (done > 0) await throttle();
        done++;
        repLog(`(${done}/${total}) ${primary.cardName} …`);

        let comp = null;
        let fetchError = null;
        try {
          comp = await fetchCheapestCommercial(primary);
        } catch (err) {
          fetchError = err.message;
          repLog(`  Fehler: ${err.message}`, true);
          if (/Cloudflare-Challenge/i.test(err.message)) throw err;
          await throttle();
          try {
            comp = await fetchCheapestCommercial(primary);
            fetchError = null;
            repLog(`  Retry erfolgreich.`);
          } catch (err2) {
            repLog(`  Retry fehlgeschlagen: ${err2.message}`, true);
            if (/Cloudflare-Challenge/i.test(err2.message)) throw err2;
          }
        }

        const key = primary.cardUrl.split('?')[0];
        compMap.set(key, fetchError ? { error: fetchError } : { comp });
      }, 1);

      // 5. Build repData for ALL listings with per-card rule
      repData = myListings.map(listing => {
        const key   = listing.cardUrl.split('?')[0];
        const entry = compMap.get(key) ?? { comp: null };
        const r     = RULES[listing.rarity] ?? null;

        if (listing.greyedType === 'unsupported-rarity') {
          return { ...listing, competitorPrice: null, competitorSeller: null,
                   newPrice: listing.currentPrice, action: 'skip-no-rule', selected: false };
        }

        if (entry.error) {
          return { ...listing, competitorPrice: null, competitorSeller: null,
                   newPrice: listing.currentPrice, action: 'skip-error',
                   errorMsg: entry.error, selected: false };
        }

        if (!r) {
          return { ...listing, competitorPrice: null, competitorSeller: null,
                   newPrice: listing.currentPrice, action: 'skip-no-rule', selected: false };
        }

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
      $('.rep-apply-btn').disabled = !repData.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));

      const errCount = repData.filter(r => r.action === 'skip-error').length;
      repLog(`Vorschau abgeschlossen.${errCount ? ` ${errCount} Karten mit Fehler (rot).` : ''}`);
    } catch (err) {
      repLog('FEHLER: ' + err.message, true);
      console.error('[Repricer]', err);
    } finally {
      repSetBusy(false);
    }
  };

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

    $('.rep-include-btn').textContent = greyedIncluded
      ? 'Ausgeblendete ausschließen'
      : 'Ausgeblendete einbeziehen';

    $('.rep-apply-btn').disabled = !repData.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
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
    repSetBusy(false);
  };

  // ============================================================
  // HELPERS
  // ============================================================

  function repSetBusy(busy) {
    $('.rep-preview-btn').disabled   = busy;
    $('.rep-apply-btn').disabled     = busy || true;
    $('.rep-include-btn').disabled   = busy;
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
        ? ({ 'skip-no-competitor':  '– kein gewerbl.',
             'skip-no-change':      '– keine Änderung',
             'skip-no-rule':        '– Rarity n/a',
             'skip-error':          '– Fehler',
           }[r.action] ?? '– keine Änderung')
        : fmtEur(r.newPrice) + ' €';

      const compDisp = r.competitorPrice != null ? fmtEur(r.competitorPrice) + ' €' : '–';
      const dStr     = isSkip ? ''
        : ((r.newPrice - r.currentPrice >= 0) ? '+' : '') + fmtEur(r.newPrice - r.currentPrice);

      const isGreyed          = !!r.greyedType;
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
      $('.rep-apply-btn').disabled = !data.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
      refreshRepSummary(data);
    });

    container.querySelectorAll('.row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        data[+cb.dataset.idx].selected = cb.checked;
        updateMaster();
        $('.rep-apply-btn').disabled = !data.some(r => r.selected && (r.action === 'reprice' || r.action === 'floor'));
        refreshRepSummary(data);
      });
    });

    updateMaster();
  }

})();
