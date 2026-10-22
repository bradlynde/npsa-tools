"""
STEP 10: FILTER CONTACTS BY TITLE (LLM-BASED FILTERING)
=======================================================
Filter contacts from Step 9 to keep only church administrative/leadership roles.

Uses LLM to determine if a contact is administrative based on their title.
Supports batched LLM calls (batch_size=10) for ~8x faster processing with
98% accuracy vs single-contact calls (tested on 50 contacts).

Input: CSV from Step 9 with ALL extracted contacts (no filtering)
Output: CSV with filtered contacts (only church administrative/leadership roles)
"""

import anthropic
import pandas as pd
import csv
import io
import time
import os
import sys
from typing import List, Dict, Optional
import re

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


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


# Title filtering prompt - single contact mode
TITLE_FILTERING_PROMPT = """
You are a title classifier for church administrative contacts.

Your job is to determine if a contact's title indicates they are an ADMINISTRATIVE/LEADERSHIP role at a church.

INPUT:
- A contact with: First Name, Last Name, Title, Email (optional), Phone (optional)

OUTPUT:
Return ONLY one word: "KEEP" or "EXCLUDE"

RULES:

KEEP if the title indicates church administrative/leadership responsibility. Examples:
- Administrative Pastor, Associate Pastor, Business Administrator, Campus Pastor
- Church Administrator, Director of Operations, Executive Pastor, Facilities Director
- Lead Pastor, Operations Director, Security Coordinator, Security Director
- Senior Pastor, IT Director, Technology Director
- Pastor (senior, lead, executive, administrative, associate, campus - all pastor roles)
- Minister (senior, associate - ministry leadership)
- Priest, Rector, Vicar (clergy leadership)
- Director roles (operations, technology, facilities, security, finance, HR)
- Chief roles (CEO, CFO, COO, CTO, Chief of Staff)
- Church Administrator, Business Manager, Operations Manager
- Elder, Deacon (if clearly administrative/leadership)

EXCLUDE if the title contains ANY of these (case-insensitive):
- teacher, faculty, instructor, professor, tutor, aide, para (instructional roles)
- counselor, counselling, psychologist, therapist (unless church staff counselor)
- admissions, admission, enrollment, registrar, recruiting, outreach
- marketing, communications, media, social media, pr, public relations
- athletic, athletics, coach, sports, pe, physical education
- secretary, administrative assistant, office manager, office admin, receptionist, executive assistant
- nurse, health office, nutrition, cafeteria, dining, food service
- youth minister (unless also has admin title), children's minister (unless also has admin title)
- worship leader, music director, choir director (unless also operations/admin)
- board, trustee, governance, chairman, vice-chair, treasurer (if board-only role)
- volunteer, intern, resident (trainee roles)

EXCEPTIONS:
- "Senior Pastor" or "Lead Pastor" or "Executive Pastor" → KEEP
- "Pastor & [something]" → KEEP (pastor is leadership)
- "Director of [Operations/Technology/Facilities]" → KEEP

OUTPUT:
Return ONLY "KEEP" or "EXCLUDE" - nothing else.
"""

# Title filtering prompt - batch mode (multiple contacts per call)
TITLE_FILTERING_PROMPT_BATCH = """
You are a title classifier for church administrative contacts.

Your job is to determine if each contact's title indicates they are an ADMINISTRATIVE/LEADERSHIP role at a church.

KEEP if the title indicates church administrative/leadership responsibility. Examples:
- Administrative Pastor, Associate Pastor, Business Administrator, Campus Pastor
- Church Administrator, Director of Operations, Executive Pastor, Facilities Director
- Lead Pastor, Operations Director, Security Coordinator, Security Director
- Senior Pastor, IT Director, Technology Director
- Pastor (senior, lead, executive, administrative, associate, campus - all pastor roles)
- Minister (senior, associate - ministry leadership)
- Priest, Rector, Vicar (clergy leadership)
- Director roles (operations, technology, facilities, security, finance, HR)
- Chief roles (CEO, CFO, COO, CTO, Chief of Staff)
- Church Administrator, Business Manager, Operations Manager
- Elder, Deacon (if clearly administrative/leadership)

EXCLUDE if the title contains ANY of these (case-insensitive):
- teacher, faculty, instructor, professor, tutor, aide, para (instructional roles)
- counselor, counselling, psychologist, therapist (unless church staff counselor)
- admissions, admission, enrollment, registrar, recruiting, outreach
- marketing, communications, media, social media, pr, public relations
- athletic, athletics, coach, sports, pe, physical education
- secretary, administrative assistant, office manager, office admin, receptionist, executive assistant
- nurse, health office, nutrition, cafeteria, dining, food service
- youth minister (unless also has admin title), children's minister (unless also has admin title)
- worship leader, music director, choir director (unless also operations/admin)
- board, trustee, governance, chairman, vice-chair, treasurer (if board-only role)
- volunteer, intern, resident (trainee roles)

EXCEPTIONS:
- "Senior Pastor" or "Lead Pastor" or "Executive Pastor" → KEEP
- "Pastor & [something]" → KEEP (pastor is leadership)
- "Director of [Operations/Technology/Facilities]" → KEEP

You will receive multiple contacts numbered sequentially. For EACH contact, return KEEP or EXCLUDE on a separate line, in order. Example for 3 contacts:
KEEP
EXCLUDE
KEEP
"""


class TitleFilter:
    """Filter contacts by title using LLM with batch support"""

    def __init__(self, api_key: str, model: str = "claude-haiku-5-5", batch_size: int = 10):
        """
        Initialize title filter

        Args:
            api_key: Anthropic API key
            model: Model to use (default: claude-haiku-5-5)
            batch_size: Number of contacts per LLM call (default: 10, tested optimal)
        """
        self.api_key = api_key
        self.model = model
        self.batch_size = batch_size
        self.client = anthropic.Anthropic(api_key=api_key)
        self.total_api_calls = 0
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0

    def filter_contact(self, contact: Dict, max_retries: int = 3) -> bool:
        """
        Determine if a contact should be kept based on their title (single mode).

        Args:
            contact: Contact dictionary with 'first_name', 'last_name', 'title', etc.
            max_retries: Maximum retry attempts

        Returns:
            True if contact should be kept, False if excluded
        """
        title = contact.get('title', '').strip()
        first_name = contact.get('first_name', '').strip()
        last_name = contact.get('last_name', '').strip()

        # Skip if no title
        if not title:
            return False

        # Skip if no name
        if not first_name or not last_name:
            return False

        for attempt in range(max_retries):
            try:
                # Build user message with contact info
                user_message = f"""First Name: {first_name}
Last Name: {last_name}
Title: {title}"""

                # Thinking off so the one-word answer fits the small cap.
                # (Claude Haiku 5.5 rejects non-default temperature, so none is sent.)
                response = self.client.messages.create(
                    model=self.model,
                    system=TITLE_FILTERING_PROMPT,
                    messages=[
                        {"role": "user", "content": user_message},
                    ],
                    thinking={"type": "disabled"},
                    max_tokens=10,
                )

                self.total_api_calls += 1
                u = getattr(response, "usage", None)
                if u is not None:
                    self.total_prompt_tokens += int(getattr(u, "input_tokens", 0) or 0)
                    self.total_completion_tokens += int(
                        getattr(u, "output_tokens", 0) or 0
                    )

                response_text = _response_text(response).strip().upper()

                # Parse response
                if "KEEP" in response_text:
                    return True
                elif "EXCLUDE" in response_text:
                    return False
                else:
                    from church_run_log import log_warn

                    log_warn(
                        f"Title filter unexpected LLM reply for {first_name} {last_name}: {response_text}"
                    )
                    return False

            except (anthropic.APIStatusError, anthropic.APIConnectionError, Exception) as e:
                from church_run_log import log_warn

                is_rate_limit = isinstance(e, anthropic.RateLimitError)

                if is_rate_limit:
                    wait_seconds = _retry_after_seconds(e)

                    if attempt < max_retries - 1:
                        log_warn(
                            f"Title filter rate limit (attempt {attempt + 1}/{max_retries}), wait {wait_seconds:.1f}s"
                        )
                        time.sleep(wait_seconds)
                        continue
                    log_warn("Title filter rate limit — excluding contact")
                    return False
                else:
                    if attempt < max_retries - 1:
                        wait_time = 2**attempt
                        log_warn(
                            f"Title filter error (attempt {attempt + 1}/{max_retries}): {e}, retry {wait_time}s"
                        )
                        time.sleep(wait_time)
                        continue
                    log_warn(f"Title filter LLM error: {e}")
                    return False

        return False

    def filter_contacts_batch(self, contacts: List[Dict], max_retries: int = 3) -> List[bool]:
        """
        Filter a batch of contacts in a single LLM call.

        Args:
            contacts: List of contact dicts with 'first_name', 'last_name', 'title'
            max_retries: Maximum retry attempts

        Returns:
            List of booleans (True = keep, False = exclude), same order as input
        """
        # Pre-filter: contacts without title or name are auto-excluded
        valid_indices = []
        valid_contacts = []
        results = [False] * len(contacts)

        for i, contact in enumerate(contacts):
            title = str(contact.get('title', '')).strip()
            first_name = str(contact.get('first_name', '')).strip()
            last_name = str(contact.get('last_name', '')).strip()
            if title and first_name and last_name:
                valid_indices.append(i)
                valid_contacts.append(contact)

        if not valid_contacts:
            return results

        # Build batch message
        lines = []
        for j, c in enumerate(valid_contacts):
            lines.append(
                f"Contact {j+1}:\n"
                f"First Name: {str(c.get('first_name', '')).strip()}\n"
                f"Last Name: {str(c.get('last_name', '')).strip()}\n"
                f"Title: {str(c.get('title', '')).strip()}"
            )
        user_message = "\n\n".join(lines)

        for attempt in range(max_retries):
            try:
                response = self.client.messages.create(
                    model=self.model,
                    system=TITLE_FILTERING_PROMPT_BATCH,
                    messages=[
                        {"role": "user", "content": user_message},
                    ],
                    thinking={"type": "disabled"},
                    max_tokens=len(valid_contacts) * 10,
                )

                self.total_api_calls += 1
                u = getattr(response, "usage", None)
                if u is not None:
                    self.total_prompt_tokens += int(getattr(u, "input_tokens", 0) or 0)
                    self.total_completion_tokens += int(
                        getattr(u, "output_tokens", 0) or 0
                    )

                text = _response_text(response).strip()

                # Parse batch response — one KEEP/EXCLUDE per line
                batch_results = []
                for line in text.split('\n'):
                    line = line.strip().upper()
                    if not line:
                        continue
                    if "KEEP" in line:
                        batch_results.append(True)
                    elif "EXCLUDE" in line:
                        batch_results.append(False)

                # If we got the right number of results, map them back
                if len(batch_results) == len(valid_contacts):
                    for idx, keep in zip(valid_indices, batch_results):
                        results[idx] = keep
                    return results
                else:
                    # Mismatch — fall back to single-contact mode for this batch
                    from church_run_log import log_warn
                    log_warn(
                        f"Title filter batch got {len(batch_results)} results for {len(valid_contacts)} contacts, falling back to single mode"
                    )
                    for idx, contact in zip(valid_indices, valid_contacts):
                        results[idx] = self.filter_contact(contact, max_retries=max_retries)
                    return results

            except (anthropic.APIStatusError, anthropic.APIConnectionError, Exception) as e:
                from church_run_log import log_warn

                is_rate_limit = isinstance(e, anthropic.RateLimitError)

                if is_rate_limit:
                    wait_seconds = _retry_after_seconds(e)

                    if attempt < max_retries - 1:
                        log_warn(
                            f"Title filter batch rate limit (attempt {attempt + 1}/{max_retries}), wait {wait_seconds:.1f}s"
                        )
                        time.sleep(wait_seconds)
                        continue
                else:
                    if attempt < max_retries - 1:
                        wait_time = 2**attempt
                        log_warn(
                            f"Title filter batch error (attempt {attempt + 1}/{max_retries}): {e}, retry {wait_time}s"
                        )
                        time.sleep(wait_time)
                        continue

                    # Final attempt failed — fall back to single mode
                    log_warn(f"Title filter batch failed, falling back to single mode: {e}")
                    for idx, contact in zip(valid_indices, valid_contacts):
                        results[idx] = self.filter_contact(contact, max_retries=max_retries)
                    return results

        return results

    def filter_contacts(self, input_csv: str, output_csv: str, output_excluded_csv: str = None):
        """
        Filter contacts from Step 9 to keep only administrative roles.
        Uses batched LLM calls for ~8x faster processing.

        Args:
            input_csv: CSV from Step 9 with all contacts
            output_csv: Output CSV with filtered contacts (administrative only)
            output_excluded_csv: Optional CSV with excluded contacts (for review)
        """
        # Read contacts from Step 9
        df = pd.read_csv(input_csv)

        # Build contact list
        all_contacts = []
        for idx, row in df.iterrows():
            all_contacts.append({
                'first_name': row.get('first_name', ''),
                'last_name': row.get('last_name', ''),
                'title': row.get('title', ''),
                'email': row.get('email', ''),
                'phone': row.get('phone', ''),
                'church_name': row.get('church_name', ''),
                'source_url': row.get('source_url', '')
            })

        kept_contacts = []
        excluded_contacts = []

        # Process in batches
        for i in range(0, len(all_contacts), self.batch_size):
            batch = all_contacts[i:i + self.batch_size]
            batch_results = self.filter_contacts_batch(batch, max_retries=5)

            for contact, should_keep in zip(batch, batch_results):
                if should_keep:
                    kept_contacts.append(contact)
                else:
                    excluded_contacts.append(contact)

            # Small delay between batches
            if i + self.batch_size < len(all_contacts):
                time.sleep(0.1)

        # Save results
        if kept_contacts:
            df_kept = pd.DataFrame(kept_contacts)
            df_kept.to_csv(output_csv, index=False)
        else:
            # Create empty CSV with headers
            pd.DataFrame(columns=['first_name', 'last_name', 'title', 'email', 'phone', 'church_name', 'source_url']).to_csv(output_csv, index=False)

        if output_excluded_csv and excluded_contacts:
            df_excluded = pd.DataFrame(excluded_contacts)
            df_excluded.to_csv(output_excluded_csv, index=False)

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='Filter contacts by title using LLM')
    parser.add_argument('--input', required=True, help='Input CSV from Step 5')
    parser.add_argument('--output', default='step10_contacts_filtered.csv', help='Output CSV filename for filtered contacts')
    parser.add_argument('--output-excluded', default=None, help='Output CSV filename for excluded contacts (optional)')
    parser.add_argument('--model', default='claude-haiku-5-5', help='Model to use (default: claude-haiku-5-5)')
    parser.add_argument('--batch-size', type=int, default=10, help='Contacts per LLM call (default: 10)')
    args = parser.parse_args()

    # API key must come from ANTHROPIC_API_KEY environment variable
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    filterer = TitleFilter(api_key=api_key, model=args.model, batch_size=args.batch_size)
    filterer.filter_contacts(args.input, args.output, args.output_excluded)
