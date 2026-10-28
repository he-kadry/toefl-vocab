(() => {
  'use strict';

  // ---------- Storage ----------

  const STORAGE_KEY = 'toefl-vocab-v1';
  const DAY = 24 * 60 * 60 * 1000;
  // Leitner boxes: days until the next review after a successful recall.
  const INTERVALS = [0, 1, 2, 4, 7, 15, 30];
  const MASTERED_BOX = 5;
  const SESSION_SIZE = 30;

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.words)) return { daily: {}, ...parsed };
      }
    } catch (e) { /* fall through to empty state */ }
    return { version: 1, words: [], daily: {} };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save to browser storage: ' + e.message);
    }
  }

  // ---------- Helpers ----------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = (s) => String(s || '').trim().toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const today = () => new Date().toISOString().slice(0, 10);

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const splitList = (s) => uniq(String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean));
  const splitLines = (s) => String(s || '').split(/\n/).map((x) => x.trim()).filter(Boolean);

  function uniq(arr) {
    const seen = new Set();
    return arr.filter((x) => {
      const k = norm(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Matches the word and simple inflections (meticulously, accumulating, abandoned…).
  function termRegex(term) {
    const t = term.trim();
    const stem = t.length > 4 ? t.replace(/(e|y)$/i, '') : t;
    return new RegExp(`\\b${escRe(stem)}[a-z]*`, 'gi');
  }

  function highlight(example, term) {
    return esc(example).replace(termRegex(esc(term)), (m) => `<mark>${m}</mark>`);
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  async function withBusy(btn, label, fn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      return await fn((progress) => { btn.textContent = `${label} ${progress}`; });
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return toast('Speech is not supported in this browser');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  }

  // ---------- Word model ----------

  function makeWord(fields, source) {
    return {
      id: uid(),
      term: fields.term.trim(),
      pos: fields.pos || '',
      definition: fields.definition || '',
      synonyms: fields.synonyms || [],
      antonyms: fields.antonyms || [],
      examples: fields.examples || [],
      arabic: fields.arabic || '',
      source,               // 'mine' | 'extra'
      box: 0,
      due: Date.now(),
      correct: 0,
      wrong: 0,
      added: Date.now(),
    };
  }

  const findWord = (term) => state.words.find((w) => norm(w.term) === norm(term));
  const wordsIn = (deck) => state.words.filter((w) => deck === 'both' || w.source === deck);

  function missingFields(w) {
    const m = [];
    if (!w.definition) m.push('definition');
    if (!w.synonyms.length) m.push('synonyms');
    if (!w.antonyms.length) m.push('antonyms');
    if (!w.examples.length) m.push('examples');
    return m;
  }

  // Adds or merges a word. Words imported into "mine" that already exist in the
  // extra deck are moved over rather than duplicated.
  function upsert(fields, source) {
    const existing = findWord(fields.term);
    if (!existing) {
      const w = makeWord(fields, source);
      state.words.push(w);
      return { word: w, status: 'added' };
    }
    mergeInto(existing, fields);
    if (source === 'mine' && existing.source === 'extra') {
      existing.source = 'mine';
      return { word: existing, status: 'moved' };
    }
    return { word: existing, status: 'exists' };
  }

  function mergeInto(w, f) {
    if (!w.pos && f.pos) w.pos = f.pos;
    if (!w.definition && f.definition) w.definition = f.definition;
    if (f.arabic && !(w.arabic || '').includes(f.arabic)) w.arabic = w.arabic ? `${w.arabic} / ${f.arabic}` : f.arabic;
    if (f.synonyms?.length) w.synonyms = uniq([...w.synonyms, ...f.synonyms]).slice(0, 10);
    if (f.antonyms?.length) w.antonyms = uniq([...w.antonyms, ...f.antonyms]).slice(0, 8);
    if (f.examples?.length) w.examples = uniq([...w.examples, ...f.examples]).slice(0, 4);
  }

  // ---------- Online lookups ----------

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Returns {pos, definition, synonyms, antonyms, examples}, or null if nothing was found.
  async function lookup(term) {
    const q = encodeURIComponent(term.trim().toLowerCase());
    const out = { pos: '', definition: '', synonyms: [], antonyms: [], examples: [] };

    const [dict, syn, ant] = await Promise.allSettled([
      fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${q}`),
      fetchJson(`https://api.datamuse.com/words?rel_syn=${q}&max=8`),
      fetchJson(`https://api.datamuse.com/words?rel_ant=${q}&max=6`),
    ]);

    if (dict.status === 'fulfilled' && Array.isArray(dict.value)) {
      for (const entry of dict.value) {
        for (const meaning of entry.meanings || []) {
          out.synonyms.push(...(meaning.synonyms || []));
          out.antonyms.push(...(meaning.antonyms || []));
          for (const d of meaning.definitions || []) {
            if (!out.definition && d.definition) {
              out.definition = d.definition;
              out.pos = meaning.partOfSpeech || '';
            }
            out.synonyms.push(...(d.synonyms || []));
            out.antonyms.push(...(d.antonyms || []));
            if (d.example) out.examples.push(d.example);
          }
        }
      }
    }
    if (syn.status === 'fulfilled') out.synonyms.push(...syn.value.map((x) => x.word));
    if (ant.status === 'fulfilled') out.antonyms.push(...ant.value.map((x) => x.word));

    const notSelf = (x) => norm(x) !== norm(term) && !/\s{2,}/.test(x);
    out.synonyms = uniq(out.synonyms.filter(notSelf)).slice(0, 8);
    out.antonyms = uniq(out.antonyms.filter(notSelf)).slice(0, 6);
    out.examples = uniq(out.examples).slice(0, 3);

    const found = out.definition || out.synonyms.length || out.antonyms.length;
    return found ? out : null;
  }

  async function autofill(word) {
    const info = await lookup(word.term);
    if (info) mergeInto(word, info);
    return !!info;
  }

  // Runs async jobs with limited concurrency so we stay polite to the free APIs.
  async function runPool(items, worker, concurrency = 3, onProgress) {
    let i = 0, done = 0;
    const results = new Array(items.length);
    async function next() {
      while (i < items.length) {
        const idx = i++;
        try { results[idx] = await worker(items[idx]); } catch (e) { results[idx] = null; }
        onProgress?.(++done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
    return results;
  }

  // ---------- Tabs ----------

  function showView(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'mine') renderList('mine');
    if (name === 'extra') renderList('extra');
    if (name === 'data') renderStats();
    if (name === 'study') renderStudyStats();
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  // ---------- Word lists ----------

  function renderList(deck) {
    const container = $(`#${deck}-list`);
    const query = norm($(`#${deck}-search`).value);
    const words = wordsIn(deck)
      .filter((w) => !query || [w.term, w.definition, w.arabic, ...w.synonyms].some((x) => norm(x).includes(query)))
      .sort((a, b) => a.term.localeCompare(b.term));

    const total = wordsIn(deck).length;
    const label = deck === 'mine' ? $('#mine-count') : $('#extra-count-label');
    label.textContent = `${total} word${total === 1 ? '' : 's'}`;

    if (!words.length) {
      container.innerHTML = `<div class="empty">${total ? 'No matches.' : deck === 'mine'
        ? 'No words yet — add them above or bulk import your list.'
        : 'No extra words yet — fetch some above.'}</div>`;
      return;
    }

    container.innerHTML = words.map((w) => {
      const missing = missingFields(w);
      const moveBtn = deck === 'extra'
        ? '<button data-act="move" title="Move to My Words">→ My Words</button>' : '';
      return `
        <article class="word-item" data-id="${w.id}">
          <div>
            <h3>${esc(w.term)}<small>${esc(w.pos)}</small>
              <span class="level">· level ${w.box}/${INTERVALS.length - 1}</span></h3>
            ${w.arabic ? `<p class="arabic" dir="rtl">${esc(w.arabic)}</p>` : ''}
            ${w.definition ? `<p>${esc(w.definition)}</p>` : ''}
            ${w.synonyms.length ? `<p><span class="label">Syn</span> ${esc(w.synonyms.join(', '))}</p>` : ''}
            ${w.antonyms.length ? `<p><span class="label">Ant</span> ${esc(w.antonyms.join(', '))}</p>` : ''}
            ${w.examples[0] ? `<p class="muted"><i>${highlight(w.examples[0], w.term)}</i></p>` : ''}
            ${missing.length ? `<p class="missing">Missing: ${missing.join(', ')}</p>` : ''}
          </div>
          <div class="actions">
            <button data-act="speak" title="Pronounce">🔊</button>
            ${missing.length ? '<button data-act="fill">Auto-fill</button>' : ''}
            ${moveBtn}
            <button data-act="edit">Edit</button>
            <button data-act="delete" class="danger">Delete</button>
          </div>
        </article>`;
    }).join('');
  }

  async function onListClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.word-item').dataset.id;
    const w = state.words.find((x) => x.id === id);
    if (!w) return;
    const deck = w.source;

    switch (btn.dataset.act) {
      case 'speak':
        speak(w.term);
        break;
      case 'fill':
        await withBusy(btn, '…', async () => {
          const ok = await autofill(w);
          toast(ok ? `Updated “${w.term}”` : `Nothing found online for “${w.term}”`);
        });
        save();
        renderList(deck);
        break;
      case 'move':
        w.source = 'mine';
        save();
        renderList('extra');
        toast(`Moved “${w.term}” to My Words`);
        break;
      case 'edit':
        openEdit(w);
        break;
      case 'delete':
        if (!confirm(`Delete “${w.term}”?`)) return;
        state.words = state.words.filter((x) => x.id !== id);
        save();
        renderList(deck);
        break;
    }
  }

  $('#mine-list').addEventListener('click', onListClick);
  $('#extra-list').addEventListener('click', onListClick);
  $('#mine-search').addEventListener('input', () => renderList('mine'));
  $('#extra-search').addEventListener('input', () => renderList('extra'));

  // ---------- Add / edit / import ----------

  function readForm(form) {
    const f = new FormData(form);
    return {
      term: (f.get('term') || '').trim(),
      pos: (f.get('pos') || '').trim(),
      definition: (f.get('definition') || '').trim(),
      synonyms: splitList(f.get('synonyms')),
      antonyms: splitList(f.get('antonyms')),
      examples: splitLines(f.get('examples')),
      arabic: (f.get('arabic') || '').trim(),
    };
  }

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fields = readForm(form);
    if (!fields.term) return;
    const { word, status } = upsert(fields, 'mine');
    if (status === 'exists') toast(`“${word.term}” is already in your list — merged the new details`);
    if (status === 'moved') toast(`Moved “${word.term}” from Extra to My Words`);

    if (form.autofill.checked && missingFields(word).length) {
      await withBusy(form.querySelector('[type=submit]'), 'Looking up…', () => autofill(word));
    }
    save();
    form.reset();
    form.autofill.checked = true;
    form.term.focus();
    renderList('mine');
    if (status === 'added') toast(`Added “${word.term}”`);
  });

  let editingId = null;
  function openEdit(w) {
    editingId = w.id;
    const form = $('#edit-form');
    form.term.value = w.term;
    form.pos.value = w.pos;
    form.definition.value = w.definition;
    form.synonyms.value = w.synonyms.join(', ');
    form.antonyms.value = w.antonyms.join(', ');
    form.examples.value = w.examples.join('\n');
    form.arabic.value = w.arabic || '';
    $('#edit-dialog').showModal();
  }

  $('#edit-dialog').addEventListener('close', () => {
    const dlg = $('#edit-dialog');
    const w = state.words.find((x) => x.id === editingId);
    editingId = null;
    if (dlg.returnValue !== 'save' || !w) return;
    const f = readForm($('#edit-form'));
    if (!f.term) return;
    Object.assign(w, f);
    save();
    renderList(w.source);
  });

  // Minimal CSV parser supporting quoted fields.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }

  function rowToFields(cols) {
    const [term, definition, syn, ant, example, arabic] = cols.map((c) => (c || '').trim());
    return {
      term,
      definition: definition || '',
      synonyms: splitList(syn),
      antonyms: splitList(ant),
      examples: example ? [example] : [],
      arabic: arabic || '',
    };
  }

  function parseImport(text, isCsv) {
    const rows = isCsv
      ? parseCsv(text)
      : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('|'));
    if (rows.length && /^(word|term)$/i.test((rows[0][0] || '').trim())) rows.shift();
    return rows.map(rowToFields).filter((f) => f.term);
  }

  $('#bulk-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const isCsv = /\.csv$/i.test(file.name);
    // Show CSV contents in the textarea in pipe format so the user can review them.
    $('#bulk-text').value = isCsv
      ? parseCsv(text).map((r) => r.map((c) => c.trim()).join(' | ')).join('\n')
      : text;
    e.target.value = '';
  });

  $('#bulk-import').addEventListener('click', async (e) => {
    const entries = parseImport($('#bulk-text').value, false);
    if (!entries.length) return toast('Nothing to import');

    let added = 0, moved = 0, merged = 0;
    const touched = entries.map((f) => {
      const r = upsert(f, 'mine');
      if (r.status === 'added') added++;
      else if (r.status === 'moved') moved++;
      else merged++;
      return r.word;
    });
    save();

    if ($('#bulk-autofill').checked) {
      const todo = touched.filter((w) => missingFields(w).length);
      await withBusy(e.target, 'Looking up', (progress) =>
        runPool(todo, autofill, 3, (d, n) => progress(`${d}/${n}`)));
      save();
    }
    $('#bulk-text').value = '';
    renderList('mine');
    toast(`Imported: ${added} new, ${moved} moved from Extra, ${merged} merged`);
  });

  $('#mine-autofill-all').addEventListener('click', async (e) => {
    const todo = wordsIn('mine').filter((w) => missingFields(w).length);
    if (!todo.length) return toast('All your words are complete');
    const results = await withBusy(e.target, 'Looking up', (progress) =>
      runPool(todo, autofill, 3, (d, n) => progress(`${d}/${n}`)));
    save();
    renderList('mine');
    toast(`Updated ${results.filter(Boolean).length} of ${todo.length} words`);
  });

  // ---------- Extra words ----------

  // Looks up candidates one by one until `want` words with a definition were added.
  async function addExtraWords(candidates, want, progress) {
    let added = 0;
    const queue = candidates.filter((t) => !findWord(t));
    while (added < want && queue.length) {
      const batch = queue.splice(0, Math.min(3, want - added));
      const infos = await Promise.all(batch.map((t) => lookup(t).catch(() => null)));
      batch.forEach((term, i) => {
        if (added < want && infos[i]?.definition && !findWord(term)) {
          state.words.push(makeWord({ term, ...infos[i] }, 'extra'));
          added++;
        }
      });
      progress(`${added}/${want}`);
    }
    save();
    return added;
  }

  $('#extra-toefl').addEventListener('click', async (e) => {
    const want = Number($('#extra-count').value);
    const added = await withBusy(e.target, 'Fetching', (p) =>
      addExtraWords(shuffle(window.TOEFL_WORDS || []), want, p));
    renderList('extra');
    toast(added ? `Added ${added} TOEFL words` : 'No new words found (offline, or the list is used up)');
  });

  // Uses Datamuse "means like" to find words related to the user's own list,
  // preferring moderately rare words (likely academic vocabulary).
  $('#extra-related').addEventListener('click', async (e) => {
    const mine = shuffle(wordsIn('mine')).slice(0, 8);
    if (!mine.length) return toast('Add some words to My Words first');
    const want = Number($('#extra-count').value);

    const added = await withBusy(e.target, 'Fetching', async (p) => {
      const lists = await Promise.all(mine.map((w) =>
        fetchJson(`https://api.datamuse.com/words?ml=${encodeURIComponent(w.term)}&md=f&max=20`).catch(() => [])));
      const candidates = [];
      for (const list of lists) {
        for (const item of list) {
          const freq = parseFloat((item.tags || []).find((t) => t.startsWith('f:'))?.slice(2) || '0');
          if (/^[a-z]{5,}$/.test(item.word) && freq > 0.3 && freq < 40) candidates.push(item.word);
        }
      }
      return addExtraWords(shuffle(uniq(candidates)), want, p);
    });
    renderList('extra');
    toast(added ? `Added ${added} related words` : 'No related words found (are you online?)');
  });

  $('#extra-clear').addEventListener('click', () => {
    const n = wordsIn('extra').length;
    if (!n || !confirm(`Remove all ${n} extra words? Words in My Words are kept.`)) return;
    state.words = state.words.filter((w) => w.source !== 'extra');
    save();
    renderList('extra');
  });

  // ---------- Flashcards ----------

  // `revealed` stays true once the back was shown, so rating still works if the
  // card is flipped back to the front (e.g. a double tap on a phone).
  const study = { queue: [], index: 0, total: 0, flipped: false, revealed: false };

  function renderStudyStats() {
    const deck = $('#study-deck').value;
    const words = wordsIn(deck);
    const due = words.filter((w) => w.due <= Date.now()).length;
    $('#study-stats').textContent = words.length ? `${due} due · ${words.length} total` : '';
    const idle = $('#study-area').hidden;
    $('#study-empty').hidden = !idle || words.length > 0 || !$('#study-done').hidden;
  }
  $('#study-deck').addEventListener('change', renderStudyStats);

  $('#study-start').addEventListener('click', () => {
    const deck = $('#study-deck').value;
    const filter = $('#study-filter').value;
    let words = wordsIn(deck);
    if (!words.length) {
      $('#study-done').hidden = true;
      $('#study-empty').hidden = false;
      return toast('This deck is empty');
    }
    if (filter === 'due') {
      words = shuffle(words.filter((w) => w.due <= Date.now())).sort((a, b) => a.box - b.box);
      if (!words.length) return toast('Nothing due right now — try “All” or come back later');
    } else if (filter === 'weak') {
      const score = (w) => w.box * 2 - w.wrong + w.correct * 0.5;
      words = shuffle(words).sort((a, b) => score(a) - score(b)).slice(0, 25);
    } else {
      words = shuffle(words);
    }
    words = words.slice(0, SESSION_SIZE);
    study.queue = words.map((w) => w.id);
    study.index = 0;
    study.total = words.length;
    $('#study-empty').hidden = true;
    $('#study-done').hidden = true;
    $('#study-area').hidden = false;
    $('#view-study').classList.add('in-session');
    showCard();
    $('#card').focus(); // so Space flips the card instead of re-clicking "Start"
  });

  function currentCard() {
    return state.words.find((w) => w.id === study.queue[study.index]);
  }

  function showCard() {
    const w = currentCard();
    if (!w) return finishStudy();
    study.flipped = false;
    study.revealed = false;
    $('#card').classList.remove('flipped');
    $('#rate-buttons').hidden = true;

    $('#card-badge').textContent = w.source === 'extra' ? 'Extra' : 'Mine';
    $('#card-term').textContent = w.term;
    $('#card-pos').textContent = w.pos;
    $('#card-term-back').textContent = w.term + (w.pos ? ` (${w.pos})` : '');
    $('#card-def').textContent = w.definition || 'No definition yet — edit the word or use Auto-fill.';
    $('#card-ar').textContent = w.arabic || '';
    $('#card-syn').innerHTML = w.synonyms.map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">—</span>';
    $('#card-ant').innerHTML = w.antonyms.map((s) => `<span class="chip ant">${esc(s)}</span>`).join('') || '<span class="muted">—</span>';
    $('#card-ex').innerHTML = w.examples.map((x) => `<p>${highlight(x, w.term)}</p>`).join('');

    const remaining = study.queue.length - study.index;
    $('#study-counter').textContent = `${remaining} card${remaining === 1 ? '' : 's'} left`;
    const done = Math.min(study.index, study.total);
    $('#study-progress-bar').style.width = `${(done / Math.max(study.queue.length, 1)) * 100}%`;
  }

  function flip() {
    if ($('#study-area').hidden) return;
    study.flipped = !study.flipped;
    $('#card').classList.toggle('flipped', study.flipped);
    if (study.flipped) {
      study.revealed = true;
      $('#rate-buttons').hidden = false;
    }
  }

  function bumpDaily() {
    const d = today();
    state.daily[d] = (state.daily[d] || 0) + 1;
  }

  // rating: 0 again, 1 hard, 2 good, 3 easy
  function rate(rating) {
    const w = currentCard();
    if (!w || !study.revealed) return;
    const now = Date.now();
    if (rating === 0) {
      w.box = 0;
      w.wrong++;
      w.due = now;
      study.queue.push(w.id); // see it again this session
    } else {
      w.correct++;
      if (rating === 2) w.box = Math.min(w.box + 1, INTERVALS.length - 1);
      if (rating === 3) w.box = Math.min(w.box + 2, INTERVALS.length - 1);
      const days = INTERVALS[w.box] * (rating === 1 ? 0.5 : 1);
      w.due = now + Math.max(days * DAY, rating === 1 ? DAY / 2 : DAY / 4);
    }
    bumpDaily();
    save();
    study.index++;
    showCard();
  }

  function finishStudy() {
    $('#study-area').hidden = true;
    $('#view-study').classList.remove('in-session');
    const done = $('#study-done');
    done.hidden = false;
    done.innerHTML = `<b>Session complete!</b><br>You reviewed ${study.total} card${study.total === 1 ? '' : 's'}. ` +
      'Come back later for the cards that are due next.';
    renderStudyStats();
  }

  $('#card').addEventListener('click', (e) => {
    if (e.target.closest('#card-speak')) return;
    flip();
  });
  $('#study-end').addEventListener('click', () => {
    study.total = Math.min(study.index, study.total);
    finishStudy();
  });
  $('#card-speak').addEventListener('click', (e) => {
    e.stopPropagation();
    const w = currentCard();
    if (w) speak(w.term);
  });
  $('#rate-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rate]');
    if (b) rate(Number(b.dataset.rate));
  });

  // ---------- Quiz ----------

  const quiz = { questions: [], index: 0, score: 0, answered: false };

  // Pool of plausible wrong answers: every term and synonym we know, plus the TOEFL list.
  function distractorPool() {
    const pool = [];
    for (const w of state.words) pool.push(w.term, ...w.synonyms);
    pool.push(...(window.TOEFL_WORDS || []));
    return uniq(pool);
  }

  function pickDistractors(correct, exclude, preferred, pool) {
    const banned = new Set([correct, ...exclude].map(norm));
    const out = [];
    for (const cand of [...shuffle(preferred), ...shuffle(pool)]) {
      if (out.length === 3) break;
      if (!banned.has(norm(cand))) {
        out.push(cand);
        banned.add(norm(cand));
      }
    }
    return out;
  }

  function buildQuestion(w, type, deckWords, pool) {
    const related = [w.term, ...w.synonyms, ...w.antonyms];
    const otherTerms = deckWords.filter((x) => x.id !== w.id).map((x) => x.term);
    let prompt, correct, distractors;

    if (type === 'synonym') {
      correct = shuffle(w.synonyms)[0];
      prompt = `Which word is closest in meaning to <b>${esc(w.term)}</b>?`;
      distractors = pickDistractors(correct, related, deckWords.flatMap((x) => x.id === w.id ? [] : x.synonyms), pool);
    } else if (type === 'antonym') {
      correct = shuffle(w.antonyms)[0];
      prompt = `Which word is most nearly <b>opposite</b> in meaning to <b>${esc(w.term)}</b>?`;
      distractors = pickDistractors(correct, related, w.synonyms.concat(otherTerms), pool);
    } else if (type === 'definition') {
      correct = w.term;
      prompt = `Which word matches this definition?<br><i>“${esc(w.definition)}”</i>`;
      const samePos = deckWords.filter((x) => x.id !== w.id && x.pos && x.pos === w.pos).map((x) => x.term);
      distractors = pickDistractors(correct, related, samePos.length >= 3 ? samePos : otherTerms, pool);
    } else if (type === 'arabic') {
      correct = w.term;
      prompt = `Which word means <span class="arabic" dir="rtl">${esc(w.arabic)}</span>?`;
      distractors = pickDistractors(correct, related, otherTerms, pool);
    } else {
      const ex = shuffle(w.examples.filter((x) => termRegex(w.term).test(x)))[0];
      correct = w.term;
      prompt = `Complete the sentence:<br><i>“${esc(ex).replace(termRegex(esc(w.term)), '_____')}”</i>`;
      const samePos = deckWords.filter((x) => x.id !== w.id && x.pos && x.pos === w.pos).map((x) => x.term);
      distractors = pickDistractors(correct, related, samePos.length >= 3 ? samePos : otherTerms, pool);
    }
    return { wordId: w.id, prompt, correct, options: shuffle([correct, ...distractors]) };
  }

  const QUIZ_TYPES = {
    synonym: (w) => w.synonyms.length > 0,
    antonym: (w) => w.antonyms.length > 0,
    definition: (w) => !!w.definition,
    sentence: (w) => w.examples.some((x) => termRegex(w.term).test(x)),
    arabic: (w) => !!w.arabic,
  };

  $('#quiz-start').addEventListener('click', () => {
    const deckWords = wordsIn($('#quiz-deck').value);
    const type = $('#quiz-type').value;
    const count = Number($('#quiz-count').value);
    const types = type === 'mixed' ? Object.keys(QUIZ_TYPES) : [type];

    // Every (word, type) pair that has enough data, then pick a varied sample.
    const pairs = shuffle(deckWords.flatMap((w) => types.filter((t) => QUIZ_TYPES[t](w)).map((t) => ({ w, t }))));
    const chosen = [];
    const usedWords = new Set();
    for (const p of pairs) {          // first pass: one question per word
      if (chosen.length >= count) break;
      if (!usedWords.has(p.w.id)) { chosen.push(p); usedWords.add(p.w.id); }
    }
    for (const p of pairs) {          // second pass: fill up if the deck is small
      if (chosen.length >= count) break;
      if (!chosen.includes(p)) chosen.push(p);
    }

    if (!chosen.length) {
      $('#quiz-area').hidden = true;
      $('#quiz-msg').hidden = false;
      return toast('Not enough word details for this quiz type');
    }
    const pool = distractorPool();
    quiz.questions = shuffle(chosen).map(({ w, t }) => buildQuestion(w, t, deckWords, pool));
    quiz.index = 0;
    quiz.score = 0;
    $('#quiz-msg').hidden = true;
    $('#quiz-area').hidden = false;
    showQuestion();
  });

  function showQuestion() {
    const q = quiz.questions[quiz.index];
    quiz.answered = false;
    $('#quiz-counter').textContent = `Question ${quiz.index + 1} of ${quiz.questions.length} · Score ${quiz.score}`;
    $('#quiz-prompt').innerHTML = q.prompt;
    $('#quiz-feedback').textContent = '';
    $('#quiz-feedback').className = 'feedback';
    $('#quiz-next').hidden = true;
    $('#quiz-options').innerHTML = q.options
      .map((o, i) => `<button data-i="${i}"><kbd>${i + 1}</kbd> ${esc(o)}</button>`).join('');
  }

  function answer(i) {
    const q = quiz.questions[quiz.index];
    if (quiz.answered || !q || i >= q.options.length) return;
    quiz.answered = true;
    const ok = q.options[i] === q.correct;
    const w = state.words.find((x) => x.id === q.wordId);
    const buttons = $$('#quiz-options button');
    buttons.forEach((b, j) => {
      b.disabled = true;
      if (q.options[j] === q.correct) b.classList.add('correct');
    });
    if (!ok) buttons[i].classList.add('wrong');

    if (ok) quiz.score++;
    if (w) {
      if (ok) w.correct++;
      else { w.wrong++; w.box = Math.max(0, w.box - 1); w.due = Date.now(); }
      bumpDaily();
      save();
    }
    const fb = $('#quiz-feedback');
    fb.className = `feedback ${ok ? 'ok' : 'no'}`;
    fb.textContent = (ok ? 'Correct! ' : `Not quite — the answer is “${q.correct}”. `) +
      (w ? `${w.term}${w.definition ? ': ' + w.definition : ''}` : '');
    const next = $('#quiz-next');
    next.hidden = false;
    next.textContent = quiz.index + 1 < quiz.questions.length ? 'Next →' : 'See results';
    next.focus();
  }

  function nextQuestion() {
    if (!quiz.answered) return;
    quiz.index++;
    if (quiz.index < quiz.questions.length) return showQuestion();
    const pct = Math.round((quiz.score / quiz.questions.length) * 100);
    $('#quiz-area').hidden = true;
    const msg = $('#quiz-msg');
    msg.hidden = false;
    msg.innerHTML = `<b>Quiz finished: ${quiz.score}/${quiz.questions.length} (${pct}%)</b><br>` +
      (pct >= 80 ? 'Great work!' : 'Words you missed are now due in Flashcards — review them there.');
  }

  $('#quiz-options').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) answer(Number(b.dataset.i));
  });
  $('#quiz-next').addEventListener('click', nextQuestion);

  // ---------- Keyboard ----------

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || $('#edit-dialog').open) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const active = $('.view.active').id;

    if (active === 'view-study' && !$('#study-area').hidden) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      else if (/^[1-4]$/.test(e.key)) rate(Number(e.key) - 1);
    } else if (active === 'view-quiz' && !$('#quiz-area').hidden) {
      if (/^[1-4]$/.test(e.key)) answer(Number(e.key) - 1);
      else if (e.key === 'Enter' && quiz.answered) { e.preventDefault(); nextQuestion(); }
    }
  });

  // ---------- Stats & backup ----------

  function streak() {
    let n = 0;
    const d = new Date();
    if (!state.daily[today()]) d.setDate(d.getDate() - 1); // today not started yet
    while (state.daily[d.toISOString().slice(0, 10)]) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  function renderStats() {
    const mine = wordsIn('mine');
    const extra = wordsIn('extra');
    const all = state.words;
    const correct = all.reduce((s, w) => s + w.correct, 0);
    const wrong = all.reduce((s, w) => s + w.wrong, 0);
    const stats = [
      ['My words', mine.length],
      ['Extra words', extra.length],
      ['Mastered', all.filter((w) => w.box >= MASTERED_BOX).length],
      ['Due now', all.filter((w) => w.due <= Date.now()).length],
      ['Reviews today', state.daily[today()] || 0],
      ['Day streak', streak()],
      ['Accuracy', correct + wrong ? `${Math.round((correct / (correct + wrong)) * 100)}%` : '—'],
    ];
    $('#progress-stats').innerHTML = stats
      .map(([label, value]) => `<div class="stat"><b>${value}</b><span class="muted">${label}</span></div>`).join('');
  }

  $('#export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `toefl-vocab-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.words)) throw new Error('missing "words" list');
      if (!confirm(`Replace your current ${state.words.length} words with ${data.words.length} words from the backup?`)) return;
      state = {
        version: 1,
        daily: data.daily || {},
        notebookTerms: Array.isArray(data.notebookTerms) ? data.notebookTerms : allNotebookTerms(),
        words: data.words.filter((w) => w && w.term).map((w) => ({
          ...makeWord({ term: String(w.term) }, w.source === 'extra' ? 'extra' : 'mine'),
          ...w,
          synonyms: Array.isArray(w.synonyms) ? w.synonyms : [],
          antonyms: Array.isArray(w.antonyms) ? w.antonyms : [],
          examples: Array.isArray(w.examples) ? w.examples : [],
        })),
      };
      save();
      renderStats();
      toast(`Restored ${state.words.length} words`);
    } catch (err) {
      toast('Could not read backup: ' + err.message);
    }
  });

  $('#reset-all').addEventListener('click', () => {
    if (!confirm('Delete ALL words and progress? Export a backup first if you want to keep them.')) return;
    state = { version: 1, words: [], daily: {}, notebookTerms: allNotebookTerms() };
    save();
    renderStats();
    toast('Everything deleted');
  });

  // ---------- Notebook words ----------

  // Format per line: word | synonyms | antonyms | Arabic meaning | example
  function notebookEntries() {
    return String(window.NOTEBOOK_WORDS || '').split('\n')
      .map((line) => line.split('|').map((c) => c.trim()))
      .filter((cols) => cols[0])
      .map(([term, syn, ant, arabic, example]) => ({
        term,
        synonyms: splitList(syn),
        antonyms: splitList(ant),
        arabic: arabic || '',
        examples: example ? [example] : [],
      }));
  }

  // Details for the notebook words (data/notebook-details.js) only fill fields
  // that are still empty, so anything typed or edited by hand is kept.
  const DETAILS = window.NOTEBOOK_DETAILS || { version: 0, words: {} };

  function fillDetails(w) {
    const d = DETAILS.words[norm(w.term)];
    if (!d) return false;
    let changed = false;
    if (!w.pos && d.pos) { w.pos = d.pos; changed = true; }
    if (!w.definition && d.definition) { w.definition = d.definition; changed = true; }
    if (!w.arabic && d.arabic) { w.arabic = d.arabic; changed = true; }
    if (!w.antonyms.length && d.antonyms?.length) { w.antonyms = d.antonyms.slice(); changed = true; }
    if (!w.examples.length && d.example) { w.examples = [d.example]; changed = true; }
    return changed;
  }

  function applyDetails() {
    if ((state.detailsVersion || 0) >= DETAILS.version) return 0;
    let n = 0;
    for (const w of state.words) if (fillDetails(w)) n++;
    state.detailsVersion = DETAILS.version;
    save();
    return n;
  }

  // Remembers which notebook words were already loaded, so words added to the
  // notebook file later are picked up without bringing back deleted ones.
  function loadNotebook(onlyNew) {
    const seen = new Set(state.notebookTerms || []);
    let added = 0;
    for (const f of notebookEntries()) {
      if (onlyNew && seen.has(norm(f.term))) continue;
      const r = upsert(f, 'mine');
      if (r.status === 'added') added++;
      fillDetails(r.word);
      seen.add(norm(f.term));
    }
    state.notebookTerms = [...seen];
    save();
    return added;
  }

  const allNotebookTerms = () => uniq(notebookEntries().map((f) => norm(f.term)));

  $('#load-notebook').addEventListener('click', () => {
    const added = loadNotebook(false);
    renderStats();
    toast(`Added ${added} new notebook words (others were merged)`);
  });

  // ---------- Init ----------

  // Offline support and installability ("Add to Home Screen").
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Ask the browser not to clear saved words when storage runs low.
  navigator.storage?.persist?.().catch(() => {});

  {
    const added = loadNotebook(true);
    const filled = applyDetails();
    if (added) toast(`Loaded ${added} new words from your notebook`);
    else if (filled) toast(`Added definitions, examples and antonyms to ${filled} words`);
  }
  renderStudyStats();
})();
