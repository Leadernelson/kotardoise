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
Tu es un assistant bibliothécaire intelligent. Voici une liste de livres disponibles dans notre bibliothèque :

${JSON.stringify(booksData, null, 2)}

L'utilisateur recherche : "${query}"

Analyse cette demande et retourne UNIQUEMENT un tableau JSON contenant les ISBN des livres qui correspondent le mieux à la description de l'utilisateur. 

Critères de recherche :
- Titre du livre
- Nom de l'auteur  
- Genre littéraire
- Thème ou sujet
- Période historique
- Style d'écriture
- Tout autre élément descriptif pertinent

Retourne maximum 10 résultats, triés par pertinence. Format de réponse attendu :
["ISBN1", "ISBN2", "ISBN3", ...]

Si aucun livre ne correspond, retourne un tableau vide : []
`;

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
          temperature: 0.3,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const aiResponse = data.candidates[0].content.parts[0].text;
    
    // Extraire le JSON de la réponse
    let matchingISBNs;
    try {
      const jsonMatch = aiResponse.match(/\[(.*?)\]/s);
      if (jsonMatch) {
        matchingISBNs = JSON.parse(`[${jsonMatch[1]}]`);
      } else {
        matchingISBNs = JSON.parse(aiResponse);
      }
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      matchingISBNs = [];
    }

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
