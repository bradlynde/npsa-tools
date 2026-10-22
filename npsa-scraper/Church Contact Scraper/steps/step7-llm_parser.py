"""
STEP 7: LLM PARSING
===================
Send HTML chunks to LLM and extract contacts in CSV format.

Input: HTML chunk from Step 6
Output: CSV text with contacts
"""

import anthropic
import time
from typing import List, Dict
import re

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


CSV_HEADER = "First Name,Last Name,Title,Email,Phone"


def _response_text(response) -> str:
    """Join the text blocks of a Claude response (skips any non-text blocks)."""
    return "".join(
        getattr(block, "text", "") for block in response.content
        if getattr(block, "type", None) == "text"
    )


def _retry_after_seconds(error, default: float = 1.0) -> float:
    """Seconds to wait after a 429, from the retry-after header (+0.5s buffer)."""
    try:
        value = error.response.headers.get("retry-after")
        if value:
            return float(value) + 0.5
    except Exception:
        pass
    return default


# Step 7: Extract ALL contacts (NO filtering - that happens in Step 10)
CONTACT_EXTRACTION_PROMPT = """
You extract ALL PEOPLE from raw HTML. Do not hallucinate or invent data.

INPUT:
- Full HTML from a single web page or a contiguous chunk of HTML.
- The page may contain people in cards, tables, lists, or text blocks.
- Ignore organization names, departments, and generic contact emails.

OUTPUT:
Return ONLY CSV text (no backticks, no explanations) in this exact format:

First Name,Last Name,Title,Email,Phone

GENERAL RULES:
- Extract only real people, never departments, committees, buildings, teams, or offices.
- A valid contact MUST have at least a first and last name.
- Keep each person's name, title, email, and phone correctly matched.
- If a field is missing, leave it blank but keep the comma.
- If no valid contacts are found, return ONLY the header.

HEADER (always the first line):
First Name,Last Name,Title,Email,Phone

STEP-BY-STEP:
1. Identify all blocks that look like people entries (name + title, often near an email).
2. For each candidate person:
   - Extract full name (first + last). Remove prefixes like Dr., Mr., Mrs., Ms., Rev., Fr., Sr.
   - Extract the associated title / role (extract whatever title is shown, even if it's "Teacher", "Coach", "Board Member", etc.)
   - Extract the nearest email (usually mailto:). Skip generic inboxes (info@, office@, contact@, admissions@, marketing@, communications@).
   - Extract phone only if clearly linked to that person; otherwise leave blank.

NAME RULES:
- Valid examples:
  - "Dr. Terry Rodgers" → First Name: Terry, Last Name: Rodgers
  - "Mary Jane Watson" → First Name: Mary Jane, Last Name: Watson
  - "Kent A. Means" → First Name: Kent A., Last Name: Means
- If you cannot find a clear first + last name, skip that contact entirely.

TITLE EXTRACTION:
- Extract whatever title/role is shown for the person
- Include ALL titles: teachers, coaches, board members, administrators, etc.
- Do NOT filter by title in this step - extract everyone
- If someone has multiple titles, extract the primary one (or first one listed)

OUTPUT FORMAT (STRICT):
- First line: exactly
  First Name,Last Name,Title,Email,Phone
- Each subsequent line: one contact, 5 comma-separated fields.
- Use quotes only if a field contains a comma.
- No markdown, no commentary, no extra text.

IMPORTANT: Extract ALL people with names and titles. Do NOT filter by role - that filtering happens in a later step.
"""


class LLMParser:
    """Send HTML chunks to LLM and extract contacts."""
    
    def __init__(self, api_key: str, model: str = "claude-haiku-5-5"):
        """
        Initialize LLM parser
        
        Args:
            api_key: Anthropic API key
            model: Model to use (default: claude-haiku-5-5)
        """
        self.api_key = api_key
        self.model = model
        # Note: timeout removed to avoid "signal only works in main thread" error when running in background threads
        self.client = anthropic.Anthropic(api_key=api_key)
        self.total_api_calls = 0
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
    
    def parse_with_llm(self, html_chunk: str, church_name: str, url: str, max_retries: int = 1) -> str:
        """
        Send HTML chunk to LLM and get CSV response
        
        Args:
            html_chunk: HTML chunk to parse
            church_name: Church name (metadata)
            url: Page URL (metadata)
            max_retries: Maximum retry attempts
            
        Returns:
            CSV text from LLM (or empty string on error)
        """
        for attempt in range(max_retries):
            try:
                # Build user message with metadata and HTML chunk only
                user_message = f"""CHURCH NAME: {church_name}
PAGE URL: {url}

HTML CONTENT:
{html_chunk}"""
                
                # Estimate tokens for max_tokens calculation
                estimated_input_tokens = len(html_chunk) // 4
                
                # Safety check: if chunk is still too large, it should have been split earlier
                # But as a final safeguard, we'll note it (shouldn't happen with improved chunking)
                if len(html_chunk) > 100000:
                    from church_run_log import log_warn

                    log_warn(
                        f"HTML chunk large ({len(html_chunk):,} chars) — should have been split earlier"
                    )
                
                # Set max_tokens based on input size
                if estimated_input_tokens > 20000:
                    max_tokens = 32000
                elif estimated_input_tokens > 10000:
                    max_tokens = 16000
                else:
                    max_tokens = 8000
                
                # Note: Removed signal-based timeout as it doesn't work in background threads
                # The Anthropic library will handle timeouts internally if needed.
                # Streamed because the SDK refuses non-streaming requests with
                # max_tokens above ~21K; get_final_message() returns the full reply.
                # Thinking is off to match the old non-reasoning model's behavior
                # and token budget (Claude Haiku 5.5 rejects non-default temperature).
                with self.client.messages.stream(
                    model=self.model,
                    system=CONTACT_EXTRACTION_PROMPT,
                    messages=[
                        {"role": "user", "content": user_message}
                    ],
                    thinking={"type": "disabled"},
                    max_tokens=max_tokens
                ) as stream:
                    response = stream.get_final_message()
                
                # Extract response text
                response_text = _response_text(response).strip()
                # Drop any preamble before the CSV header so the CSV parser sees the header first
                header_pos = response_text.find(CSV_HEADER)
                if header_pos > 0:
                    response_text = response_text[header_pos:]
                self.total_api_calls += 1
                u = getattr(response, "usage", None)
                if u is not None:
                    self.total_prompt_tokens += int(getattr(u, "input_tokens", 0) or 0)
                    self.total_completion_tokens += int(
                        getattr(u, "output_tokens", 0) or 0
                    )

                return response_text
                
            except anthropic.APITimeoutError:
                from church_run_log import log_warn

                log_warn(f"Claude timeout (attempt {attempt + 1}/{max_retries})")
                if attempt < max_retries - 1:
                    time.sleep(1.0)
                    continue
                return ""

            except anthropic.RateLimitError as e:
                from church_run_log import log_warn

                wait_seconds = _retry_after_seconds(e)
                if attempt < max_retries - 1:
                    log_warn(
                        f"Claude rate limit (attempt {attempt + 1}/{max_retries}), wait {wait_seconds:.1f}s"
                    )
                    time.sleep(wait_seconds)
                    continue
                log_warn("Claude rate limit exceeded — skipping chunk")
                return ""

            except (anthropic.APIStatusError, anthropic.APIConnectionError, Exception) as e:
                from church_run_log import log_warn

                if attempt < max_retries - 1:
                    wait_time = 2**attempt
                    log_warn(
                        f"Claude error (attempt {attempt + 1}/{max_retries}): {e}, retry {wait_time}s"
                    )
                    time.sleep(wait_time)
                    continue
                log_warn(f"Claude error: {e}")
                return ""
        
        return ""
