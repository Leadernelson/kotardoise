/**
 * Audit des couvertures de livres — SCRIPT EN LECTURE SEULE
 *
 * But : détecter les entrées de books-metadata.json dont la couverture, la
 * description ou l'ISBN appartiennent à un autre ouvrage que celui demandé.
 *
 * Principe : chaque entrée est recoupée avec Open Library, puis le titre et
 * l'auteur trouvés sont comparés à ceux attendus. Un verdict est attribué :
 *   OK                 l'ouvrage trouvé correspond bien au livre demandé
 *   OK_EDITION         titre correct, auteur correct, mais Open Library renvoie
 *                      une autre édition (titre/code-barres différent)
 *   WRONG              auteur différent : la couverture est très probablement
 *                      celle d'un autre ouvrage (preuve solide)
 *   SUSPECT_SAME_AUTHOR même auteur, titre différent : présomption, à valider
 *   GENERIC_TITLE      titre trop générique ("Contes") : aucune conclusion possible
 *   UNVERIFIABLE       Open Library ne connaît pas cet ISBN, impossible de trancher
 *   MISSING_COVER      aucune couverture enregistrée pour ce livre
 *   SKIP               source "override" (déjà validé manuellement)
 *
 * Le script n'écrit JAMAIS dans books-metadata.json. Il produit un rapport
 * console et, en option, un fichier JSON de rapport.
 *
 * Usage :
 *   node scripts/audit-covers.js                 audit complet
 *   node scripts/audit-covers.js --limit=40      ne traiter que 40 entrées
 *   node scripts/audit-covers.js --only=WRONG    ne montrer que les suspects
 *   node scripts/audit-covers.js --resume        reprendre après une interruption
 *   node scripts/audit-covers.js --json=audit.json
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METADATA_FILE = path.join(ROOT, 'books-metadata.json');
const CACHE_FILE = path.join(ROOT, '.audit-cache.json');
const REPORT_FILE = path.join(ROOT, 'audit-report.json');

const REQUEST_DELAY = 400;
const MATCH_THRESHOLD = { title: 0.7, author: 0.6 };

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const getVal = (name) => {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=')[1] : null;
};
const LIMIT = getVal('limit') ? parseInt(getVal('limit'), 10) : Infinity;
const ONLY = (getVal('only') || '').toUpperCase();
const JSON_OUT = getVal('json');
const RESUME = hasFlag('--resume');

// --- Normalisation / scoring (mêmes règles que scripts/enrich-books.js) ---

function normalizeText(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Ligatures et caractères typographiques : "crève-cœur" == "crève-coeur"
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

function scoreTitle(want, got) {
  const a = significantTokens(want);
  const b = significantTokens(got);
  if (a.length === 0 || b.length === 0) return 0;
  const na = normalizeText(want);
  const nb = normalizeText(got);
  if (na === nb) return 1;
  // Insensible aux tirets et aux espaces : "crève-coeur" == "crève cœur"
  const squash = (s) => s.replace(/\s+/g, '');
  if (squash(na) === squash(nb)) return 1;
  // Tolérance aux sous-titres, mais seulement si le titre recherché est assez
  // discriminant : sinon "Interface" matcherait "... Surfaces and Interfaces"
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
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'KotArdoiseLibraryBot/2.0 (contact: info@kotardoise.be)' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            if (res.statusCode === 429 || res.statusCode >= 500) {
              if (retries > 0) { setTimeout(() => resolve(httpGetJson(url, retries - 1)), 1200); return; }
            }
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      })
      .on('error', (err) => {
        if (retries > 0) { setTimeout(() => resolve(httpGetJson(url, retries - 1)), 1200); return; }
        reject(err);
      });
  });
}

// --- Audit d'une entrée ---

async function auditEntry(slug, entry) {
  const wantTitle = entry.title || '';
  const wantAuthor = entry.author || '';

  const row = {
    slug,
    wantTitle,
    wantAuthor,
    storedIsbn: entry.isbn || '',
    storedCover: entry.coverUrl || '',
    source: entry.source || '',
    verdict: '',
    foundTitle: '',
    foundAuthor: '',
    foundIsbn: '',
    suggestedCover: '',
    titleScore: 0,
    authorScore: 0
  };

  if (entry.source === 'override') {
    row.verdict = 'SKIP';
    return row;
  }
  if (!entry.coverUrl) {
    row.verdict = 'MISSING_COVER';
    return row;
  }

  const isbn = (entry.isbn || '').trim();
  let doc = null;

  if (isbn) {
    // Recoupement par ISBN : c'est la preuve la plus fiable
    const data = await httpGetJson(`https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=5`);
    if (data && data.docs && data.docs.length > 0) {
      // Laisser le scoring trancher entre plusieurs éditions du même ISBN
      let best = null;
      for (const d of data.docs) {
        const authors = Array.isArray(d.author_name) ? d.author_name.join(' ') : (d.author_name || '');
        const t = scoreTitle(wantTitle, d.title || '');
        const a = scoreAuthor(wantAuthor, authors);
        if (!best || t + a > best.t + best.a) best = { d, t, a };
      }
      doc = best;
    }
  } else {
    // Sans ISBN : recherche par titre + auteur
    const q = encodeURIComponent(`title:${wantTitle} author:${wantAuthor}`);
    const data = await httpGetJson(`https://openlibrary.org/search.json?q=${q}&limit=5`);
    if (data && data.docs && data.docs.length > 0) {
      let best = null;
      for (const d of data.docs) {
        const authors = Array.isArray(d.author_name) ? d.author_name.join(' ') : (d.author_name || '');
        const t = scoreTitle(wantTitle, d.title || '');
        const a = scoreAuthor(wantAuthor, authors);
        if (!best || t + a > best.t + best.a) best = { d, t, a };
      }
      doc = best;
    }
  }

  if (!doc) {
    row.verdict = 'UNVERIFIABLE';
    return row;
  }

  row.foundTitle = doc.d.title || '';
  row.foundAuthor = Array.isArray(doc.d.author_name) ? doc.d.author_name.join(', ') : (doc.d.author_name || '');
  row.foundIsbn = doc.d.isbn ? doc.d.isbn[0] || '' : '';
  row.titleScore = Math.round(doc.t * 100) / 100;
  row.authorScore = Math.round(doc.a * 100) / 100;
  if (doc.d.cover_i) {
    row.suggestedCover = `https://covers.openlibrary.org/b/id/${doc.d.cover_i}-L.jpg`;
  }

  const titleOk = doc.t >= MATCH_THRESHOLD.title;
  const authorOk = !wantAuthor || doc.a >= MATCH_THRESHOLD.author;

  if (titleOk && authorOk) {
    row.verdict = 'OK';
  } else if (significantTokens(wantTitle).length < 2) {
    // "Contes", "Nouvelles" : trop générique pour conclure quoi que ce soit
    row.verdict = 'GENERIC_TITLE';
  } else if (titleOk) {
    // L'auteur concorde et le titre est bon : l'écart vient d'une édition
    // ou d'un titre étranger, mais le livre est bien le bon
    row.verdict = 'OK_EDITION';
  } else if (authorOk) {
    // Même auteur, titre différent : présomption forte mais pas une preuve
    // (édition alternative, ou simplement un autre ouvrage du même auteur)
    row.verdict = 'SUSPECT_SAME_AUTHOR';
  } else {
    // Auteur différent : la couverture appartient très probablement à un autre livre
    row.verdict = 'WRONG';
  }
  return row;
}

// --- Exécution ---

async function main() {
  console.log('🔍 Audit des couvertures (lecture seule, aucune écriture dans books-metadata.json)\n');

  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ books-metadata.json introuvable.');
    process.exit(1);
  }
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  const slugs = Object.keys(metadata);
  console.log(`📦 ${slugs.length} entrées analysées.`);

  let cache = {};
  if (RESUME && fs.existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch (e) { cache = {}; }
    console.log(`♻️  Reprise : ${Object.keys(cache).length} entrées déjà auditées.\n`);
  }

  const rows = [];
  let processed = 0;
  const skipped = [];

  for (const slug of slugs) {
    if (processed >= LIMIT) { skipped.push(slug); continue; }
    const entry = metadata[slug];

    if (entry.source === 'override') {
      rows.push({ slug, verdict: 'SKIP', wantTitle: entry.title, wantAuthor: entry.author, source: entry.source });
      continue;
    }
    if (!entry.coverUrl) {
      rows.push({ slug, verdict: 'MISSING_COVER', wantTitle: entry.title, wantAuthor: entry.author, storedCover: '', source: entry.source });
      continue;
    }

    const cached = cache[slug];
    if (cached) {
      rows.push(cached);
      processed++;
      continue;
    }

    let row;
    try {
      row = await auditEntry(slug, entry);
    } catch (e) {
      row = { slug, verdict: 'ERROR', wantTitle: entry.title, wantAuthor: entry.author, source: entry.source, error: e.message };
    }
    rows.push(row);
    cache[slug] = row;
    processed++;

    if (processed % 25 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      process.stdout.write(`  ... ${processed} traités\n`);
    }
    await sleep(REQUEST_DELAY);
  }

  // Regroupement
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  console.log('\n=================== RÉSUMÉ ===================');
  for (const k of Object.keys(counts).sort()) {
    console.log(`  ${k.padEnd(14)} ${counts[k]}`);
  }
  console.log('===============================================');

  const suspects = rows.filter((r) => r.verdict === 'WRONG' || r.verdict === 'SUSPECT_SAME_AUTHOR' || r.verdict === 'GENERIC_TITLE');
  if (suspects.length > 0) {
    console.log(`\n🚨 COUVERTURES SUSPECTES (${suspects.length}) :\n`);
    for (const r of suspects) {
      console.log(`  [${r.verdict}] ${r.slug}`);
      console.log(`     attendu : ${r.wantTitle} — ${r.wantAuthor}`);
      console.log(`     trouvé  : ${r.foundTitle} — ${r.foundAuthor}`);
      console.log(`     ISBN    : stocké ${r.storedIsbn || '(aucun)'} / trouvé ${r.foundIsbn || '(aucun)'}`);
      console.log(`     score   : titre ${r.titleScore} / auteur ${r.authorScore}`);
      if (r.suggestedCover) console.log(`     correcte: ${r.suggestedCover}`);
      console.log('');
    }
  }

  const missing = rows.filter((r) => r.verdict === 'MISSING_COVER');
  if (missing.length > 0 && (!ONLY || ONLY === 'MISSING_COVER')) {
    console.log(`\n📭 COUVERTURES MANQUANTES (${missing.length}) :\n`);
    for (const r of missing.slice(0, 40)) {
      console.log(`  ${r.slug}  —  ${r.wantTitle} — ${r.wantAuthor}`);
    }
    if (missing.length > 40) console.log(`  ... et ${missing.length - 40} autres`);
    console.log('');
  }

  const unverifiable = rows.filter((r) => r.verdict === 'UNVERIFIABLE');
  console.log(`\nℹ️  Non vérifiables (Open Library ignore l'ISBN) : ${unverifiable.length}`);

  if (skipped.length > 0) {
    console.log(`\n⏭️  ${skipped.length} entrées non traitées (--limit). Relancer avec --resume pour continuer.`);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } else {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  const outFile = JSON_OUT || REPORT_FILE;
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 2));
  console.log(`\n📄 Rapport complet : ${outFile}`);
}

main().catch((e) => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});