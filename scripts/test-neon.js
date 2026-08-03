/**
 * Script de test de connexion et de validation pour Neon PostgreSQL
 * Exécuter: node scripts/test-neon.js "postgresql://user:pass@ep-host.neon.tech/neondb"
 */

const https = require('https');

async function testNeon(connectionString) {
  console.log("==================================================");
  console.log("  Test de connexion Neon (Serverless Postgres)");
  console.log("==================================================");

  if (!connectionString) {
    console.error("❌ Erreur: Aucune chaîne de connexion fournie.");
    console.log("Usage: node scripts/test-neon.js \"postgresql://user:pass@ep-host.neon.tech/neondb\"");
    process.exit(1);
  }

  const match = connectionString.match(/@([^/:]+)/);
  if (!match) {
    console.error("❌ Format de connexion invalide. Doit commencer par postgresql://user:pass@ep-host.neon.tech/neondb");
    process.exit(1);
  }

  const host = match[1];
  const url = `https://${host}/sql`;

  console.log(`📌 Target Neon Host: ${host}`);
  console.log("📡 Initialisation de la table 'reviews'...");

  const initSql = `
    CREATE TABLE IF NOT EXISTS reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      book_slug VARCHAR(255) NOT NULL,
      book_title VARCHAR(255) NOT NULL,
      author_name VARCHAR(100) NOT NULL,
      rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT NOT NULL
    );
  `;

  try {
    const initRes = await queryNeon(url, connectionString, initSql);
    console.log("✅ Table 'reviews' prête et vérifiée dans Neon !");

    console.log("\n📡 Test de lecture (SELECT COUNT(*)...)");
    const countRes = await queryNeon(url, connectionString, "SELECT COUNT(*) as count FROM reviews;");
    console.log("✅ Connexion réussie ! Nombre de critiques en base :", countRes[0]?.count || 0);

    console.log("\n🎉 Votre base de données Neon est opérationnelle à 100% !");
    console.log("Vous n'aurez PLUS JAMAIS besoin de pings ni de scripts keep-alive.");

  } catch (err) {
    console.error("❌ Erreur de connexion Neon :", err.message);
  }
}

function queryNeon(url, connectionString, sql, params = []) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${connectionString}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.rows || []);
          } catch (e) {
            reject(new Error("Réponse JSON invalide de Neon"));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(JSON.stringify({ query: sql, params }));
    req.end();
  });
}

const urlArg = process.env.NEON_DATABASE_URL || process.argv[2];
testNeon(urlArg);
