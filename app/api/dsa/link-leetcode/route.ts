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

  const { lcUsername } = body;
  if (!lcUsername) return Response.json({ error: "Missing lcUsername" }, { status: 400 });

  const db = createClient();

  // For userName, we could fetch from Clerk or pass from frontend. Let's just update lc_username.
  const { error } = await db.from("user_profiles").upsert(
    {
      user_id: userId,
      lc_username: lcUsername,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("[POST /api/dsa/link-leetcode]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
