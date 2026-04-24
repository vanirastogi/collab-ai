import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";
import { nanoid } from "nanoid";

// ── GET /api/rooms ─────────────────────────────────────────────────────────────
// Returns all rooms the signed-in user has ever joined, newest first.
export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = createClient();

  // Step 1: get room IDs this user belongs to
  const { data: memberships, error: memberErr } = await db
    .from("room_members")
    .select("room_id")
    .eq("user_id", userId);

  if (memberErr) {
    console.error("[GET /api/rooms] memberships:", memberErr);
    return Response.json({ error: memberErr.message }, { status: 500 });
  }

  const roomIds = (memberships ?? []).map((m) => m.room_id as string);
  if (roomIds.length === 0) return Response.json([]);

  // Step 2: fetch those rooms ordered by most recently active
  const { data, error } = await db
    .from("rooms")
    .select("id, name, language, last_active, member_count")
    .in("id", roomIds)
    .order("last_active", { ascending: false });

  if (error) {
    console.error("[GET /api/rooms]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
}

// ── POST /api/rooms ────────────────────────────────────────────────────────────
// Creates a new room and adds the creator as a member.
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let name = "Untitled Room";
  let language = "javascript";
  let userName = "Anonymous";

  try {
    const body = await req.json();
    if (body.name)     name     = body.name;
    if (body.language) language = body.language;
    if (body.userName) userName = body.userName;
  } catch {
    // Body is optional — defaults above apply
  }

  const id = nanoid(8);
  const db = createClient();

  const { error: roomErr } = await db
    .from("rooms")
    .insert({ id, name, created_by: userId, language });

  if (roomErr) {
    console.error("[POST /api/rooms] insert room:", roomErr);
    return Response.json({ error: roomErr.message }, { status: 500 });
  }

  const { error: memberErr } = await db
    .from("room_members")
    .insert({ room_id: id, user_id: userId, user_name: userName });

  if (memberErr) {
    console.error("[POST /api/rooms] insert member:", memberErr);
    return Response.json({ error: memberErr.message }, { status: 500 });
  }

  return Response.json({ id, name }, { status: 201 });
}
