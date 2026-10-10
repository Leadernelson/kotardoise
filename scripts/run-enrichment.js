/**
 * Enrichissement local borné dans le temps
 *
 * Lance scripts/enrich-books.js pour une durée impartie, puis s'arrête
 * proprement. Le script d'enrichissement reçoit RUN_MAX_MINUTES : il contrôle
 * lui-même le temps imparti entre deux livres, sauvegarde et quitte avec le
 * code 0. Aucun signal n'est envoyé, donc aucune écriture n'est interrompue.
 *
 * Filet de sécurité supplémentaire : avant de démarrer, ce script prend un
 * instantané des fichiers de données. Après le run, il vérifie qu'ils sont
 * toujours du JSON valide. Si le script enfant plantait (coupure réseau,
 * arrêt brutal de l'ordinateur), l'instantané est restauré : le dépôt ne peut
 * pas se retrouver avec un books-metadata.json corrompu.
 *
 * Usage :
 *   node scripts/run-enrichment.js                 5 minutes par défaut
 *   node scripts/run-enrichment.js --minutes=20    20 minutes
 *   node scripts/run-enrichment.js --cap=300       plafond Google pour ce run
 *   node scripts/run-enrichment.js --dry-run       instantané seul, sans lancer
 *   node scripts/run-enrichment.js --no-restore    ne pas restaurer en cas de pépin
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENRICH_SCRIPT = path.join(__dirname, 'enrich-books.js');
const DATA_FILES = [
  'books-metadata.json',
  'metadata-overrides.json',
  '.quota-state.json'
];
const SNAPSHOT_DIR = path.join(ROOT, '.enrich-snapshot');
const LOG_FILE = path.join(ROOT, 'enrich-run.log');

const args = process.argv.slice(2);
const getVal = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
const MINUTES = parseFloat(getVal('minutes') || '5');
const CAP = getVal('cap');
const DRY_RUN = args.includes('--dry-run');
const NO_RESTORE = args.includes('--no-restore');

if (!Number.isFinite(MINUTES) || MINUTES <= 0) {
  console.error('❌ --minutes doit être un nombre positif (ex. --minutes=5).');
  process.exit(1);
}
if (!fs.existsSync(ENRICH_SCRIPT)) {
  console.error('❌ scripts/enrich-books.js introuvable.');
  process.exit(1);
}

// --- Instantané -----------------------------------------------------------

function takeSnapshot() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const taken = [];
  for (const name of DATA_FILES) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(SNAPSHOT_DIR, name));
    taken.push(name);
  }
  return taken;
}

function isValidJson(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf-8')); return true; }
  catch (e) { return e.message; }
}

function restoreSnapshot(names) {
  const restored = [];
  for (const name of names) {
    const from = path.join(SNAPSHOT_DIR, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(ROOT, name));
    restored.push(name);
  }
  return restored;
}

function clearSnapshot() {
  try { fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true }); } catch (e) { /* rien */ }
}

// --- Compte rendu ----------------------------------------------------------

function summarize() {
  const file = path.join(ROOT, 'books-metadata.json');
  if (!fs.existsSync(file)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
  let covers = 0, descriptions = 0, genres = 0, review = 0, bnf = 0;
  for (const k of Object.keys(meta)) {
    const e = meta[k];
    if (e.coverUrl) covers++;
    if (e.description) descriptions++;
    if (e.genre && e.genre !== 'Inconnu') genres++;
    if (e.needsReview) review++;
    if (e.bnfRef) bnf++;
  }
  return { total: Object.keys(meta).length, covers, descriptions, genres, review, bnf };
}

function diffAgainst(snapshotNames) {
  const results = [];
  for (const name of snapshotNames) {
    const before = path.join(SNAPSHOT_DIR, name);
    const after = path.join(ROOT, name);
    if (!fs.existsSync(before) || !fs.existsSync(after)) continue;
    try {
      const a = fs.readFileSync(before, 'utf-8');
      const b = fs.readFileSync(after, 'utf-8');
      results.push({ name, changed: a !== b, sizeBefore: a.length, sizeAfter: b.length });
    } catch (e) { results.push({ name, changed: false, error: e.message }); }
  }
  return results;
}

// --- Exécution ------------------------------------------------------------

function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Enrichissement local borné                          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Durée impartie : ${MINUTES} minute(s)`);
  if (CAP) console.log(`  Plafond Google  : ${CAP} requêtes`);
  console.log(`  Journal         : ${LOG_FILE}`);
  console.log('');

  // --- Contrôle préalable : INDISPENSABLE ---
  // enrich-books.js, lancé sur un books-metadata.json illisible, part d'un cache
  // vide puis l'écrit : les 676 entrées disparaissent sans la moindre erreur.
  // Le résultat est un JSON parfaitement valide, donc le contrôle de fin de run
  // ne voit rien passer. Il faut donc refuser de démarrer.
  const preflight = [];
  for (const name of DATA_FILES) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const check = isValidJson(file);
    if (check !== true) preflight.push({ name, reason: check });
  }
  if (preflight.length > 0) {
    console.log('  🚫 ARRÊT : fichier de données illisible avant le run.\n');
    for (const p of preflight) {
      console.log(`     ${p.name} : ${p.reason}`);
    }
    console.log('\n  Rien n\'a été lancé et rien n\'a été modifié.');
    console.log('  Enrichir depuis un cache corrompu le viderait complètement.');
    console.log('\n  Pour repartir d\'un fichier sain :');
    for (const p of preflight) console.log(`     git checkout -- ${p.name}`);
    console.log('  Ou, pour reconstruire volontairement le cache :');
    console.log('     rm books-metadata.json && node scripts/enrich-books.js\n');
    process.exit(2);
  }

  const before = summarize();
  if (before) {
    console.log(`  Avant : ${before.covers} couvertures, ${before.descriptions} descriptions, ${before.genres} genres`);
  }

  const taken = takeSnapshot();
  console.log(`  Instantané pris : ${taken.join(', ')}`);

  if (DRY_RUN) {
    console.log('\n  --dry-run : aucun lancement. Instantané conservé dans .enrich-snapshot/\n');
    return;
  }

  const env = { ...process.env, RUN_MAX_MINUTES: String(MINUTES) };
  if (CAP) env.GOOGLE_DAILY_CAP = CAP;

  const startedAt = Date.now();
  const log = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  const write = (text) => { process.stdout.write(text); log.write(text); };

  const child = spawn(process.execPath, [ENRICH_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => write(d.toString()));
  child.stderr.on('data', (d) => write(d.toString()));

  // Si l'utilisateur interrompt (Ctrl+C), on laisse l'enfant terminer sa
  // sauvegarde. La restauration ne se déclenche que si le fichier est abîmé.
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) { console.log('\n  Second Ctrl+C : abandon.'); process.exit(130); }
    interrupted = true;
    console.log('\n  ⏸️  Interruption demandée — le run en cours se termine et sauvegarde...');
  });

  child.on('exit', (code, signal) => {
    log.end();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    console.log('\n' + '─'.repeat(56));
    console.log(`  Run terminé en ${Math.floor(elapsed / 60)} min ${elapsed % 60} s (code ${code}${signal ? ', signal ' + signal : ''})`);
    console.log('─'.repeat(56) + '\n');

    // --- Contrôle d'intégrité : c'est la garantie "sans casser" ---
    let corrupt = false;
    for (const name of taken) {
      const check = isValidJson(path.join(ROOT, name));
      if (check !== true) {
        corrupt = true;
        console.log(`  ❌ ${name} est corrompu : ${check}`);
      }
    }

    // Un fichier peut être du JSON valide et pourtant avoir perdu des données :
    // si books-metadata.json est illisible au démarrage, enrich-books.js part
    // d'un cache vide puis l'écrit — les 676 entrées disparaissent sans erreur.
    // On compare donc le nombre d'entrées avant et après.
    const afterCheck = summarize();
    const dataLoss = !corrupt && before && afterCheck && afterCheck.total < before.total;
    if (dataLoss) {
      console.log(`  ❌ books-metadata.json a perdu des entrées : ${before.total} → ${afterCheck.total}`);
    }

    if ((corrupt || dataLoss) && !NO_RESTORE) {
      const restored = restoreSnapshot(taken);
      console.log(`  ↩️  Instantané restauré : ${restored.join(', ')}`);
      console.log('     Les données sont revenues à leur état avant le run.');
      console.log('     Cause probable : books-metadata.json était illisible au démarrage.\n');
    } else if (corrupt || dataLoss) {
      console.log('  ⚠️  --no-restore : le problème est laissé en l\'état.\n');
    } else {
      for (const d of diffAgainst(taken)) {
        if (d.changed) console.log(`  ✏️  ${d.name} modifié (${Math.round((d.sizeBefore || 0) / 1024)} Ko → ${Math.round((d.sizeAfter || 0) / 1024)} Ko)`);
      }
      const after = summarize();
      if (before && after) {
        const d = (k) => after[k] - before[k];
        console.log(`\n  Bilan : couvertures ${d('covers') >= 0 ? '+' : ''}${d('covers')}, descriptions ${d('descriptions') >= 0 ? '+' : ''}${d('descriptions')}, genres ${d('genres') >= 0 ? '+' : ''}${d('genres')}`);
        console.log(`  Total_metadata : ${after.total} entrées | ${after.review} à vérifier | ${after.bnf} référencés à la BnF`);
      }
      if (code === 0) clearSnapshot();
      else console.log('\n  Note : code de sortie non nul, l\'instantané est conservé pour inspection.');
    }
    process.exit(0);
  });}

main();
