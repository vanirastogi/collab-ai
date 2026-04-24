import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = createClient();

  const { data: solves, error } = await db
    .from("dsa_solves")
    .select(`
      solved_at,
      source,
      dsa_problems ( slug, xp )
    `)
    .eq("user_id", userId);

  if (error) {
    console.error("[GET /api/dsa/progress]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const solvedSlugs = new Set<string>();
  let totalXP = 0;
  const solveDates = new Set<string>(); // "YYYY-MM-DD"

  for (const s of (solves ?? [])) {
    const prob = Array.isArray(s.dsa_problems) ? s.dsa_problems[0] : s.dsa_problems;
    if (!prob) continue;
    
    if (!solvedSlugs.has(prob.slug)) {
      solvedSlugs.add(prob.slug);
      totalXP += prob.xp;
    }

    if (s.solved_at) {
      const d = new Date(s.solved_at);
      // Adjust to user's local timezone if needed, here using UTC string simply
      solveDates.add(d.toISOString().split("T")[0]);
    }
  }

  // Calculate streak
  let streak = 0;
  const today = new Date();
  
  // Go backwards day by day from today
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dStr = d.toISOString().split("T")[0];
    
    if (solveDates.has(dStr)) {
      streak++;
    } else if (i === 0) {
      // If today is missing, streak might still be intact from yesterday, so we continue to check yesterday.
      // E.g. solved yesterday, haven't solved today yet -> streak is what we had yesterday.
    } else {
      break;
    }
  }

  return Response.json({
    solved: Array.from(solvedSlugs),
    streak,
    totalXP
  });
}
