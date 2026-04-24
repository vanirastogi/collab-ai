import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

interface RouteContext {
  params: { id: string };
}

// ── GET /api/rooms/[id] ────────────────────────────────────────────────────────
// Load full room state (code, whiteboard, language) for initial mount.
export async function GET(_req: Request, { params }: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = createClient();

  const { data, error } = await db
    .from("rooms")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error || !data) {
    return Response.json({ error: "Room not found" }, { status: 404 });
  }

  return Response.json(data);
}

// ── PUT /api/rooms/[id] ────────────────────────────────────────────────────────
// Auto-save: update code / whiteboard / language / name.
// Also upserts the caller into room_members so joining via URL is tracked.
export async function PUT(req: Request, { params }: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = createClient();

  // Build only the fields that were sent in the body
  const updates: Record<string, unknown> = { last_active: new Date().toISOString() };
  if (body.code       !== undefined) updates.code       = body.code;
  if (body.language   !== undefined) updates.language   = body.language;
  if (body.whiteboard !== undefined) updates.whiteboard = body.whiteboard;
  if (body.name       !== undefined) updates.name       = body.name;

  const { error: updateErr } = await db
    .from("rooms")
    .update(updates)
    .eq("id", params.id);

  if (updateErr) {
    console.error("[PUT /api/rooms/[id]] update:", updateErr);
    return Response.json({ error: updateErr.message }, { status: 500 });
  }

  // Upsert the member record so joining a room by URL is always tracked
  const userName = typeof body.userName === "string" ? body.userName : undefined;
  await db.from("room_members").upsert(
    { room_id: params.id, user_id: userId, user_name: userName },
    { onConflict: "room_id,user_id" }
  );

  return Response.json({ success: true });
}
