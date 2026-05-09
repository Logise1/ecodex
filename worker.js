export default {
  async fetch(request, env) {
    // =========================================================
    // CONFIG CORS
    // =========================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // =========================================================
    // ENDPOINT
    // =========================================================
    if (request.method === "POST" && url.pathname === "/api/scan") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");
        const location = formData.get("location") || "Ubicación desconocida";

        if (!file) {
          return new Response(
            JSON.stringify({
              error: "No se recibió ninguna imagen.",
            }),
            {
              status: 400,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            }
          );
        }

        // =========================================================
        // CONVERTIR IMAGEN A BASE64
        // =========================================================
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        let binaryString = "";

        for (let i = 0; i < uint8Array.length; i += 8192) {
          binaryString += String.fromCharCode.apply(
            null,
            uint8Array.subarray(i, i + 8192)
          );
        }

        const base64Data = btoa(binaryString);

        // =========================================================
        // FASE 1 - GEMINI VISION
        // =========================================================
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `Identifica el ser vivo. La foto fue tomada en: ${location}. Si tienes dudas sobre la especie exacta, proporciona la más probable basada en esta ubicación.
Devuelve SOLO JSON válido.
Sin markdown.
Sin explicaciones.

Formato:
{"nombre":"","especie":"","estado":"LC|NT|VU|EN|CR|EW|EX|UNKNOWN"}`,
                    },
                    {
                      inlineData: {
                        mimeType: file.type || "image/jpeg",
                        data: base64Data,
                      },
                    },
                  ],
                },
              ],

              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.2,
              },
            }),
          }
        );

        // =========================================================
        // ERROR GEMINI
        // =========================================================
        if (!geminiRes.ok) {
          const errorText = await geminiRes.text();

          throw new Error(
            `Fallo en IA Visión (Gemini). Código ${geminiRes.status}: ${errorText}`
          );
        }

        const geminiRawData = await geminiRes.json();

        let geminiData;

        try {
          const extractedText =
            geminiRawData.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!extractedText) {
            throw new Error("Gemini no devolvió texto.");
          }

          geminiData = JSON.parse(
            extractedText
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim()
          );
        } catch (parseError) {
          throw new Error(
            "La IA de visión no devolvió JSON válido."
          );
        }

        // =========================================================
        // SI NO IDENTIFICA NADA
        // =========================================================
        if (
          geminiData.estado === "UNKNOWN" ||
          !geminiData.nombre
        ) {
          return new Response(
            JSON.stringify({
              nombre: "Desconocido",
              especie: "No identificada",
              estado: "UNKNOWN",
              descripcion: "No identificable.",
              habitat: "?",
              dieta: "?",
              categoria: "Otro",
            }),
            {
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            }
          );
        }

        // =========================================================
        // FASE 2 - MISTRAL
        // =========================================================
        const mistralRes = await fetch(
          "https://api.mistral.ai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
            },

            body: JSON.stringify({
              model: "mistral-small-latest",

              messages: [
                {
                  role: "user",
                  content: `Actúa como biólogo.

Especie:
${geminiData.nombre} (${geminiData.especie})

Devuelve SOLO JSON válido:

{
  "descripcion":"Breve info",
  "habitat":"Dónde vive",
  "dieta":"Qué come",
  "categoria":"Mamíferos|Aves|Reptiles|Anfibios|Peces|Insectos|Plantas|Hongos|Otro"
}`,
                },
              ],

              response_format: {
                type: "json_object",
              },

              temperature: 0.3,
            }),
          }
        );

        // =========================================================
        // ERROR MISTRAL
        // =========================================================
        if (!mistralRes.ok) {
          const errorText = await mistralRes.text();

          throw new Error(
            `Fallo en IA Conocimiento (Mistral). Código ${mistralRes.status}: ${errorText}`
          );
        }

        const mistralRawData = await mistralRes.json();

        let mistralData;

        try {
          const extractedText =
            mistralRawData.choices?.[0]?.message?.content;

          if (!extractedText) {
            throw new Error("Mistral no devolvió texto.");
          }

          mistralData = JSON.parse(
            extractedText
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim()
          );
        } catch (parseError) {
          throw new Error(
            "La IA de conocimiento no devolvió JSON válido."
          );
        }

        // =========================================================
        // RESPUESTA FINAL
        // =========================================================
        return new Response(
          JSON.stringify({
            ...geminiData,
            ...mistralData,
          }),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error.message || "Error interno.",
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // =========================================================
    // 404
    // =========================================================
    return new Response(
      "Endpoint no encontrado. Usa /api/scan",
      {
        status: 404,
        headers: corsHeaders,
      }
    );
  },
};