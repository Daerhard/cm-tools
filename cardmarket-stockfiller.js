(function () {
  'use strict';

  if (!window.CMCore) {
    console.error('[CMTools] cardmarket-core.js nicht geladen.');
    return;
  }

  const {
    USERNAME,
    DEFAULT_AMOUNT, DEFAULT_LANGUAGE, DEFAULT_FIRST_ED, DEFAULT_CONDITION_ID, STARLIGHT_FALLBACK,
    parseGermanFloat, fmtEur, round2, throttle,
    assertNotChallenge, escapeHtml, languageLabel, downloadCsv, writeLog, todayIso,
    scrapeMyListings, fetchCheapestCommercial,
    pageUrl, idRarity, rule, ready, rarityDisplay, setName, setSlug, panel,
  } = window.CMCore;

  // ============================================================
  // LOGIK
  // ============================================================

  async function scrapeAllCards(slug, rarityId, logFn) {
    const log = logFn ?? (() => {});
    if (!slug) throw new Error(
      'Set-Slug nicht bekannt. Mindestens eine eigene Karte des Sets muss in der Liste sein.'
    );

    const cards    = [];
    const seen     = new Set();
    let page       = 1;
    const MAX_PAGES = 20;

    while (page <= MAX_PAGES) {
      if (page > 1) await throttle();

      const u = new URL(`/de/YuGiOh/Products/Singles/${slug}`, location.origin);
      u.searchParams.set('idRarity',  rarityId);
      u.searchParams.set('mode',      'list');
      u.searchParams.set('perSite',   '50');
      u.searchParams.set('site',      String(page));

      const res = await fetch(u.toString(), { credentials: 'include' });
      if (!res.ok) break;

      const html = await res.text();
      assertNotChallenge(html, `Set-Liste Seite ${page}`);

      const doc   = new DOMParser().parseFromString(html, 'text/html');
      const links = doc.querySelectorAll(`a[href*="/Products/Singles/${slug}/"]`);
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
  // TAB AUFBAUEN
  // ============================================================

  const sfFloor = rule ? (rule.minimum ?? STARLIGHT_FALLBACK) : STARLIGHT_FALLBACK;
  const tab     = panel.querySelector('.tab-stockfiller');

  tab.innerHTML = `
    <div class="info">
      <div><span class="key">Set:</span>     <strong>${escapeHtml(setName)}</strong></div>
      <div><span class="key">Rarity:</span>  <strong>${escapeHtml(rarityDisplay)}</strong></div>
      <div><span class="key">Account:</span> <strong>${escapeHtml(USERNAME)}</strong></div>
    </div>
    ${ready ? `
      <div class="rule-box">
        <strong>Defaults:</strong> Menge ${DEFAULT_AMOUNT}, Sprache Deutsch, First Edition aktiv.
        Preis = günstigster gewerblicher − ${fmtEur(rule.deduction)} €,
        Mindestpreis <strong>${fmtEur(sfFloor)} €</strong>.
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
  `;

  if (!ready) return;

  const $      = sel => tab.querySelector(sel);
  const sfArea  = $('.sf-preview-area');
  const sfLogEl = $('.sf-log');
  const sfLog   = (msg, isErr = false) => writeLog(sfLogEl, msg, isErr, 'StockFiller');

  let sfData = [];

  // ============================================================
  // EVENTS
  // ============================================================

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
      console.error('[StockFiller]', err);
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

  // ============================================================
  // RENDER
  // ============================================================

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

})();
