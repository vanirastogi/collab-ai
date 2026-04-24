// JDoodle Compiler API — free tier, 200 runs/day, no credit card required.
// Docs: https://www.jdoodle.com/compiler-api/
const JDOODLE_URL = "https://api.jdoodle.com/v1/execute";

// Map Monaco language IDs → JDoodle language + versionIndex.
// versionIndex selects the compiler version; "0" is always the latest stable.
const LANGUAGE_MAP: Record<string, { language: string; versionIndex: string }> = {
  javascript: { language: "nodejs",   versionIndex: "4" },
  typescript: { language: "typescript_nodejs", versionIndex: "1" },
  python:     { language: "python3",  versionIndex: "4" },
  java:       { language: "java",     versionIndex: "4" },
  c:          { language: "c",        versionIndex: "5" },
  cpp:        { language: "cpp17",    versionIndex: "1" },
  csharp:     { language: "csharp",   versionIndex: "4" },
  go:         { language: "go",       versionIndex: "4" },
  rust:       { language: "rust",     versionIndex: "4" },
  ruby:       { language: "ruby",     versionIndex: "4" },
  php:        { language: "php",      versionIndex: "4" },
  swift:      { language: "swift",    versionIndex: "4" },
  kotlin:     { language: "kotlinc",  versionIndex: "3" },
  bash:       { language: "bash",     versionIndex: "4" },
};

export interface RunResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
  language: string;
  cpuTime?: string;
  memory?:  string;
}

export async function POST(req: Request) {
  let code: string, language: string;
  try {
    ({ code, language } = await req.json());
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const mapping = LANGUAGE_MAP[language];
  if (!mapping) {
    return Response.json(
      { error: `"${language}" cannot be executed` },
      { status: 422 }
    );
  }

  try {
    const res = await fetch(JDOODLE_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId:     process.env.JDOODLE_CLIENT_ID,
        clientSecret: process.env.JDOODLE_CLIENT_SECRET,
        script:       code,
        language:     mapping.language,
        versionIndex: mapping.versionIndex,
      }),
    });

    const data = await res.json();

    // JDoodle returns all output (stdout + stderr) in a single "output" field.
    // A non-200 statusCode means a compilation or runtime error.
    const isError = data.statusCode !== 200;
    const result: RunResult = {
      stdout:   isError ? "" : (data.output ?? ""),
      stderr:   isError ? (data.output ?? "Execution failed") : "",
      exitCode: isError ? 1 : 0,
      language: mapping.language,
      cpuTime:  data.cpuTime,
      memory:   data.memory,
    };

    return Response.json(result);
  } catch (err) {
    console.error("[/api/run]", err);
    const message = err instanceof Error ? err.message : "Failed to reach JDoodle";
    return Response.json({ error: message }, { status: 502 });
  }
}
