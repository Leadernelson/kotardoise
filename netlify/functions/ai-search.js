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

    // Compress the dataset into a token-efficient form but still include ALL books.
    // We use short keys and truncate long free-text fields. This preserves the
    // full catalogue while drastically reducing token usage so the LLM can
    // consume the entire dataset in one request.

    function compactBooks(books) {
      return books.map(b => {
        // Normalize common keys and fallbacks
        const isbn = (b.isbn || b.ISBN || b.code || b.id || '') + '';
        const title = (b.title || b.name || '').replace(/\s+/g, ' ').trim();
        const author = (b.author || b.authors || b.writer || '').toString().replace(/\s+/g, ' ').trim();
        const desc = (b.description || b.summary || b.notes || '').replace(/\s+/g, ' ').trim();
        const chars = (Array.isArray(b.characters) ? b.characters.join(', ') : (b.characters || b.people || '')).toString().replace(/\s+/g, ' ').trim();
        const tags = (b.tags || b.genres || b.categories || []).slice(0,6);

        return {
          i: isbn || '',     // i = isbn
          t: title.slice(0, 140), // t = title (truncate)
          a: author.slice(0, 80), // a = author (truncate)
          d: desc.slice(0, 300), // d = description (truncate)
          c: chars.slice(0, 200), // c = characters (truncate)
          g: tags // g = genres/tags (small array)
        };
      });
    }

    const compacted = compactBooks(booksData);

    // Minimal JSON string (no spacing) to reduce token count further
    const compactJson = JSON.stringify(compacted);

    const prompt = `You are a precise librarian assistant. The user query: "${query}".

Dataset format (compact):
- i = ISBN
- t = title
- a = author
- d = description (truncated)
- c = characters
- g = genres/tags

Analyze ALL the provided books (the full compact dataset below) and return a single JSON array of ISBN strings (e.g. ["978...","..."]), ordered by relevance descending. If none match, return an empty array [].

Be strict: output ONLY valid JSON array (no commentary, no markdown).

DATA:
${compactJson}
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
          // Deterministic and conservative sampling to encourage strict JSON output
          temperature: 0.0,
          topK: 1,
          topP: 0.2,
          maxOutputTokens: 1024,
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
