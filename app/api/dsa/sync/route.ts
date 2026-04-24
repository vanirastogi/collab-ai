import { auth } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase";

export async function POST() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = createClient();

  // 1. Get lc_username
  const { data: profile } = await db
    .from("user_profiles")
    .select("lc_username")
    .eq("user_id", userId)
    .single();

  if (!profile?.lc_username) {
    return Response.json({ error: "no username linked" }, { status: 400 });
  }

  // 2. Fetch from LeetCode GraphQL
  const lcRes = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($u:String!){ 
        recentAcSubmissionList(username:$u,limit:50){ titleSlug timestamp } 
      }`,
      variables: { u: profile.lc_username },
    }),
  });

  if (!lcRes.ok) {
    return Response.json({ error: "Failed to fetch from LeetCode" }, { status: 502 });
  }

  const lcData = await lcRes.json();
  const submissions: { titleSlug: string; timestamp: string }[] =
    lcData?.data?.recentAcSubmissionList || [];

  if (submissions.length === 0) {
    return Response.json({ newlySynced: 0, totalSolved: 0 });
  }

  // 3. Cross-reference with dsa_problems
  const lcSlugs = submissions.map((s) => s.titleSlug);
  const { data: problems } = await db
    .from("dsa_problems")
    .select("id, slug")
    .in("slug", lcSlugs);

  if (!problems || problems.length === 0) {
    return Response.json({ newlySynced: 0, totalSolved: 0 });
  }

  // Create lookup for problem ID to LeetCode submission
  // LeetCode timestamp is Unix seconds, convert to milliseconds for JS Date
  const slugToSub = new Map(submissions.map((s) => [s.titleSlug, s]));

  const upserts = problems.map((prob) => {
    const sub = slugToSub.get(prob.slug)!;
    return {
      user_id: userId,
      problem_id: prob.id,
      source: "leetcode",
      solved_at: new Date(parseInt(sub.timestamp) * 1000).toISOString(),
    };
  });

  // 4. Bulk upsert
  const { error: upsertErr } = await db.from("dsa_solves").upsert(upserts, {
    onConflict: "user_id,problem_id",
  });

  if (upsertErr) {
    console.error("[POST /api/dsa/sync]", upsertErr);
    return Response.json({ error: upsertErr.message }, { status: 500 });
  }

  // Count total solved to return
  const { count } = await db
    .from("dsa_solves")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  return Response.json({
    newlySynced: upserts.length, // This might include overwrites/updates, but it's a good proxy
    totalSolved: count || 0,
  });
}
