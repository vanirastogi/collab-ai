import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { slug, source = "manual", roomId } = body;
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const db = createClient();

  // Get problem_id and xp
  const { data: prob, error: probErr } = await db
    .from("dsa_problems")
    .select("id, xp")
    .eq("slug", slug)
    .single();

  if (probErr || !prob) {
    return Response.json({ error: "Problem not found" }, { status: 404 });
  }

  // Upsert into solves
  const { error: solveErr } = await db.from("dsa_solves").upsert(
    {
      user_id: userId,
      problem_id: prob.id,
      source,
      room_id: roomId,
    },
    { onConflict: "user_id,problem_id" }
  );

  if (solveErr) {
    console.error("[POST /api/dsa/solve]", solveErr);
    return Response.json({ error: solveErr.message }, { status: 500 });
  }

  return Response.json({ success: true, xp: prob.xp });
}
