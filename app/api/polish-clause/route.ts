import { NextRequest, NextResponse } from "next/server";

/**
 * API route for polishing custom clauses with AI.
 * Uses ANTHROPIC_API_KEY from env (Claude Messages API). Set in Vercel: Settings → Environment Variables.
 * The client never touches this file — they edit LOEGenerator.tsx only.
 */
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing or invalid text" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set");
      return NextResponse.json(
        { error: "AI polish is not configured. Add ANTHROPIC_API_KEY to Vercel environment variables." },
        { status: 503 }
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1000,
        // Thinking is on by default on Haiku 5.5 and would count against
        // max_tokens; this was a non-reasoning rewrite, so keep it off.
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: `You are a legal contract drafting assistant for Nonprofit Security Advisors. Rewrite the following rough clause into polished, professional legal contract language. Return ONLY the polished clause text.

Rough clause: ${text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Claude API error:", response.status, err);
      return NextResponse.json(
        { error: "AI service error. Please try again." },
        { status: 502 }
      );
    }

    const data = await response.json();
    const polished =
      (Array.isArray(data.content)
        ? data.content
            .filter((b: { type?: string }) => b?.type === "text")
            .map((b: { text?: string }) => b.text || "")
            .join("")
        : ""
      ).trim() || "Error generating clause.";

    return NextResponse.json({ polished });
  } catch (err) {
    console.error("Polish clause error:", err);
    return NextResponse.json(
      { error: "Error generating clause." },
      { status: 500 }
    );
  }
}
