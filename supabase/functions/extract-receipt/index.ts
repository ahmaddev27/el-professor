import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ExtractedReceipt {
  date?: string;          // ISO yyyy-MM-dd
  time?: string;          // HH:mm
  receiptNumber?: string;
  amount?: number;        // final total in EUR
  postalCode?: string;    // 5-digit German PLZ
  city?: string;
  category?: string;      // e.g. "Tanken"
  merchantName?: string;
  confidence?: "high" | "medium" | "low";
  raw?: string;           // debug: what was seen on the receipt
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const { imageBase64, mediaType } = body as {
      imageBase64: string;
      mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    };

    if (!imageBase64 || !mediaType) {
      return new Response(
        JSON.stringify({ error: "imageBase64 and mediaType are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const client = new Anthropic({ apiKey });

    const prompt = `You are a receipt data extractor for a German taxi/transport company.

Analyze this receipt image carefully and extract the following information.
Return ONLY a valid JSON object with these exact keys (omit any key you cannot determine with reasonable confidence):

{
  "date": "YYYY-MM-DD",          // receipt date
  "time": "HH:MM",               // receipt time (24-hour)
  "receiptNumber": "string",     // Belegnummer, Bon-Nr., receipt number, or similar
  "amount": number,              // FINAL total amount in EUR as a decimal number (Gesamtbetrag / Brutto / Total). Do NOT use Netto, MwSt, or per-liter price.
  "postalCode": "string",        // 5-digit German postal code (PLZ)
  "city": "string",              // city name
  "category": "string",          // one of: "Tanken", "Autowäsche", "Autozubehör", "Öl wechseln", "Other"
  "merchantName": "string",      // store/station name
  "confidence": "high"|"medium"|"low"  // your overall confidence in the extraction
}

Rules:
- For fuel/petrol/diesel receipts → category = "Tanken"
- For car wash receipts → category = "Autowäsche"
- For oil change receipts → category = "Öl wechseln"
- When uncertain about category → category = "Other"
- For amount: if multiple totals exist, use the FINAL payable amount (Gesamtbetrag, Endbetrag, Brutto, Total, Zu zahlen). Never use Netto, MwSt, or price per liter.
- German date format "26.04.2026" → "2026-04-26"
- Return ONLY the JSON object, no markdown, no explanation.`;

    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    // Strip any markdown fences if present
    let rawText = textBlock.text.trim();
    rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let extracted: ExtractedReceipt;
    try {
      extracted = JSON.parse(rawText);
    } catch {
      // If JSON parse fails, return partial success with raw text for debugging
      return new Response(
        JSON.stringify({
          success: false,
          error: "Could not parse extraction result",
          raw: rawText,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: extracted }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
