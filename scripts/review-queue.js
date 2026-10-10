/**
 * File d'attente de revue manuelle — SCRIPT EN LECTURE SEULE
 *
 * La BnF ne catalogue qu'environ 76 % des ouvrages : un livre absent de la BnF
 * n'est pas forcément introuvable. Ce script liste donc les livres que le
 * pipeline n'a pas su traiter, pour qu'ils soient vérifiés à la main plutôt
 * que laissés avec une couverture approximative.
 *
 * Il n'écrit jamais dans books-metadata.json ni dans metadata-overrides.json.
 *
 * Usage :
 *   node scripts/review-queue.js               liste complète
 *   node scripts/review-queue.js --limit=50    n'affiche que les 50 premiers
 *   node scripts/review-queue.js --template    affiche un gabarit à remplir
 *   node scripts/review-queue.js --no-cover    ne liste que les manques de couverture
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METADATA_FILE = path.join(ROOT, 'books-metadata.json');
const OVERRIDES_FILE = path.join(ROOT, 'metadata-overrides.json');
const SHEET_URL = 'https://opensheet.elk.sh/1I8a83wLjYIDC-hWWH7yFj6i7R-GAwVy2SzORD_JNhgY/1';

const args = process.argv.slice(2);
const getVal = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
const LIMIT = getVal('limit') ? parseInt(getVal('limit'), 10) : Infinity;
const TEMPLATE = args.includes('--template');
const NO_COVER_ONLY = args.includes('--no-cover');

// slugify identique à celui d'index.html, pour retrouver la ligne de la Sheet
const slugify = (t) => (t
  ? t.toString().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-_]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
  : '');

async function main() {
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ books-metadata.json introuvable.');
    process.exit(1);
  }
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));

  // Les corrections validées à la main sont fusionnées comme le fait le site,
  // sinon la file afficherait des livres déjà corrigés.
  let overrides = {};
  if (fs.existsSync(OVERRIDES_FILE)) {
    try {
      overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
    } catch (e) {
      console.warn('⚠️ metadata-overrides.json illisible :', e.message);
    }
  }
  for (const slug of Object.keys(overrides)) {
    metadata[slug] = Object.assign({}, metadata[slug] || {}, overrides[slug]);
  }

  // Index de la Sheet, pour indiquer à quel ligne se corriger
  let sheetRows = null;
  try {
    const rows = await (await fetch(SHEET_URL)).json();
    sheetRows = {};
    rows.forEach((b, i) => {
      const nom = ((b['Prénom'] || '') + ' ' + (b.Famille || '')).trim() || b.Auteur || '';
      const key = slugify((b.Titre || '') + ' ' + nom);
      if (!sheetRows[key]) sheetRows[key] = { row: i + 2, titre: b.Titre, auteur: nom };
    });
    console.log(`📋 ${rows.length} livres dans la Sheet, ${Object.keys(metadata).length} entrées de métadonnées.\n`);
  } catch (e) {
    console.warn('⚠️ Sheet injoignable, les numéros de ligne ne seront pas indiqués :', e.message, '\n');
  }

  // Un livre a besoin d'une revue s'il n'a pas de couverture, ou s'il n'a pas
  // été confirmé par la BnF alors qu'aucune source n'a rien donné.
  const queue = [];
  for (const slug of Object.keys(metadata)) {
    const e = metadata[slug];
    if (e.source === 'override') continue; // déjà tranché à la main
    const noCover = !e.coverUrl;
    if (NO_COVER_ONLY && !noCover) continue;
    if (!noCover && !e.needsReview) continue;
    queue.push({
      slug,
      titre: e.title,
      auteur: e.author,
      source: e.source,
      cover: e.coverUrl || '',
      isbn: e.isbn || '',
      publisher: e.publisher || '',
      publishedDate: e.publishedDate || '',
      description: e.description || '',
      motif: noCover ? 'couverture manquante' : 'non confirmé par la BnF'
    });
  }

  console.log('================ FILE DE REVUE ================');
  console.log(`  ${queue.length} livre(s) à vérifier\n`);

  const shown = queue.slice(0, LIMIT);
  for (const q of shown) {
    const line = sheetRows && sheetRows[q.slug] ? sheetRows[q.slug].row : '?';
    console.log(`  ${q.slug}`);
    console.log(`     ${q.titre} — ${q.auteur}`);
    console.log(`     motif=${q.motif} | source=${q.source} | ligne Sheet=${line}`);
    if (q.publisher) console.log(`     éditeur : ${q.publisher}${q.publishedDate ? ' (' + q.publishedDate + ')' : ''}`);
    if (q.isbn) console.log(`     ISBN connu : ${q.isbn}`);
    if (q.cover) console.log(`     couverture actuelle : ${q.cover.slice(0, 70)}`);
    else console.log(`     couverture : AUCUNE (placeholder affiché)`);
    console.log('');
  }
  if (queue.length > shown.length) {
    console.log(`  ... et ${queue.length - shown.length} autres (utiliser --limit=N)\n`);
  }

  if (TEMPLATE) {
    console.log('================ GABARIT ================');
    console.log('Collez les corrections dans metadata-overrides.json, sous cette forme :\n');
    for (const q of shown.slice(0, 20)) {
      console.log(`  "${q.slug}": {`);
      console.log(`    "description": "",`);
      console.log(`    "genre": "Inconnu",`);
      console.log(`    "coverUrl": "https://covers.openlibrary.org/b/isbn/<ISBN>-M.jpg",`);
      console.log(`    "isbn": "",`);
      console.log(`    "verified": true,`);
      console.log(`    "source": "override"`);
      console.log(`  },`);
    }
    if (shown.length > 20) console.log(`  // ... et ${shown.length - 20} autres\n`);
    console.log('Une entrée "source": "override" est considérée comme tranchée :');
    console.log('le pipeline ne la retraite plus et elle n\'apparaît plus dans cette file.\n');
  }

  // Répartition par source, pour voir d'où vient le reliquat
  const bySource = {};
  for (const q of queue) bySource[q.source] = (bySource[q.source] || 0) + 1;
  console.log('Reliquat par source : ' + JSON.stringify(bySource));
}

main().catch((e) => { console.error('Erreur fatale :', e); process.exit(1); });
