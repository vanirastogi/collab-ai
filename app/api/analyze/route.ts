import OpenAI from "openai";

const groq = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey:  process.env.GROQ_API_KEY,
});

const ANALYZE_MODEL = "llama-3.3-70b-versatile";

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
    const completion = await groq.chat.completions.create({
      model:      ANALYZE_MODEL,
      stream:     false,
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: description },
      ],
    });

    const analysis = completion.choices[0]?.message?.content?.trim() ?? "";
    return Response.json({ analysis });
  } catch (err) {
    console.error("[/api/analyze] Groq error:", err);
    const message = err instanceof Error ? err.message : "Groq request failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
