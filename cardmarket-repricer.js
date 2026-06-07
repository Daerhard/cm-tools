(function () {
  'use strict';

  if (!window.CMCore) {
    console.error('[CMTools] cardmarket-core.js nicht geladen.');
    return;
  }

  const {
    USERNAME, RULES,
    fmtEur, round2, throttle, escapeHtml, downloadCsv, writeLog, todayIso,
    scrapeMyListings, fetchCheapestCommercial,
    pageUrl, rule, ready, rarityDisplay, setName, panel,
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
  `;

  if (!ready) return;

  const $      = sel => tab.querySelector(sel);
  const repArea  = $('.rep-preview-area');
  const repLogEl = $('.rep-log');
  const repLog   = (msg, isErr = false) => writeLog(repLogEl, msg, isErr, 'Repricer');

  let repData = [];

  // ============================================================
  // EVENTS
  // ============================================================

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
        let fetchError = null;
        try {
          comp = await fetchCheapestCommercial(listing);
        } catch (err) {
          fetchError = err.message;
          repLog(`  Fehler: ${err.message}`, true);
          if (/Cloudflare-Challenge/i.test(err.message)) throw err;
          await throttle();
          try {
            comp = await fetchCheapestCommercial(listing);
            fetchError = null;
            repLog(`  Retry erfolgreich.`);
          } catch (err2) {
            repLog(`  Retry fehlgeschlagen: ${err2.message}`, true);
            if (/Cloudflare-Challenge/i.test(err2.message)) throw err2;
          }
        }

        if (fetchError) {
          repData.push({
            ...listing,
            competitorPrice: null, competitorSeller: null,
            newPrice: listing.currentPrice,
            action: 'skip-error',
            errorMsg: fetchError,
          });
          continue;
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
      const errCount = repData.filter(r => r.action === 'skip-error').length;
      repLog(`Vorschau abgeschlossen.${errCount ? ` ${errCount} Karten mit Fehler (rot markiert).` : ''}`);
    } catch (err) {
      repLog('FEHLER: ' + err.message, true);
      console.error('[Repricer]', err);
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

  // ============================================================
  // RENDER
  // ============================================================

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
      const cls = r.action === 'floor'      ? 'change-floor'
                : r.action === 'reprice'    ? (r.newPrice > r.currentPrice ? 'change-up' : 'change-down')
                : r.action === 'skip-error' ? 'change-error'
                : 'change-skip';

      const newDisp = r.action.startsWith('skip')
        ? ({ 'skip-no-competitor': '– kein gewerbl.',
             'skip-duplicate':     '– Duplikat',
             'skip-error':         '– Fehler',
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

})();
