import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const REVIEW_MODEL = "gemini-1.5-flash";

const SYSTEM_PROMPT = `You are a senior code reviewer. Analyse the code and return ONLY valid JSON in this exact shape, with no markdown fences or extra text:
{
  "summary": "one-sentence overview of the code",
  "issues": [
    {
      "line": <number>,
      "severity": "error" | "warning" | "info",
      "message": "what is wrong",
      "fix": "how to fix it"
    }
  ],
  "score": <number 1-10>,
  "suggestions": ["improvement 1", "improvement 2"]
}
Be concise. If there are no issues return an empty array. Score 10 means perfect.`;

export async function POST(req: Request) {
  let code: string;
  let language: string;

  try {
    ({ code, language } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!code?.trim()) {
    return Response.json({ error: "code is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const model = genAI.getGenerativeModel({ 
          model: REVIEW_MODEL,
          systemInstruction: SYSTEM_PROMPT 
        });

        const promptText = `Language: ${language}\n\n\`\`\`${language}\n${code}\n\`\`\``;
        const result = await model.generateContentStream(promptText);

        for await (const chunk of result.stream) {
          const token = chunk.text();
          if (token) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(token)}\n\n`)
            );
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("[/api/review] Groq error:", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}
