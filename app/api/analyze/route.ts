import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const ANALYZE_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT =
  "You are a software architect. The user describes a diagram on a whiteboard. " +
  "Analyze it: identify the architecture pattern, name potential issues, suggest " +
  "2 improvements. Reply in plain prose, under 120 words. No bullet points, no markdown.";

export async function POST(req: Request) {
  let description: string;

  try {
    ({ description } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!description?.trim()) {
    return Response.json({ error: "description is required" }, { status: 400 });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: ANALYZE_MODEL,
      systemInstruction: SYSTEM_PROMPT
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: description }] }],
      generationConfig: { maxOutputTokens: 200 }
    });

    const analysis = result.response.text().trim();
    return Response.json({ analysis });
  } catch (err) {
    console.error("[/api/analyze] Groq error:", err);
    const message = err instanceof Error ? err.message : "Groq request failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
