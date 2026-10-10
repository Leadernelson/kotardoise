/**
 * Récupération des couvertures manquantes — SCRIPT EN LECTURE SEULE
 *
 * Pour chaque entrée de books-metadata.json qui n'a pas de couverture, cherche
 * le bon ouvrage sur Open Library et ne propose une couverture que si le titre
 * ET l'auteur correspondent (mêmes règles de scoring que scripts/audit-covers.js).
 *
 * Le script n'écrit JAMAIS dans books-metadata.json ni dans metadata-overrides.json :
 * il produit un rapport JSON à relire avant toute application.
 *
 * Usage :
 *   node scripts/recover-covers.js                  toutes les entrées sans couverture
 *   node scripts/recover-covers.js --limit=50       ne traiter que 50 entrées
 *   node scripts/recover-covers.js --resume         reprendre après une interruption
 *   node scripts/recover-covers.js --json=recover-covers-report.json
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METADATA_FILE = path.join(ROOT, 'books-metadata.json');
const CACHE_FILE = path.join(ROOT, '.recover-covers-cache.json');

const REQUEST_DELAY = 400;
const MATCH_THRESHOLD = { title: 0.7, author: 0.6 };

const args = process.argv.slice(2);
const getVal = (name) => {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=')[1] : null;
};
const LIMIT = getVal('limit') ? parseInt(getVal('limit'), 10) : Infinity;
const JSON_OUT = getVal('json') || path.join(ROOT, 'recover-covers-report.json');
const RESUME = args.includes('--resume');

// --- Normalisation / scoring (alignés sur enrich-books.js et audit-covers.js) ---

function normalizeText(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'et', 'au', 'aux',
  'en', 'sur', 'dans', 'pour', 'par', 'tome', 'vol', 'volume', 'livre',
  'partie', 'edition', 'ed', 'the', 'a', 'an', 'of', 'and', 'or', 'to'
]);

function significantTokens(text) {
  return normalizeText(text).split(' ').filter((t) => t.length > 1 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

function tokenMatch(x, y) {
  if (x === y) return true;
  return x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x));
}

// Retire tous les espaces : "crève-coeur" == "crève cœur"
const squash = (s) => s.replace(/\s+/g, '');

function scoreTitle(want, got) {
  const a = significantTokens(want);
  const b = significantTokens(got);
  if (a.length === 0 || b.length === 0) return 0;
  const na = normalizeText(want);
  const nb = normalizeText(got);
  if (na === nb) return 1;
  if (squash(na) === squash(nb)) return 1;
  if (a.length >= 3 && na && nb && (nb.includes(na) || na.includes(nb))) return 0.9;
  const used = new Set();
  let hits = 0;
  for (const t of a) {
    const idx = b.findIndex((u, i) => !used.has(i) && tokenMatch(t, u));
    if (idx !== -1) { used.add(idx); hits++; }
  }
  return (2 * hits) / (a.length + b.length);
}

function scoreAuthor(want, got) {
  const a = significantTokens(want);
  const b = significantTokens(got);
  if (a.length === 0 || b.length === 0) return 0;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  if (lastA === lastB) return 1;
  if (tokenMatch(lastA, lastB)) return 0.9;
  const used = new Set();
  let hits = 0;
  for (const t of a) {
    const idx = b.findIndex((u, i) => !used.has(i) && t.length > 1 && tokenMatch(t, u));
    if (idx !== -1) { used.add(idx); hits++; }
  }
  const partial = (2 * hits) / (a.length + b.length);
  const surnameShared = (b.includes(lastA) || a.includes(lastB)) ? 0.7 : 0;
  return Math.max(partial, surnameShared);
}

// --- Réseau ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url, retries = 2) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'KotArdoiseLibraryBot/2.0 (contact: info@kotardoise.be)' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            if ((res.statusCode === 429 || res.statusCode >= 500) && retries > 0) {
              setTimeout(() => resolve(httpGetJson(url, retries - 1)), 1200);
              return;
            }
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      })
      .on('error', () => {
        if (retries > 0) { setTimeout(() => resolve(httpGetJson(url, retries - 1)), 1200); return; }
        resolve(null);
      });
  });
}

// --- Traitement d'une entrée ---

async function recover(slug, entry) {
  const wantTitle = entry.title || '';
  const wantAuthor = entry.author || '';
  const row = {
    slug,
    wantTitle,
    wantAuthor,
    verdict: '',
    foundTitle: '',
    foundAuthor: '',
    suggestedCover: '',
    suggestedIsbn: '',
    titleScore: 0,
    authorScore: 0
  };

  if (entry.source === 'override') { row.verdict = 'SKIP'; return row; }

  // Recherche ciblée titre + auteur, en privilégiant les éditions françaises
  const q = encodeURIComponent(`title:${wantTitle} author:${wantAuthor}`);
  let data = await httpGetJson(`https://openlibrary.org/search.json?q=${q}&limit=10`);

  // Si le filtre langue ne donne rien, nouvelle tentative sans
  if ((!data || !data.docs || data.docs.length === 0)) {
    const q2 = encodeURIComponent(`title:${wantTitle} author:${wantAuthor}`);
    data = await httpGetJson(`https://openlibrary.org/search.json?q=${q2}&limit=10`);
  }

  if (!data || !data.docs || data.docs.length === 0) {
    row.verdict = 'NOT_FOUND';
    return row;
  }

  let best = null;
  for (const d of data.docs) {
    if (!d || !d.title) continue;
    const authors = Array.isArray(d.author_name) ? d.author_name.join(' ') : (d.author_name || '');
    const t = scoreTitle(wantTitle, d.title);
    const a = scoreAuthor(wantAuthor, authors);
    const total = t + a;
    if (!best || total > best.total) best = { d, t, a, total };
  }

  if (!best) { row.verdict = 'NOT_FOUND'; return row; }

  row.foundTitle = best.d.title || '';
  row.foundAuthor = Array.isArray(best.d.author_name) ? best.d.author_name.join(', ') : (best.d.author_name || '');
  row.titleScore = Math.round(best.t * 100) / 100;
  row.authorScore = Math.round(best.a * 100) / 100;
  if (best.d.isbn && best.d.isbn.length) row.suggestedIsbn = best.d.isbn[0] || '';

  const titleOk = best.t >= MATCH_THRESHOLD.title;
  const authorOk = !wantAuthor || best.a >= MATCH_THRESHOLD.author;

  if (!titleOk || !authorOk) {
    row.verdict = 'NO_CONFIDENT_MATCH';
    return row;
  }
  if (!best.d.cover_i) {
    row.verdict = 'MATCH_BUT_NO_COVER';
    return row;
  }

  row.suggestedCover = `https://covers.openlibrary.org/b/id/${best.d.cover_i}-L.jpg`;
  row.verdict = 'RECOVERED';
  return row;
}

async function main() {
  console.log('🔎 Recherche des couvertures manquantes (lecture seule)\n');

  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ books-metadata.json introuvable.');
    process.exit(1);
  }
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));

  const targets = Object.keys(metadata).filter((s) => {
    const e = metadata[s];
    return !e.coverUrl && e.source !== 'override';
  });
  console.log(`📦 ${targets.length} entrées sans couverture.`);

  let cache = {};
  if (RESUME && fs.existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch (e) { cache = {}; }
    console.log(`♻️  Reprise : ${Object.keys(cache).length} entrées déjà traitées.\n`);
  }

  const rows = [];
  let processed = 0;

  for (const slug of targets) {
    if (processed >= LIMIT) break;
    if (cache[slug]) { rows.push(cache[slug]); processed++; continue; }

    let row;
    try {
      row = await recover(slug, metadata[slug]);
    } catch (e) {
      row = { slug, wantTitle: metadata[slug].title, wantAuthor: metadata[slug].author, verdict: 'ERROR', error: e.message };
    }
    rows.push(row);
    cache[slug] = row;
    processed++;

    if (processed % 25 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      process.stdout.write(`  ... ${processed}/${targets.length}\n`);
    }
    await sleep(REQUEST_DELAY);
  }

  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  console.log('\n=============== RÉSUMÉ ===============');
  for (const k of Object.keys(counts).sort()) {
    console.log(`  ${k.padEnd(22)} ${counts[k]}`);
  }
  console.log('====================================');

  const recovered = rows.filter((r) => r.verdict === 'RECOVERED');
  if (recovered.length > 0) {
    console.log(`\n✅ ${recovered.length} couvertures récupérées :\n`);
    for (const r of recovered.slice(0, 30)) {
      console.log(`  ${r.slug}`);
      console.log(`     ${r.wantTitle} — ${r.wantAuthor}`);
      console.log(`     -> ${r.foundTitle} — ${r.foundAuthor}  (titre ${r.titleScore} / auteur ${r.authorScore})`);
      console.log(`     ${r.suggestedCover}`);
    }
    if (recovered.length > 30) console.log(`  ... et ${recovered.length - 30} autres`);
    console.log('');
  }

  const partial = rows.filter((r) => r.verdict === 'NO_CONFIDENT_MATCH');
  if (partial.length > 0) {
    console.log(`\n❓ ${partial.length} entrées sans correspondance fiable (titre ou auteur non concordants).\n`);
    for (const r of partial.slice(0, 15)) {
      console.log(`  ${r.slug} : "${r.wantTitle}" -> "${r.foundTitle}" (titre ${r.titleScore} / auteur ${r.authorScore})`);
    }
    if (partial.length > 15) console.log(`  ... et ${partial.length - 15} autres`);
    console.log('');
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 2));
  console.log(`\n📄 Rapport : ${JSON_OUT}`);
}

main().catch((e) => { console.error('Erreur fatale :', e); process.exit(1); });