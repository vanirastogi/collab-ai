import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

interface RouteContext {
  params: { id: string };
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const problemId = parseInt(params.id, 10);
  if (isNaN(problemId)) {
    return Response.json({ error: "Invalid problem ID" }, { status: 400 });
  }

  const db = createClient();

  // First, delete any solves associated with this problem to avoid foreign key constraints
  const { error: solveDeleteErr } = await db
    .from("dsa_solves")
    .delete()
    .eq("problem_id", problemId);

  if (solveDeleteErr) {
    console.error("[DELETE /api/dsa/problems/[id]] solves:", solveDeleteErr);
    return Response.json({ error: solveDeleteErr.message }, { status: 500 });
  }

  // Next, delete the problem itself
  const { error: probDeleteErr } = await db
    .from("dsa_problems")
    .delete()
    .eq("id", problemId);

  if (probDeleteErr) {
    console.error("[DELETE /api/dsa/problems/[id]] problem:", probDeleteErr);
    return Response.json({ error: probDeleteErr.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
