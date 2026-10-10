/**
 * Nettoyage des métadonnées — SCRIPT ÉCRIVANT
 *
 * Deux opérations, sur les entrées de books-metadata.json :
 *
 * 1. Les descriptions non françaises (anglaises, néerlandaises, italiennes,
 *    indonésiennes…) sont vidées. Sur un catalogue francophone, afficher un
 *    résumé en anglais est une erreur de données, pas un contenu. Elles sont
 *    déplacées dans metadata-overrides.json avec description: "" — la valeur
 *    d'origine reste donc dans books-metadata.json et le nettoyage est
 *    réversible en retirant l'entrée de l'override.
 *
 * 2. Les éditeur / année issus de la BnF sont normalisés. Les notices sont
 *    brutes : "Livre de poche,] (impr. Brodard et Taupin)" ou "[s.d.?]".
 *
 * Usage :
 *   node scripts/cleanup-metadata.js            exécute le nettoyage
 *   node scripts/cleanup-metadata.js --dry-run  affiche sans écrire
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METADATA_FILE = path.join(ROOT, 'books-metadata.json');
const OVERRIDES_FILE = path.join(ROOT, 'metadata-overrides.json');

const DRY_RUN = process.argv.includes('--dry-run');

// --- Règles de langue (identiques à enrich-books.js) ---

const FRENCH_STOPWORDS = new Set(('le la les de des du un une et est en que qui dans pour au aux ce cette ' +
  'pas plus sur avec par son sa ses leur leurs nous vous ils elles ne se lui y comme tout tous bien aussi ' +
  'encore deja etre avoir faire ainsi donc alors même').split(' '));
const ENGLISH_STOPWORDS = new Set(('the a an and or but is are was were in on of to for with that this it as ' +
  'by from at be been has have had not which who its their his her they them we you i about into over than ' +
  'then some such only own same too very can will just should now').split(' '));
const LANG_MIN_DENSITY = 0.10;
const LANG_MIN_HITS = 4;

function detectLanguage(text) {
  if (!text || text.length < 40) return 'trop-court';
  const mots = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((m) => m.length > 1);
  if (mots.length < 8) return 'trop-court';
  let fr = 0;
  let en = 0;
  for (const m of mots) {
    if (FRENCH_STOPWORDS.has(m)) fr++;
    if (ENGLISH_STOPWORDS.has(m)) en++;
  }
  const densFr = fr / mots.length;
  const densEn = en / mots.length;
  if (en > fr && en >= LANG_MIN_HITS) return 'anglais';
  if (densFr >= LANG_MIN_DENSITY && fr >= LANG_MIN_HITS) return 'francais';
  if (densEn > densFr && en >= LANG_MIN_HITS) return 'anglais';
  return 'inconnu';
}

function isCatalogDumping(text) {
  if (!text) return false;
  return /^\s*Genre\s*\/\s*Form/i.test(text)
    || /Additional Physical Format/i.test(text)
    || /^\s*Topics?\s*:/i.test(text);
}

function cleanPublisher(value) {
  if (!value) return '';
  let v = value.trim();
  v = v.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  v = v.replace(/[\[\],]/g, ' ').replace(/\s+/g, ' ').trim();
  v = v.replace(/^(impr\.?|éditeur|éd\.|distrib\.?|librairie)\s+/i, '').trim();
  v = v.replace(/^\[(s\.l\.|s\.n\.)\]$/i, '').trim();
  return v;
}

function extractYear(value) {
  if (!value) return '';
  const m = String(value).match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

function main() {
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  const overrides = fs.existsSync(OVERRIDES_FILE)
    ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'))
    : {};

  const vidages = [];
  const normalises = [];
  const ts = new Date().toISOString();

  for (const slug of Object.keys(metadata)) {
    const e = metadata[slug];

    // --- 1. Description dans une langue non française ---
    const desc = (e.description || '').trim();
    if (desc) {
      const lang = detectLanguage(desc);
      if (lang === 'anglais' || lang === 'inconnu' || isCatalogDumping(desc)) {
        const raison = isCatalogDumping(desc) ? 'notice de catalogue' : ('langue ' + lang);
        vidages.push({ slug, titre: e.title, auteur: e.author, raison, extrait: desc.slice(0, 90) });
        overrides[slug] = Object.assign({}, overrides[slug], {
          description: '',
          verified: true,
          source: 'override',
          enrichedAt: ts
        });
      }
    }

    // --- 2. Normalisation éditeur / année ---
    const avantPub = e.publisher || '';
    const avantDate = e.publishedDate || '';
    const apresPub = cleanPublisher(avantPub);
    const apresDate = extractYear(avantDate);
    if (apresPub !== avantPub || apresDate !== avantDate) {
      normalises.push({ slug, titre: e.title, avant: (avantPub || '-') + (avantDate ? ', ' + avantDate : ''), apres: (apresPub || '-') + (apresDate ? ', ' + apresDate : '') });
      e.publisher = apresPub;
      e.publishedDate = apresDate;
    }
  }

  console.log('='.repeat(60));
  console.log(DRY_RUN ? 'APERÇU (aucune écriture)' : 'NETTOYAGE');
  console.log('='.repeat(60));
  console.log('\nDescriptions non françaises à vider : ' + vidages.length + '\n');
  for (const v of vidages) {
    console.log('  ' + v.slug);
    console.log('     ' + v.titre + ' — ' + v.auteur + '   [' + v.raison + ']');
    console.log('     ' + v.extrait + '...');
  }
  console.log('\nÉditeur / année normalisés : ' + normalises.length + '\n');
  for (const n of normalises.slice(0, 30)) {
    console.log('  ' + n.titre);
    console.log('     avant : ' + n.avant);
    console.log('     apres : ' + n.apres);
  }
  if (normalises.length > 30) console.log('  ... et ' + (normalises.length - 30) + ' autres');

  if (DRY_RUN) {
    console.log('\n--dry-run : rien n\'a été écrit.');
    return;
  }

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2) + '\n', 'utf-8');
  console.log('\n✔ books-metadata.json et metadata-overrides.json écrits.');
  console.log('  Les descriptions vidées restent dans books-metadata.json : le nettoyage est réversible.');
}

main();
