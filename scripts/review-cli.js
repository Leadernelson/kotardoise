/**
 * Arbitrage humain des métadonnées — CLI interactive
 *
 * L'automatisation a atteint sa limite : sur les 457 livres de la file de
 * revue, elle n'a ni couverture, ni genre, ni description exploitable. Google
 * Books renvoie massivement des 503, la BnF ne fournit ni image ni résumé,
 * et Open Library couvre mal le français. Ce script fait le reste : il
 * présente ce que les sources ont trouvé et laisse trancher.
 *
 * Le score automatique n'a pas le dernier mot. Les candidats sont affichés
 * même quand il les rejette : « Requiem » d'Akhmantova est refusé par la
 * BnF, qui indexe la forme corrigée « Akhmatova », mais un humain reconnaît
 * son livre immédiatement. C'est tout l'intérêt de l'outil.
 *
 * Les décisions sont écrites dans metadata-overrides.json, que le site lit
 * déjà en priorité sur books-metadata.json. Rien n'est jamais supprimé :
 * relancer l'outil ne peut pas perdre une donnée.
 *
 * Usage :
 *   node scripts/review-cli.js                  mode couvertures
 *   node scripts/review-cli.js --genres         mode genres
 *   node scripts/review-cli.js --dry-run        affiche, n'écrit rien
 *   node scripts/review-cli.js --restart        reprend depuis le début
 *   node scripts/review-cli.js --limit=20       ne traite que 20 livres
 *   node scripts/review-cli.js --untouched      ajoute les livres jamais cherchés
 *   node scripts/review-cli.js --google         interroge aussi Google Books
 *   node scripts/review-cli.js --no-browser     n'ouvre pas le navigateur
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

const E = require('./enrich-books.js');

const ROOT = path.join(__dirname, '..');
const METADATA_FILE = path.join(ROOT, 'books-metadata.json');
const OVERRIDES_FILE = path.join(ROOT, 'metadata-overrides.json');
const PROGRESS_FILE = path.join(ROOT, '.review-progress.json');

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const val = (n) => {
  const a = args.find((x) => x.startsWith('--' + n + '='));
  return a ? a.split('=')[1] : null;
};

const DRY_RUN = has('dry-run');
const RESTART = has('restart');
const NO_BROWSER = has('no-browser');
const GOOGLE = has('google');
const LIST = has('list');
const INCLURE_INTACTS = has('untouched');
const LIMIT = val('limit') ? Math.max(1, parseInt(val('limit'), 10)) : Infinity;
const MODE_GENRES = has('genres');

// Les genres du site, dans le même ordre que les boutons de filtre de
// index.html, pour qu'un genre saisi ici soit directement filtrable. Ajouter
// un genre ici ne suffit pas : il faut aussi le bouton, la classe CSS
// .tag-<genre> et le cas d'émoji dans index.html.
const GENRES = [
  'Horreur', 'Romance', 'Science-fiction', 'Fantasy', 'Thriller',
  'Aventure', 'Policier', 'Historique', 'Drame', 'Comédie', 'Essai'
];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', vert: '\x1b[32m', jaune: '\x1b[33m',
  rouge: '\x1b[31m', bleu: '\x1b[34m', gris: '\x1b[90m'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Les frappes clavier n'atteignent l'application que si le flux stdin est
// explicitement tasked d'en émettre les événements.
readline.emitKeypressEvents(process.stdin);

function lireJson(file, defaut) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return defaut;
  }
}

// ---------------------------------------------------------------------------
// Chargement : la Sheet pour l'auteur exact, la fusion des deux JSON pour
// l'état courant. La fusion reprend celle de enrich-books.js et de index.html.
// ---------------------------------------------------------------------------

async function chargerLivres() {
  const meta = lireJson(METADATA_FILE, {});
  const ov = lireJson(OVERRIDES_FILE, {});
  const fusion = {};
  for (const k of Object.keys(meta)) fusion[k] = Object.assign({}, meta[k]);
  for (const k of Object.keys(ov)) fusion[k] = Object.assign({}, fusion[k] || {}, ov[k]);

  const res = await fetch(E.SHEET_URL);
  if (!res.ok) throw new Error('la Sheet n’a pas répondu (' + res.status + ')');
  const lignes = await res.json();

  return lignes.map((b) => {
    const prenom = b['Prénom'] || b.Prnom || '';
    const famille = b.Famille || '';
    const auteur = ((prenom + ' ' + famille).trim() || b.Auteur || '').trim();
    const titre = (b.Titre || '').trim();
    const slug = E.slugify(titre + ' ' + auteur);
    const e = fusion[slug] || {};
    return {
      slug, titre, auteur,
      type: b.Type || '',
      isbn: e.isbn || b.ISBN || '',
      publisher: e.publisher || '',
      publishedDate: e.publishedDate || '',
      bnfRef: e.bnfRef || '',
      coverUrl: e.coverUrl || '',
      description: e.description || '',
      genre: e.genre || 'Inconnu',
      source: e.source || ''
    };
  });
}

// ---------------------------------------------------------------------------
// Candidats
//
// On interroge les sources et on garde tout ce qui revient, y compris ce que
// le score automatique refuse : c'est la personne qui décide, pas la machine.
// Dédoublonnage par couple titre + auteur normalisé.
// ---------------------------------------------------------------------------

function note(bon, candidat) {
  const m = E.matchScore(bon.titre, bon.auteur, candidat.titre, candidat.auteur);
  return m.titleScore + m.authorScore;
}

function descarter(candidats) {
  const vus = new Set();
  return candidats.filter((c) => {
    if (!c || !c.titre) return false;
    const cle = E.slugify(c.titre) + '|' + E.slugify(c.auteur || '');
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

async function candidatsPour(bon) {
  const liste = [];

  // 1. Open Library par ISBN : déterministe, c'est la piste la plus fiable
  if (bon.isbn) {
    const parIsbn = await E.fetchOpenLibraryCoverByIsbn(bon.isbn);
    if (parIsbn && parIsbn.coverUrl) {
      liste.push({
        source: 'Open Library (ISBN)',
        titre: parIsbn.title, auteur: parIsbn.author,
        coverUrl: parIsbn.coverUrl,
        description: '', isbn: bon.isbn, editeur: '', annee: '', bnfRef: ''
      });
    }
  }

  // 2. Open Library par titre + auteur
  const ol = await E.fetchOpenLibrary(bon.titre, bon.auteur, '');
  if (ol) {
    liste.push({
      source: 'Open Library',
      titre: ol.title, auteur: ol.author,
      coverUrl: ol.coverId ? 'https://covers.openlibrary.org/b/id/' + ol.coverId + '-L.jpg' : '',
      description: E.acceptDescription(ol.description || '').keep ? ol.description : '',
      isbn: ol.isbn || '', editeur: '', annee: '', bnfRef: ''
    });
  }

  // 3. BnF : titre canonique, éditeur, année, ISBN de l'édition française
  const bnf = await E.fetchBnF(bon.titre, bon.auteur);
  if (bnf) {
    liste.push({
      source: 'BnF',
      titre: bnf.notifTitle, auteur: bnf.notifAuthor,
      coverUrl: '',
      description: '',
      isbn: bnf.isbn || '', editeur: bnf.publisher || '', annee: bnf.pubDate || '',
      bnfRef: bnf.ark || ''
    });
  }

  // 4. Google Books, uniquement si on l'a demandé ET qu'il va bien.
  // Par défaut on l'ignore : chaque appel consomme le quota quotidien que
  // la CI consomme aussi, et on ne gaspille pas les 40 appels en délibérant
  // livre par livre.
  if (GOOGLE) {
    if (E.googleUnhealthy()) {
      console.log(C.gris + '  (Google Books ignoré : service dégradé)' + C.reset);
    } else {
      try {
        const gb = await E.fetchGoogleBooks(bon.titre, bon.auteur, bon.isbn, '');
        if (gb && gb.info) {
          const i = gb.info.imageLinks || {};
          liste.push({
            source: 'Google Books',
            titre: gb.info.title || '',
            auteur: Array.isArray(gb.info.authors) ? gb.info.authors.join(', ') : (gb.info.authors || ''),
            coverUrl: i.extraLarge || i.large || i.medium || i.thumbnail || '',
            description: E.acceptDescription(gb.info.description || '').keep ? gb.info.description : '',
            isbn: '', editeur: gb.info.publisher || '', annee: (gb.info.publishedDate || '').slice(0, 4), bnfRef: ''
          });
        }
      } catch (e) {
        // Quota épuisé ou 503 : ce n'est pas bloquant, on continue sans Google
        console.log(C.gris + '  (Google Books indisponible)' + C.reset);
      }
    }
  }

  return descarter(liste)
    .map((c) => Object.assign(c, { score: note(bon, c) }))
    .sort((a, b) => {
      // Ce qui a une image d'abord, puis un résumé, puis la proximité du titre
      if (!!b.coverUrl !== !!a.coverUrl) return b.coverUrl ? 1 : -1;
      if (!!b.description !== !!a.description) return b.description ? 1 : -1;
      return b.score - a.score;
    });
}

// Recherche libre, pour les livres que la Sheet décrit trop mal
async function rechercheLibre(requete) {
  const liste = [];
  const ol = await E.fetchOpenLibrary(requete, '', '');
  if (ol) {
    liste.push({
      source: 'Open Library', titre: ol.title, auteur: ol.author,
      coverUrl: ol.coverId ? 'https://covers.openlibrary.org/b/id/' + ol.coverId + '-L.jpg' : '',
      description: E.acceptDescription(ol.description || '').keep ? ol.description : '',
      isbn: ol.isbn || '', editeur: '', annee: '', bnfRef: ''
    });
  }
  const bnf = await E.fetchBnF(requete, '');
  if (bnf) {
    liste.push({
      source: 'BnF', titre: bnf.notifTitle, auteur: bnf.notifAuthor, coverUrl: '',
      description: '', isbn: bnf.isbn || '', editeur: bnf.publisher || '',
      annee: bnf.pubDate || '', bnfRef: bnf.ark || ''
    });
  }
  if (GOOGLE && !E.googleUnhealthy()) {
    try {
      const gb = await E.fetchGoogleBooks(requete, '', '', '');
      if (gb && gb.info) {
        const i = gb.info.imageLinks || {};
        liste.push({
          source: 'Google Books', titre: gb.info.title || '',
          auteur: Array.isArray(gb.info.authors) ? gb.info.authors.join(', ') : '',
          coverUrl: i.extraLarge || i.large || i.medium || i.thumbnail || '',
          description: E.acceptDescription(gb.info.description || '').keep ? gb.info.description : '',
          isbn: '', editeur: gb.info.publisher || '',
          annee: (gb.info.publishedDate || '').slice(0, 4), bnfRef: ''
        });
      }
    } catch (e) { /* sans conséquence */ }
  }
  return descarter(liste);
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

function trait(c, n) { console.log((c || C.gris) + (n || '-').repeat(78) + C.reset); }

function afficherLivre(bon, index, total) {
  const manque = [];
  if (!bon.coverUrl) manque.push('couverture');
  if (!bon.description) manque.push('description');
  if (!bon.genre || bon.genre === 'Inconnu') manque.push('genre');

  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  ' + index + '/' + total + C.reset + '   ' +
    C.cyan + '« ' + bon.titre + ' »' + C.reset + '  ' + C.bold + bon.auteur + C.reset);
  if (manque.length) console.log(C.jaune + '  Manque : ' + manque.join(' · ') + C.reset);
  if (bon.type) console.log(C.gris + '  Type : ' + bon.type + C.reset);
  trait();
  if (bon.isbn) console.log(C.dim + '  ISBN       ' + C.reset + bon.isbn);
  if (bon.publisher) console.log(C.dim + '  Éditeur    ' + C.reset + bon.publisher + (bon.publishedDate ? ', ' + bon.publishedDate : ''));
  if (bon.coverUrl) console.log(C.dim + '  Couverture ' + C.reset + bon.coverUrl.slice(0, 62));
  if (bon.genre && bon.genre !== 'Inconnu') console.log(C.dim + '  Genre      ' + C.reset + bon.genre);
  if (bon.description) console.log(C.dim + '  Résumé     ' + C.reset + bon.description.slice(0, 62) + '…');
}

function afficherCandidats(liste) {
  if (!liste.length) {
    console.log(C.rouge + '  Aucune source n’a rien trouvé.' + C.reset);
    console.log(C.gris + '  [m] pour lancer une recherche libre, ou [u] pour coller une URL.' + C.reset);
    return;
  }
  console.log(C.bold + '  CANDIDATS' + C.reset);
  liste.slice(0, 5).forEach((c, i) => {
    const couv = c.coverUrl ? C.vert + 'couv' + C.reset : C.gris + '----' + C.reset;
    const desc = c.description ? C.vert + 'desc' + C.reset : C.gris + '----' + C.reset;
    const infos = [c.annee, c.editeur, c.isbn].filter(Boolean).join(' · ');
    console.log('  ' + C.bold + (i + 1) + C.reset + ') ' + c.titre + ' — ' + c.auteur);
    console.log('     ' + couv + ' ' + desc + '  ' + C.gris + c.source + (infos ? ' · ' + infos : '') + C.reset);
    if (c.coverUrl) console.log('     ' + C.bleu + c.coverUrl.slice(0, 72) + C.reset);
  });

  // La BnF ne détient aucune image et Open Library couvre mal le français :
  // sur ces 216 livres, le cas le plus fréquent est « aucune jaquette nulle
  // part ». Mieux vaut le dire que laisser croire qu'un choix va aider.
  if (!liste.some((c) => c.coverUrl)) {
    console.log('');
    console.log(C.jaune + '  Aucune jaquette trouvée automatiquement.' + C.reset);
    console.log(C.gris + '  Cherchez la couverture sur Babelio, Goodreads ou Amazon, puis' + C.reset);
    console.log(C.gris + '  [u] pour en coller l’adresse. Le candidat ci-dessus sert' + C.reset);
    console.log(C.gris + '  surtout à confirmer l’ouvrage exact qu’il faut aller chercher.' + C.reset);
  }
  console.log('');
  console.log(C.gris + '  ' + C.bold + 'Entrée' + C.reset + ' meilleur  ' +
    C.bold + '1-5' + C.reset + ' choisir  ' + C.bold + 'o' + C.reset + ' ouvrir  ' +
    C.bold + 'O' + C.reset + ' tout  ' + C.bold + '?' + C.reset + ' aide');
  console.log(C.gris + '  ' + C.bold + 'u' + C.reset + ' coller une URL  ' + C.bold + 'd' + C.reset + ' description  ' +
    C.bold + 'g' + C.reset + ' genre  ' + C.bold + 'm' + C.reset + ' rechercher');
  console.log(C.gris + '  ' + C.bold + 's' + C.reset + ' passer  ' + C.bold + 'b' + C.reset + ' retour  ' +
    C.bold + 'q' + C.reset + ' quitter');
}

function afficherAide() {
  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  AIDE' + C.reset);
  console.log('  ' + C.bold + 'Entrée' + C.reset + '      accepte le meilleur candidat — deux secondes par livre');
  console.log('  ' + C.bold + '1 à 5' + C.reset + '    accepte le candidat affiché à ce numéro');
  console.log('  ' + C.bold + 'o' + C.reset + '        ouvre la couverture du premier candidat');
  console.log('  ' + C.bold + 'O' + C.reset + '        ouvre toutes les couvertures proposées');
  console.log('  ' + C.bold + 'u' + C.reset + '        colle une URL de couverture trouvée ailleurs');
  console.log('  ' + C.bold + 'd' + C.reset + '        saisit un résumé');
  console.log('  ' + C.bold + 'g' + C.reset + '        choisit un genre parmi ceux du site');
  console.log('  ' + C.bold + 'm' + C.reset + '        recherche libre par titre ou ISBN');
  console.log('  ' + C.bold + 's' + C.reset + '        passe ce livre sans rien écrire');
  console.log('  ' + C.bold + 'b' + C.reset + '        revient au livre précédent, décision annulée');
  console.log('  ' + C.bold + 'q' + C.reset + '        quitte — tout ce qui a été décidé est enregistré');
  console.log('');
  console.log(C.gris + '  Un candidat est « validé » si la couverture affichée dans le navigateur' + C.reset);
  console.log(C.gris + '  correspond bien à l’ouvrage de la Sheet. Le titre exact importe peu :' + C.reset);
  console.log(C.gris + '  c’est l’illustration et l’auteur qui doivent être les bons.' + C.reset);
  trait(C.gris, '=');
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

function enregistrer(slug, champs) {
  if (!champs || !Object.keys(champs).length) return 0;
  if (DRY_RUN) return Object.keys(champs).length;
  const ov = lireJson(OVERRIDES_FILE, {});
  ov[slug] = Object.assign({}, ov[slug] || {}, champs, {
    verified: true,
    source: 'override',
    enrichedAt: new Date().toISOString()
  });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(ov, null, 2) + '\n', 'utf-8');
  return Object.keys(champs).length;
}

function sauvegarderProgression(p) {
  if (DRY_RUN) return;
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2) + '\n', 'utf-8');
  } catch (e) { /* la progression est un confort, pas une donnée */ }
}

function ouvrirNavigateur(url) {
  if (NO_BROWSER || process.platform === 'linux' && !process.env.DISPLAY) {
    console.log(C.gris + '  ' + url + C.reset);
    return;
  }
  const cmd = process.platform === 'win32' ? 'start ""'
    : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  exec(cmd + ' "' + url + '"', () => {});
}

// Saisie ligne à ligne, pour l'URL collée et le résumé
function demander(question) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (r) => {
      rl.close();
      process.stdin.pause();
      resolve((r || '').trim());
    });
  });
}

// Une seule frappe, sans Entrée
function attendreTouche() {
  return new Promise((resolve) => {
    const brut = process.stdin.isTTY;
    if (brut) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (s, k) => {
      if (!k) return;
      if (k.ctrl && (k.name === 'c' || k.name === 'd')) {
        process.stdin.removeListener('keypress', onKey);
        if (brut) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        process.exit(0);
      }
      if (k.name === 'escape') {
        process.stdin.removeListener('keypress', onKey);
        if (brut) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(null);
        return;
      }
      process.stdin.removeListener('keypress', onKey);
      if (brut) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(s);
    };
    process.stdin.on('keypress', onKey);
  });
}

function champsDepuisCandidat(c) {
  const champs = {};
  if (c.coverUrl) champs.coverUrl = c.coverUrl;
  if (c.description) champs.description = c.description;
  if (c.isbn) champs.isbn = c.isbn;
  if (c.editeur) champs.publisher = c.editeur;
  if (c.annee) champs.publishedDate = c.annee;
  if (c.bnfRef) champs.bnfRef = c.bnfRef;
  return champs;
}

const etiqChamps = {
  coverUrl: 'couverture', description: 'résumé', isbn: 'ISBN',
  publisher: 'éditeur', publishedDate: 'année', bnfRef: 'réf. BnF'
};

// ---------------------------------------------------------------------------
// Files de travail
// ---------------------------------------------------------------------------

function progressions() {
  const p = RESTART ? {} : lireJson(PROGRESS_FILE, {});
  if (!Array.isArray(p.traites)) p.traites = [];
  if (!Array.isArray(p.ignores)) p.ignores = [];
  if (!Array.isArray(p.genres)) p.genres = [];
  return p;
}

// Priorité de tractabilité.
//
// Un livre qu'une source a déjà cherché sans succès est un cas difficile :
// personne ne le trouverait en deux secondes, c'est exactement ce qui mérite
// un arbitrage humain. Un livre qu'aucune source n'a jamais touché n'a pas
// été difficile, il n'a simplement pas été traité — le run automatique le
// fera moins cher et sans risque d'erreur. On ne les propose donc qu'avec
// --untouched, pour ne pas faire 1 500 livres a la main pour rien.
//
// À l'intérieur d'un groupe, l'ISBN d'abord : il identifie une édition sans
// ambiguïté et se tranche en une lecture.
const RANG = {
  essaye: { isbn: 0, publisher: 1, rien: 2 },
  intact: { isbn: 3, publisher: 4, rien: 5 },
  exclu: 99
};

function fileCouvertures(livres, p) {
  const traites = new Set(p.traites);
  const ignores = new Set(p.ignores);

  const rang = (l) => {
    if (!l.titre) return RANG.exclu;
    if (l.source === 'override') return RANG.exclu;
    // Déjà cherché par une source : c'est un cas difficile, à arbitrer.
    // Jamais cherché : ce n'est pas difficile, c'est non traité.
    const g = l.source ? RANG.essaye : RANG.intact;
    if (!l.source && !INCLURE_INTACTS) return RANG.exclu;
    return l.isbn ? g.isbn : (l.publisher ? g.publisher : g.rien);
  };

  return livres
    .filter((l) => !l.coverUrl)
    .filter((l) => !traites.has(l.slug) && !ignores.has(l.slug))
    .filter((l) => rang(l) < RANG.exclu)
    .sort((a, b) => rang(a) - rang(b) || a.titre.localeCompare(b.titre, 'fr'))
    .slice(0, LIMIT);
}

function fileGenres(livres, p) {
  const faits = new Set(p.genres);
  return livres
    .filter((l) => l.titre && l.coverUrl)
    .filter((l) => (!l.genre || l.genre === 'Inconnu') && l.source !== 'override')
    .filter((l) => !faits.has(l.slug))
    .slice(0, LIMIT);
}

// ---------------------------------------------------------------------------
// Mode couvertures
// ---------------------------------------------------------------------------

async function arbitrerCouvertures() {
  const livres = await chargerLivres();
  const p = progressions();
  const file = fileCouvertures(livres, p);

  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  ARBITRAGE DES COUVERTURES — ' + file.length + ' livre(s) en file' + C.reset);
  console.log(C.gris + '  Les décisions vont dans metadata-overrides.json, jamais dans books-metadata.json.' + C.reset);
  console.log(C.gris + '  books-metadata.json garde tout : relancer cet outil ne perd rien.' + C.reset);
  console.log(C.gris + '  Les livres déjà couverts, ou déjà validés à la main, sont exclus de la file.' + C.reset);
  if (!GOOGLE) console.log(C.gris + '  Google Books n’est pas interrogé (ajoutez --google pour l’inclure).' + C.reset);
  if (DRY_RUN) console.log(C.jaune + '  MODE APERÇU : aucune écriture.' + C.reset);
  trait(C.gris, '=');

  if (!file.length) {
    console.log(C.vert + '\n  Rien à faire. Pour tout revoir : --restart\n' + C.reset);
    return;
  }

  let i = 0;
  let retenus = 0;

  while (i < file.length) {
    const bon = file[i];

    process.stdout.write(C.gris + '\r  recherche des candidats...  ' + C.reset);
    let liste;
    try {
      liste = await candidatsPour(bon);
    } catch (e) {
      liste = [];
      console.log(C.rouge + '  (source en erreur : ' + e.message + ')' + C.reset);
    }
    process.stdout.write('\r' + ' '.repeat(46) + '\r');

    afficherLivre(bon, i + 1, file.length);
    afficherCandidats(liste);

    const touche = await attendreTouche();
    if (touche === null) { console.log(C.gris + '  Retour.' + C.reset); continue; }

    if (touche === 'q') break;

    if (touche === '?') { afficherAide(); continue; }

    if (touche === 's') {
      p.ignores.push(bon.slug);
      sauvegarderProgression(p);
      console.log(C.gris + '  Passé.' + C.reset);
      i++;
      continue;
    }

    if (touche === 'b') {
      if (i === 0) { console.log(C.gris + '  Déjà au premier livre de la file.' + C.reset); continue; }
      i--;
      const precedent = file[i];
      p.traites = p.traites.filter((s) => s !== precedent.slug);
      p.ignores = p.ignores.filter((s) => s !== precedent.slug);
      sauvegarderProgression(p);
      console.log(C.gris + '  Retour sur « ' + precedent.titre + ' ».' + C.reset);
      continue;
    }

    if (touche === 'o') {
      const premier = liste.find((c) => c.coverUrl);
      if (premier) { ouvrirNavigateur(premier.coverUrl); console.log(C.gris + '  Ouvert : ' + premier.titre + C.reset); }
      else console.log(C.rouge + '  Aucun candidat avec une couverture.' + C.reset);
      continue;
    }

    if (touche === 'O') {
      const avecImage = liste.filter((c) => c.coverUrl);
      avecImage.forEach((c) => ouvrirNavigateur(c.coverUrl));
      console.log(C.gris + '  ' + avecImage.length + ' couverture(s) ouverte(s).' + C.reset);
      await sleep(400);
      continue;
    }

    if (touche === 'u') {
      const url = await demander(C.cyan + '  URL de couverture (Entrée pour annuler) : ' + C.reset);
      if (url) {
        const n = enregistrer(bon.slug, { coverUrl: url });
        p.traites.push(bon.slug);
        sauvegarderProgression(p);
        retenus++;
        console.log(C.vert + '  ✓ couverture enregistrée' + (n > 1 ? '' : '') + C.reset);
      }
      continue;
    }

    if (touche === 'd') {
      const desc = await demander(C.cyan + '  Résumé (une ligne, Entrée pour annuler) : ' + C.reset);
      if (desc) {
        enregistrer(bon.slug, { description: desc });
        p.traites.push(bon.slug);
        sauvegarderProgression(p);
        retenus++;
        console.log(C.vert + '  ✓ résumé enregistré' + C.reset);
      }
      continue;
    }

    if (touche === 'g') {
      const genre = await choisirGenre();
      if (genre) {
        enregistrer(bon.slug, { genre });
        p.traites.push(bon.slug);
        sauvegarderProgression(p);
        retenus++;
        console.log(C.vert + '  ✓ genre : ' + genre + C.reset);
      }
      continue;
    }

    if (touche === 'm') {
      const requete = await demander(C.cyan + '  Titre ou ISBN à rechercher : ' + C.reset);
      if (!requete) continue;
      process.stdout.write(C.gris + '\r  recherche...  ' + C.reset);
      const trouves = await rechercheLibre(requete);
      process.stdout.write('\r' + ' '.repeat(46) + '\r');
      console.log('');
      afficherCandidats(trouves);
      const reponse = await attendreTouche();
      const n = parseInt(reponse, 10);
      if (n >= 1 && n <= trouves.length) {
        const champs = champsDepuisCandidat(trouves[n - 1]);
        enregistrer(bon.slug, champs);
        p.traites.push(bon.slug);
        sauvegarderProgression(p);
        retenus++;
        console.log(C.vert + '  ✓ ' + Object.keys(champs).map((k) => etiqChamps[k]).join(', ') + C.reset);
        i++;
        await sleep(120);
      } else {
        console.log(C.gris + '  Rien retenu.' + C.reset);
      }
      continue;
    }

    // Un chiffre, ou Entrée pour le meilleur candidat
    let choisi = null;
    if (touche === '\r' || touche === '\n') {
      choisi = liste[0] || null;
      if (!choisi) { console.log(C.rouge + '  Aucun candidat à retenir.' + C.reset); continue; }
    } else {
      const n = parseInt(touche, 10);
      if (n >= 1 && n <= Math.min(5, liste.length)) choisi = liste[n - 1];
    }

    if (!choisi) { console.log(C.rouge + '  Touche non reconnue — ? pour l’aide.' + C.reset); continue; }

    const champs = champsDepuisCandidat(choisi);
    if (!Object.keys(champs).length) {
      console.log(C.rouge + '  Ce candidat n’apporte rien de nouveau.' + C.reset);
      continue;
    }

    // Ouvrir la couverture avant de retenir aide à éviter l'erreur de facile
    if (choisi.coverUrl && !NO_BROWSER) ouvrirNavigateur(choisi.coverUrl);

    enregistrer(bon.slug, champs);
    p.traites.push(bon.slug);
    sauvegarderProgression(p);
    retenus++;
    console.log(C.vert + '  ✓ ' +
      Object.keys(champs).map((k) => etiqChamps[k]).join(', ') +
      C.reset + C.gris + '  (' + choisi.source + ')' + C.reset);
    i++;
    await sleep(150);
  }

  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  Bilan : ' + retenus + ' livre(s) enregistré(s)' + C.reset +
    (DRY_RUN ? C.jaune + '  (mode aperçu, rien n’a été écrit)' + C.reset : C.gris));
  console.log(C.gris + '  Reprenez simplement en relançant la commande ; --restart pour tout revoir.' + C.reset);
  trait(C.gris, '=');
  console.log('');
}

// ---------------------------------------------------------------------------
// Mode genres
// ---------------------------------------------------------------------------

async function choisirGenre() {
  console.log('');
  GENRES.forEach((nom, i) => {
    console.log('   ' + C.bold + (i + 1) + C.reset + ') ' + nom);
  });
  console.log(C.gris + '   Entrée pour ne rien changer   Échap pour revenir' + C.reset);
  const t = await attendreTouche();
  if (t === null) return null;
  const n = parseInt(t, 10);
  return (n >= 1 && n <= GENRES.length) ? GENRES[n - 1] : null;
}

async function arbitrerGenres() {
  const livres = await chargerLivres();
  const p = progressions();
  const file = fileGenres(livres, p);

  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  ATTRIBUTION DES GENRES — ' + file.length + ' livre(s) en file' + C.reset);
  console.log(C.gris + '  Un chiffre par livre, deux secondes chacun. Ces livres ont déjà une couverture.' + C.reset);
  if (DRY_RUN) console.log(C.jaune + '  MODE APERÇU : aucune écriture.' + C.reset);
  trait(C.gris, '=');

  if (!file.length) {
    console.log(C.vert + '\n  Aucun livre en attente.\n' + C.reset);
    return;
  }

  let i = 0;
  let retenus = 0;

  while (i < file.length) {
    const l = file[i];
    console.log('');
    trait();
    console.log('  ' + C.bold + (i + 1) + '/' + file.length + C.reset + '  ' +
      C.cyan + l.titre + C.reset + '  ' + C.bold + l.auteur + C.reset);
    if (l.publisher) console.log(C.gris + '  ' + l.publisher + (l.publishedDate ? ', ' + l.publishedDate : '') + C.reset);
    console.log('');
    GENRES.forEach((nom, k) => console.log('   ' + C.bold + (k + 1) + C.reset + ') ' + nom));
    console.log(C.gris + '   [Entrée] passer   [q] quitter' + C.reset);

    const t = await attendreTouche();
    if (t === null) { i++; continue; }
    if (t === 'q') break;

    const n = parseInt(t, 10);
    if (n >= 1 && n <= GENRES.length) {
      enregistrer(l.slug, { genre: GENRES[n - 1] });
      p.genres.push(l.slug);
      sauvegarderProgression(p);
      retenus++;
      console.log(C.vert + '  ✓ ' + GENRES[n - 1] + C.reset);
    }
    i++;
  }

  console.log('');
  console.log(C.vert + '  ' + retenus + ' genre(s) attribué(s).' + C.reset +
    (DRY_RUN ? C.jaune + '  (mode aperçu, rien n’a été écrit)' + C.reset : C.gris));
  console.log('');
}

// ---------------------------------------------------------------------------

// Aperçu de la file, sans aucune interaction : utile pour vérifier ce qui
// reste à faire, et pour vérifier que l'outil n'a rien déjà décidé.
async function lister() {
  const livres = await chargerLivres();
  const p = progressions();
  const couv = fileCouvertures(livres, p);
  const genres = fileGenres(livres, p);

  console.log('');
  trait(C.gris, '=');
  console.log(C.bold + '  FILE DE REVUE' + C.reset);
  console.log('  ' + livres.length + ' livres au total');
  console.log(C.jaune + '  ' + couv.length + ' sans couverture' + C.reset);
  console.log(C.jaune + '  ' + genres.length + ' avec couverture mais sans genre' + C.reset);
  if (!INCLURE_INTACTS) {
    console.log(C.gris + '  Les livres qu’aucune source n’a encore jamais cherchés sont exclus.' + C.reset);
    console.log(C.gris + '  Ce ne sont pas des cas difficiles, seulement des cas non traités :' + C.reset);
    console.log(C.gris + '  laissez « npm run enrich » s’en occuper, c’est gratuit et sans risque.' + C.reset);
    console.log(C.gris + '  Pour les voir quand même : --untouched' + C.reset);
  }
  trait(C.gris, '=');

  const groupes = [
    ['Déjà cherchés par une source, ISBN connu — le plus simple', couv.filter((l) => l.source && l.isbn)],
    ['Déjà cherchés par une source, éditeur connu', couv.filter((l) => l.source && !l.isbn && l.publisher)],
    ['Déjà cherchés, aucune fiche — recherche manuelle', couv.filter((l) => l.source && !l.isbn && !l.publisher)],
    ['Jamais cherchés — à traiter en priorité par npm run enrich', couv.filter((l) => !l.source)]
  ];
  for (const [titre, liste] of groupes) {
    if (!liste.length) continue;
    console.log('');
    console.log(C.bold + '  ' + titre + ' (' + liste.length + ')' + C.reset);
    liste.slice(0, 12).forEach((l) => {
      console.log(C.gris + '    · ' + C.reset + l.titre + ' — ' + l.auteur);
    });
    if (liste.length > 12) console.log(C.gris + '    … et ' + (liste.length - 12) + ' autres' + C.reset);
  }
  console.log('');
  trait(C.gris, '=');
  console.log('');
}

process.on('SIGINT', () => {
  console.log('\n' + C.jaune + '  Interrompu. Les décisions déjà prises sont enregistrées.' + C.reset);
  process.exit(0);
});

(async () => {
  if (DRY_RUN) console.log(C.jaune + '\n  MODE APERÇU : aucune donnée ne sera écrite.\n' + C.reset);
  try {
    if (LIST) {
      await lister();
    } else if (MODE_GENRES) {
      await arbitrerGenres();
    } else {
      await arbitrerCouvertures();
    }
  } catch (e) {
    console.error('\n' + C.rouge + '  Erreur : ' + e.message + C.reset + '\n');
  }
  // Pas de process.exit() : sous Windows, quitter pendant qu'un socket se
  // ferme fait tomber libuv sur une assertion. stdin est déjà en pause, le
  // processus se termine donc de lui-même une fois le travail fini.
  process.exitCode = 0;
})();
