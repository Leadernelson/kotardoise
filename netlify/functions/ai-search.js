exports.handler = async (event, context) => {
  // Gérer les CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Gérer les requêtes OPTIONS (preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { query, booksData } = JSON.parse(event.body);

    if (!query || !booksData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Query and booksData are required' })
      };
    }

    // Votre clé API Gemini (gardée secrète côté serveur)
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    
    if (!GEMINI_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'API key not configured' })
      };
    }

    const prompt = `
Tu es un assistant bibliothécaire expert avec accès à une base de données complète de ${booksData.length} livres.

REQUÊTE UTILISATEUR : "${query}"

INSTRUCTIONS POUR RECHERCHE EXHAUSTIVE :
1. Analyse TOUS les livres fournis pour trouver les correspondances
2. Sois très inclusif dans tes critères de correspondance
3. Considère les synonymes, références indirectes, et descriptions créatives
4. Pour les personnages/univers célèbres (Voldemort=Harry Potter), inclus TOUTE la série
5. Pour les thèmes larges (magie, guerre, amour), sois généreux dans l'interprétation
6. Inclus les correspondances partielles et les associations d'idées

CRITÈRES DE RECHERCHE EXHAUSTIFS :
- Titres exacts et partiels
- Noms d'auteurs complets et partiels  
- Personnages principaux et secondaires
- Univers, lieux et mondes fictifs
- Tous genres et sous-genres
- Thèmes, motifs, émotions et concepts
- Périodes historiques et époques
- Styles narratifs et tons
- Références culturelles et mythologiques
- Séries, cycles et collections

EXEMPLES DE RECHERCHE INCLUSIVE :
- "Voldemort" → TOUS Harry Potter + fantasy sombre
- "magie" → Fantasy, contes, Harry Potter, urban fantasy, etc.
- "guerre" → Historique, fantasy épique, science-fiction militaire
- "amour" → Romance, drames, comédies romantiques, tragédies
- "aventure" → Action, fantasy, science-fiction, jeunesse

BASE DE DONNÉES COMPLÈTE :
${JSON.stringify(booksData, null, 2)}

Retourne un tableau JSON avec TOUS les ISBN pertinents, triés par pertinence décroissante.
IMPORTANT: Sois généreux, il vaut mieux inclure trop que pas assez !

Format de réponse :
["ISBN1", "ISBN2", "ISBN3", ...]
`;

    console.log(`🤖 Recherche IA EXHAUSTIVE pour "${query}" sur ${booksData.length} livres`);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.5, // Augmenté pour plus de créativité et d'inclusion
          topK: 60,
          topP: 0.98,
          maxOutputTokens: 4096, // Augmenté significativement pour plus de résultats
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error: ${response.status} - ${errorText}`);
      
      // Si l'erreur est liée à la taille, essayer avec un dataset réduit
      if (response.status === 413 || errorText.includes('too large') || errorText.includes('limit')) {
        console.log('🔄 Dataset trop volumineux, tentative avec échantillon représentatif...');
        
        // Créer un échantillon intelligent si le dataset complet est trop gros
        const sampleSize = Math.min(1500, booksData.length);
        const step = Math.max(1, Math.floor(booksData.length / sampleSize));
        const sampledBooks = [];
        
        for (let i = 0; i < booksData.length; i += step) {
          sampledBooks.push(booksData[i]);
        }
        
        // Relancer avec l'échantillon
        const reducedPrompt = prompt.replace(JSON.stringify(booksData, null, 2), JSON.stringify(sampledBooks, null, 2))
                                   .replace(`${booksData.length} livres`, `${sampledBooks.length} livres (échantillon représentatif)`);
        
        const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: reducedPrompt }] }],
            generationConfig: {
              temperature: 0.5,
              topK: 60,
              topP: 0.98,
              maxOutputTokens: 4096,
            }
          })
        });
        
        if (!retryResponse.ok) {
          throw new Error(`Retry failed: ${retryResponse.status}`);
        }
        
        // Remplacer la réponse par celle du retry
        const retryData = await retryResponse.json();
        console.log('✅ Recherche réussie avec échantillon réduit');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            matchingISBNs: extractISBNs(retryData.candidates[0].content.parts[0].text),
            note: `Recherche effectuée sur un échantillon de ${sampledBooks.length} livres`
          })
        };
      }
      
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const aiResponse = data.candidates[0].content.parts[0].text;
    
    console.log(`🤖 Réponse IA brute: ${aiResponse.substring(0, 200)}...`);
    
    // Extraire les ISBN avec fonction helper
    const matchingISBNs = extractISBNs(aiResponse);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        matchingISBNs: matchingISBNs || [] 
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      })
    };
  }
};

// Fonction helper pour extraire les ISBN de la réponse IA
function extractISBNs(aiResponse) {
  let matchingISBNs;
  try {
    // Nettoyer la réponse avant le parsing
    let cleanResponse = aiResponse.trim();
    
    // Chercher différents formats de tableau JSON
    const patterns = [
      /\[(.*?)\]/s,  // Format standard
      /```json\s*(\[.*?\])\s*```/s,  // Format avec markdown
      /```\s*(\[.*?\])\s*```/s,  // Format avec markdown sans json
      /"?(\[.*?\])"?/s  // Format avec guillemets
    ];
    
    let extracted = null;
    for (const pattern of patterns) {
      const match = cleanResponse.match(pattern);
      if (match) {
        extracted = match[1];
        break;
      }
    }
    
    if (extracted) {
      // Nettoyer l'extraction
      extracted = extracted.replace(/```json|```/g, '').trim();
      matchingISBNs = JSON.parse(`[${extracted.replace(/^\[|\]$/g, '')}]`);
    } else {
      // Tentative de parsing direct
      matchingISBNs = JSON.parse(cleanResponse);
    }
    
    // Validation des ISBN
    if (Array.isArray(matchingISBNs)) {
      matchingISBNs = matchingISBNs.filter(isbn => 
        typeof isbn === 'string' && isbn.length > 0
      );
      console.log(`🤖 ${matchingISBNs.length} ISBN extraits avec succès`);
    } else {
      matchingISBNs = [];
    }
    
  } catch (parseError) {
    console.error('JSON parsing error:', parseError);
    console.error('Réponse problématique:', aiResponse);
    
    // Tentative de récupération : extraire les ISBN manuellement
    const isbnPattern = /["']?(\d{10,13})["']?/g;
    matchingISBNs = [];
    let match;
    while ((match = isbnPattern.exec(aiResponse)) !== null) {
      matchingISBNs.push(match[1]);
    }
    
    console.log(`🔧 Récupération: ${matchingISBNs.length} ISBN trouvés par pattern matching`);
  }
  
  return matchingISBNs || [];
}
