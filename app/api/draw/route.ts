import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const DRAW_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `You are a diagramming assistant. Output ONLY a valid JSON array — no markdown, no explanation, no prose.
Each element must be exactly one of:
  { "type": "box", "label": "short name", "x": <number>, "y": <number> }
  { "type": "arrow", "from": "<label>", "to": "<label>" }

Rules:
- Canvas is ~1200x700 px. Spread boxes so they do not overlap. Default box is 140x52 px.
- x,y is the top-left corner of the box.
- "from" and "to" must exactly match a label of a box (existing or newly added in this response).
- Return ONLY new objects — never repeat existing ones.
- Keep labels concise (1-3 words, title-case).`;

export type DrawObject =
  | { type: "box";   label: string; x: number; y: number; width?: number; height?: number }
  | { type: "arrow"; from: string;  to: string };

export async function POST(req: Request) {
  let command: string, context: string;
  try {
    ({ command, context } = await req.json());
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!command?.trim()) {
    return Response.json({ error: "command is required" }, { status: 400 });
  }

  try {
    const model = genAI.getGenerativeModel({ 
      model: DRAW_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" }
    });

    const promptText = `Existing boxes on canvas: ${context || "none"}\n\nCommand: ${command}`;
    const result = await model.generateContent(promptText);
    const raw = result.response.text().trim();
    const start = raw.indexOf("[");
    const end   = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) {
      return Response.json({ objects: [] });
    }
    const objects: DrawObject[] = JSON.parse(raw.slice(start, end + 1));
    return Response.json({ objects: Array.isArray(objects) ? objects : [] });
  } catch (err) {
    console.error("[/api/draw]", err);
    const message = err instanceof Error ? err.message : "Failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
