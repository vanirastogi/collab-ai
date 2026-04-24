import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

export async function GET() {
  const db = createClient();
  const { data, error } = await db
    .from("dsa_problems")
    .select("*")
    .order("id", { ascending: true });

  if (error) {
    console.error("[GET /api/dsa/problems]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json(data);
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { slug, title, difficulty, topic } = body;
  if (!slug || !title || !difficulty || !topic) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  let xp = 10;
  if (difficulty === "Medium") xp = 25;
  if (difficulty === "Hard") xp = 50;

  const db = createClient();
  const { data, error } = await db
    .from("dsa_problems")
    .insert({ slug, title, difficulty, topic, xp })
    .select()
    .single();

  if (error) {
    console.error("[POST /api/dsa/problems]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data, { status: 201 });
}
