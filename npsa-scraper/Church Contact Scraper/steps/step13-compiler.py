"""
STEP 13: FINAL COMPILER
=======================
Compile final CSV from contacts with emails and enriched contacts from Hunter.io.
Remove duplicates, validate emails, calculate confidence scores.

Input: 
- List of Contact objects with emails (from Step 11)
- List of Contact objects enriched by Hunter.io (from Step 12)
Output: Final cleaned CSV with all contacts
"""

import pandas as pd
import re
from typing import List, Dict, Set, Optional
from datetime import datetime
from pathlib import Path
import shutil
from urllib.parse import urlparse
from assets.shared.models import Contact
from assets.shared.csv_safety import escape_dataframe
from church_run_log import log_warn, log_err

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


def _extract_domain_from_url(url: str) -> Optional[str]:
    """Extract domain from source_url. e.g. https://www.example.com/page -> example.com"""
    if not url:
        return None
    try:
        parsed = urlparse(str(url))
        domain = parsed.netloc or parsed.path.split('/')[0]
        if domain.startswith('www.'):
            domain = domain[4:]
        if '.' in domain and len(domain) > 3:
            return domain.lower()
        return None
    except Exception:
        return None


class FinalCompiler:
    def __init__(self):
        # Email validation pattern
        self.email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        
        # Phone formatting pattern
        self.phone_pattern = r'(\d{3})[-.]?(\d{3})[-.]?(\d{4})'
        
        # Generic/invalid emails to filter
        self.invalid_emails = [
            'info@', 'contact@', 'admin@', 'office@', 'webmaster@',
            'noreply@', 'no-reply@', 'hello@', 'support@'
        ]
        
        # Generic text patterns that should NOT be names (per meeting notes)
        self.generic_name_patterns = [
            'about', 'admissions', 'contact us', 'home', 'welcome',
            'staff directory', 'faculty', 'administration', 'our team',
            'meet our', 'who we are', 'church information', 'general information'
        ]
        
        # Common placeholder/fake names to filter out
        self.placeholder_names = [
            'john doe', 'jane doe', 'john smith', 'jane smith',
            'bob jones', 'test user', 'example name', 'sample user',
            'john test', 'jane test', 'placeholder', 'demo user',
            'john example', 'jane example', 'test name', 'sample name'
        ]
        
        # NO FILTERING - LLM handles all filtering
        # Removed exclude_keywords - not used anymore
    
    def clean_email(self, email: str) -> str:
        """
        Clean email address by removing special characters and validating format.
        
        Args:
            email: Raw email string (may contain special characters or invalid text)
        
        Returns:
            Cleaned email string, or empty string if invalid
        """
        if not email or pd.isna(email):
            return ''
        
        email = str(email).strip()
        
        # Handle UTF-8 encoding artifacts like "â€‹" which appears when zero-width space is mis-encoded
        # Try to decode and re-encode to fix encoding issues
        try:
            # If the string contains "â€‹" (common mis-encoding of zero-width space)
            if 'â€‹' in email:
                # Try to fix by removing the problematic sequence
                email = email.replace('â€‹', '')
            # Also try removing if it's the actual zero-width space character
            email = email.lstrip('\u200B\u200C\u200D\uFEFF')  # Zero-width space, zero-width non-joiner, etc.
        except:
            pass
        
        # Remove UTF-8 BOM and other encoding artifacts
        if email.startswith('\ufeff'):
            email = email[1:]
        
        # Remove any other common encoding artifacts at the start
        # Remove leading non-printable characters
        while email and not email[0].isprintable() and email[0] != '@':
            email = email[1:]
        
        # Remove any leading non-ASCII characters that aren't valid email characters
        # Keep only printable ASCII characters and valid email characters
        cleaned = ''
        found_at = False
        for char in email:
            # Always keep @ symbol
            if char == '@':
                found_at = True
                cleaned += char
            # Allow ASCII printable characters and common email characters
            elif ord(char) < 128 and (char.isprintable() or char in '._-+'):
                cleaned += char
            # Skip other non-ASCII characters (but only before @)
            # After @, we might have internationalized domain names, but for now we'll be strict
            elif found_at and ord(char) < 128:
                # After @, allow some non-ASCII if it's part of a valid domain
                # But for safety, we'll be conservative
                pass
        
        email = cleaned.strip()
        
        # Basic email format validation - must contain @ and have valid structure
        # This filters out things like "Bobcat Heavy Civil" or "ISAIAH'S PLACE | ASL & EQUINE ASSISTED LEARNING"
        if not email or '@' not in email:
            return ''
        
        # Split by @ to check domain
        parts = email.split('@')
        if len(parts) != 2:
            return ''
        
        local, domain = parts[0], parts[1]
        
        # Local part must not be empty and should be reasonable
        if not local or len(local) < 1:
            return ''
        
        # Domain must contain at least one dot and have valid TLD
        if '.' not in domain or len(domain.split('.')[-1]) < 2:
            return ''
        
        # Additional check: if it looks like random text (too many spaces, special chars, etc.)
        # This catches cases where non-email text got into the field
        if ' ' in email or len(email.split()) > 1:
            return ''  # Emails shouldn't have spaces
        
        # Final regex validation for proper email format
        if not re.match(self.email_pattern, email):
            return ''
        
        return email.lower()
    
    def is_valid_email(self, email: str) -> bool:
        """Validate email format and filter generic addresses"""
        if not email or pd.isna(email):
            return False
        
        # First clean the email to remove special characters
        cleaned_email = self.clean_email(email)
        
        # If cleaning resulted in empty string, it's invalid
        if not cleaned_email:
            return False
        
        # Check for invalid generic emails
        if any(invalid in cleaned_email for invalid in self.invalid_emails):
            return False
        
        return True
    
    # Removed is_admin_role() - NO FILTERING in Python, LLM handles all filtering
    
    def format_phone(self, phone: str) -> str:
        """Format phone number to standard format"""
        if not phone or pd.isna(phone):
            return ''
        
        phone = str(phone).strip()
        
        # Extract digits
        digits = re.sub(r'\D', '', phone)
        
        # Format if 10 digits
        if len(digits) == 10:
            return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
        elif len(digits) == 11 and digits[0] == '1':
            return f"({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
        else:
            return phone  # Return as-is if can't format
    
    def is_valid_name(self, name: str) -> bool:
        """
        Check if name is valid (not generic page text or placeholder names)
        
        Returns:
            True if name appears to be a real person name
        """
        if not name or pd.isna(name):
            return False
        
        name_lower = str(name).strip().lower()
        
        # Check for placeholder/fake names (exact match or contains)
        for placeholder in self.placeholder_names:
            if placeholder == name_lower or placeholder in name_lower:
                return False
        
        # Check for generic text patterns
        for pattern in self.generic_name_patterns:
            if pattern in name_lower:
                return False
        
        # Names should typically be 2-4 words
        parts = name.split()
        if len(parts) < 1 or len(parts) > 5:
            return False
        
        # Check if it looks like a person name (has letters, not just numbers/symbols)
        if not re.search(r'[a-zA-Z]', name):
            return False
        
        return True
    
    def clean_name(self, name: str) -> tuple:
        """
        Split name into first and last name
            
        Returns:
            (first_name, last_name) tuple
        """
        if not name or pd.isna(name):
            return ('', '')
        
        name = str(name).strip()
        
        # Remove titles
        name = re.sub(r'^(mr\.|mrs\.|ms\.|dr\.|miss|father|fr\.|rev\.)\s+', '', name, flags=re.IGNORECASE)
        
        parts = name.split()
        
        if len(parts) == 0:
            return ('', '')
        elif len(parts) == 1:
            return (parts[0], '')
        elif len(parts) == 2:
            return (parts[0], parts[1])
        else:
            # If more than 2 parts, assume first is first name, rest is last name
            return (parts[0], ' '.join(parts[1:]))
    
    def _fuzzy_name_match(self, name1: str, name2: str, threshold: float = 0.85) -> bool:
        """
        Check if two names are similar using fuzzy matching.
        Uses simple character-based similarity for speed.
        
        Args:
            name1: First name to compare
            name2: Second name to compare
            threshold: Similarity threshold (0-1), default 0.85
            
        Returns:
            True if names are similar enough to be considered duplicates
        """
        if not name1 or not name2:
            return False
        
        name1 = name1.lower().strip()
        name2 = name2.lower().strip()
        
        # Exact match
        if name1 == name2:
            return True
        
        # Check for common variations (e.g., "John" vs "Johnny", "Bob" vs "Robert")
        # Simple substring check for now (can be enhanced with difflib if needed)
        if name1 in name2 or name2 in name1:
            # Only consider it a match if one is a clear abbreviation/nickname
            if len(name1) >= 3 and len(name2) >= 3:
                return True
        
        # Use difflib for more sophisticated fuzzy matching
        try:
            from difflib import SequenceMatcher
            similarity = SequenceMatcher(None, name1, name2).ratio()
            return similarity >= threshold
        except:
            # Fallback: simple character overlap
            set1 = set(name1.replace(' ', ''))
            set2 = set(name2.replace(' ', ''))
            if len(set1) > 0 and len(set2) > 0:
                overlap = len(set1 & set2) / max(len(set1), len(set2))
                return overlap >= threshold
            return False
    
    def deduplicate_contacts(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Remove duplicate contacts without using confidence scores.
        Deduplicate by:
        1) Email (exact match) when present
        2) Name + domain (from source_url) when no email, else name + church
        """
        if len(df) == 0:
            return df
        
        df = df.copy()
        if 'source_url' not in df.columns and 'Source URL' in df.columns:
            df['source_url'] = df['Source URL'].fillna('').astype(str)
        if 'source_url' not in df.columns:
            df['source_url'] = ''
        df['first_name_n'] = df['first_name'].fillna('').astype(str).str.lower().str.strip()
        df['last_name_n'] = df['last_name'].fillna('').astype(str).str.lower().str.strip()
        df['name_n'] = (df['first_name_n'] + ' ' + df['last_name_n']).str.strip()
        name_col = 'church_name'
        df['church_name_n'] = df[name_col].fillna('').astype(str).str.lower().str.strip()
        df['source_url_n'] = df['source_url'].fillna('').astype(str)
        df['domain'] = df['source_url_n'].apply(_extract_domain_from_url)

        # Deduplicate by email when present (normalize email first: lowercase, strip)
        if 'email' in df.columns:
            df['email_normalized'] = df['email'].fillna('').astype(str).str.strip().str.lower()
            has_email = df['email_normalized'] != ''
            df_email = df[has_email].copy().sort_values(by=['email_normalized']).drop_duplicates(subset=['email_normalized'], keep='first')
            df_email = df_email.drop(columns=['email_normalized'], errors='ignore')
            df_no_email = df[~has_email].copy().drop(columns=['email_normalized'], errors='ignore')
        else:
            df_email = pd.DataFrame()
            df_no_email = df.copy()

        # For no-email: dedupe by name + domain (or name + church_name if no domain)
        if len(df_no_email) > 0:
            def _dedupe_key(r):
                d = r['domain']
                s = r['church_name_n']
                use_d = not (d is None or (isinstance(d, float) and pd.isna(d))) and str(d).strip()
                return r['name_n'] + '|' + (d if use_d else s)
            dedupe_keys = df_no_email.apply(_dedupe_key, axis=1)
            # Ensure we have a Series, not DataFrame
            if isinstance(dedupe_keys, pd.DataFrame):
                dedupe_keys = dedupe_keys.iloc[:, 0]
            df_no_email = df_no_email.copy()
            df_no_email.loc[:, 'dedupe_key'] = dedupe_keys.values if hasattr(dedupe_keys, 'values') else dedupe_keys
            df_no_email = df_no_email.sort_values(by=['dedupe_key']).drop_duplicates(subset=['dedupe_key'], keep='first')

        drop_cols = ['first_name_n', 'last_name_n', 'name_n', 'church_name_n', 'source_url_n', 'domain', 'dedupe_key']
        df_no_email = df_no_email.drop(columns=[c for c in drop_cols if c in df_no_email.columns], errors='ignore')

        if len(df_email) > 0:
            df_email = df_email.drop(columns=[c for c in drop_cols if c in df_email.columns], errors='ignore')
            out = pd.concat([df_email, df_no_email], ignore_index=True)
        else:
            out = df_no_email

        return out.reset_index(drop=True)

    def deduplicate_contacts_only(
        self,
        contacts_with_emails: List[Contact],
        contacts_without_emails: List[Contact]
    ) -> List[Contact]:
        """
        Deduplicate combined contacts (email, then name+domain / name+church) and return
        the deduplicated Contact list. Used before Hunter enrichment to save credits.
        """
        combined = list(contacts_with_emails) + list(contacts_without_emails)
        if not combined:
            return []
        contact_dicts = [c.to_dict() for c in combined]
        df = pd.DataFrame(contact_dicts)
        df = self.deduplicate_contacts(df)
        out = []
        for _, row in df.iterrows():
            def s(v):
                x = row.get(v, '') or row.get(v.replace('_', ' ').title(), '')
                return str(x).strip() if x is not None and not (isinstance(x, float) and pd.isna(x)) else ''
            out.append(Contact(
                first_name=s('first_name'),
                last_name=s('last_name'),
                title=s('title'),
                email=row.get('email') if row.get('email') and str(row.get('email')).strip() else None,
                phone=s('phone'),
                church_name=s('church_name'),
                source_url=s('source_url')
            ))
        return out

    def compile_contacts_to_csv(
        self,
        contacts_with_emails: List[Contact],
        contacts_enriched: List[Contact],
        output_csv: str = None,
        state: str = None,
        already_deduplicated: bool = False
    ):
        """
        Compile Contact objects into final CSV.
        Combines contacts with emails and enriched contacts, deduplicates (unless already_deduplicated), and writes to CSV.

        Args:
            contacts_with_emails: List of Contact objects that already have emails (from Step 11)
            contacts_enriched: List of Contact objects enriched by Hunter.io (from Step 12)
            output_csv: Optional output CSV filename
            state: State name for filename generation
            already_deduplicated: If True, skip deduplication (e.g. after deduplicate_contacts_only + enrich)
        """
        # Generate output filename with state name if not provided
        if not output_csv:
            state_name = (state or 'Texas').title()
            output_csv = f"{state_name} leads.csv"
        elif state and output_csv.endswith(' - with emails.csv'):
            state_name = state.title()
            output_csv = f"{state_name} leads.csv"
        
        # Combine all contacts
        all_contacts = contacts_with_emails + contacts_enriched
        log_warn(f"Compiler: {len(contacts_with_emails)} with emails, {len(contacts_enriched)} enriched, {len(all_contacts)} total")

        if not all_contacts:
            log_warn("Compiler: no contacts to compile")
            # Create empty CSV with headers
            empty_df = pd.DataFrame(columns=['first_name', 'last_name', 'title', 'email', 'phone', 'church_name', 'source_url'])
            empty_df.to_csv(output_csv, index=False)
            return output_csv
        
        # Convert Contact objects to DataFrame
        contact_dicts = [contact.to_dict() for contact in all_contacts]
        df = pd.DataFrame(contact_dicts)
        
        # Clean and validate
        
        # Clean emails
        if 'email' in df.columns:
            df['email'] = df['email'].apply(lambda x: self.clean_email(x) if (x and not pd.isna(x) and str(x).strip()) else x)
        
        # Validate emails (keep empty emails)
        if 'email' in df.columns:
            df['email_valid'] = df['email'].apply(lambda x: True if (pd.isna(x) or str(x).strip() == '') else self.is_valid_email(x))
            df = df[df['email_valid'] == True]
            pass  # email validation applied
        
        # Validate names
        df['name'] = (df['first_name'].fillna('') + ' ' + df['last_name'].fillna('')).str.strip()
        df['name_valid'] = df['name'].apply(self.is_valid_name)
        df = df[df['name_valid'] == True]
        pass  # name validation applied
        
        # Format phones
        if 'phone' in df.columns:
            df['phone'] = df['phone'].apply(self.format_phone)

        if not already_deduplicated:
            before_dedup = len(df)
            df = self.deduplicate_contacts(df)
            if len(df) < before_dedup:
                log_warn(f"Compiler: dedup {before_dedup} -> {len(df)}")
        else:
            # Safety check: do a lightweight deduplication pass even if already deduplicated
            # This catches any edge cases (e.g., email normalization issues)
            before = len(df)
            df = self.deduplicate_contacts(df)
            if len(df) < before:
                log_warn(f"Compiler: safety dedup removed {before - len(df)}: {len(df)}")

        # Create final structure
        final_df = pd.DataFrame({
            'first_name': df['first_name'],
            'last_name': df['last_name'],
            'title': df.get('title', ''),
            'email': df.get('email', ''),
            'phone': df.get('phone', ''),
            'church_name': df.get('church_name', ''),
            'source_url': df.get('source_url', '')
        })
        
        # Save to CSV (scraped text is escaped so spreadsheets don't run it as a formula)
        escape_dataframe(final_df).to_csv(output_csv, index=False)
        
        # Count contacts with and without emails
        df_with_emails = final_df[final_df['email'].notna() & (final_df['email'] != '') & (final_df['email'].str.strip() != '')]
        df_without_emails = final_df[final_df['email'].isna() | (final_df['email'] == '') | (final_df['email'].str.strip() == '')]
        
        log_warn(f"Compiler: saved {len(final_df)} contacts ({len(df_with_emails)} with emails, {len(df_without_emails)} without)")
        
        return output_csv
    
    def compile_final_csv(self, input_csv: str, output_csv: str = None, state: str = None):
        """
        Create final cleaned and validated CSV
        Outputs all contacts to a single CSV file
        
        Args:
            input_csv: CSV from Step 10 with filtered contacts
            output_csv: Optional output CSV filename
                       If not provided, will generate based on state name
            state: State name (e.g., 'Texas', 'California') for filename generation
        """
        log_warn("Compiler: compiling final CSV")
        
        # Generate output filenames with state name if not provided
        if not output_csv:
            state_name = (state or 'Texas').title()
            output_csv = f"{state_name} leads.csv"
        else:
            # If output_csv provided but has old format, update it
            if state and output_csv.endswith(' - with emails.csv'):
                state_name = state.title()
                output_csv = f"{state_name} leads.csv"
            elif state and not output_csv.endswith('.csv'):
                state_name = state.title()
                output_csv = f"{state_name} leads.csv"
        
        # Read parsed contacts
        df = pd.read_csv(input_csv)
        
        log_warn(f"Compiler: {len(df)} initial contacts")
        
        # Handle different input formats - check if we have 'name' column or 'first_name'/'last_name' columns
        if 'name' in df.columns and ('first_name' not in df.columns or 'last_name' not in df.columns):
            # Old format: split 'name' into first_name and last_name
            df[['first_name', 'last_name']] = df['name'].apply(
                lambda x: pd.Series(self.clean_name(x))
            )
        elif 'first_name' not in df.columns or 'last_name' not in df.columns:
            # Missing name columns - try to create them
            if 'name' in df.columns:
                df[['first_name', 'last_name']] = df['name'].apply(
                    lambda x: pd.Series(self.clean_name(x))
                )
            else:
                # No name column at all - create empty ones
                df['first_name'] = ''
                df['last_name'] = ''
        
        # Ensure church_name column exists (might be 'Church Name' or 'church_name')
        if 'church_name' not in df.columns:
            if 'Church Name' in df.columns:
                df['church_name'] = df['Church Name']
            else:
                df['church_name'] = ''
        
        # Clean and validate
        # Clean and validate
        
        # First, clean all emails to remove special characters and invalid text
        df['email'] = df['email'].apply(lambda x: self.clean_email(x) if (x and not pd.isna(x) and str(x).strip()) else x)
        
        # Validate emails (only format validation, don't filter empty emails)
        # Empty emails are valid - we want to keep contacts without emails
        # Only validate format if email is present
        df['email_valid'] = df['email'].apply(lambda x: True if (pd.isna(x) or str(x).strip() == '') else self.is_valid_email(x))
        df = df[df['email_valid'] == True]
        pass  # email validation applied
        
        # Validate names (filter out generic text/placeholders only)
        # Check if we have a combined 'name' column for validation
        if 'name' not in df.columns:
            # Create combined name for validation
            df['name'] = (df['first_name'].fillna('') + ' ' + df['last_name'].fillna('')).str.strip()
        df['name_valid'] = df['name'].apply(self.is_valid_name)
        df = df[df['name_valid'] == True]
        pass  # name validation applied
        
        # NO ROLE FILTERING - LLM handles all title filtering
        pass  # LLM handles filtering
        
        # Check if dataframe is empty
        if len(df) == 0:
            log_warn("Compiler: no contacts remaining after validation")
            # Create empty CSV with proper columns
            empty_df = pd.DataFrame(columns=['Church Name', 'First Name', 'Last Name', 'Title', 'Email', 'Phone', 'Confidence Score', 'Source URL', 'Date Collected', 'Verified', 'Notes'])
            empty_df.to_csv(output_csv, index=False)
            self._copy_to_downloads(output_csv)
            return
        
        # Format phones
        df['phone'] = df['phone'].apply(self.format_phone)
        
        # Deduplicate
        before_dedup = len(df)
        df = self.deduplicate_contacts(df)
        if len(df) < before_dedup:
            log_warn(f"Compiler: dedup {before_dedup} -> {len(df)}")
        
        # Create final structure
        final_df = pd.DataFrame({
            'Church Name': df['church_name'],
            'First Name': df['first_name'],
            'Last Name': df['last_name'],
            'Title': df['title'],
            'Email': df['email'],
            'Phone': df['phone'],
            'Source URL': df['source_url']
        })
        
        # Add metadata columns
        final_df['Date Collected'] = datetime.now().strftime('%Y-%m-%d')
        final_df['Verified'] = ''  # For manual verification tracking
        final_df['Notes'] = ''
        
        # Count contacts with and without emails for summary
        df_with_emails = final_df[final_df['Email'].notna() & (final_df['Email'] != '') & (final_df['Email'].str.strip() != '')].copy()
        df_without_emails = final_df[final_df['Email'].isna() | (final_df['Email'] == '') | (final_df['Email'].str.strip() == '')].copy()
        
        # Save all contacts to single file
        if not final_df.empty:
            escape_dataframe(final_df).to_csv(output_csv, index=False)
            self._copy_to_downloads(output_csv)
            log_warn(f"Compiler: saved {len(final_df)} contacts ({len(df_with_emails)} with emails, {len(df_without_emails)} without)")
        else:
            # Create empty CSV with headers if no contacts
            pd.DataFrame(columns=final_df.columns).to_csv(output_csv, index=False)
            self._copy_to_downloads(output_csv)
            log_warn("Compiler: no contacts found")
        
        # Print summary (using combined data)
        self._print_summary(final_df, output_csv, df_with_emails, df_without_emails)
        
        # Create quality report
        self._create_quality_report(final_df, output_csv.replace('.csv', '_quality_report.txt'))
    
    def _copy_to_downloads(self, file_path: str):
        """Copy the final CSV to the user's Downloads folder"""
        try:
            downloads_dir = Path.home() / "Downloads"
            if not downloads_dir.exists():
                return

            destination = downloads_dir / Path(file_path).name
            shutil.copy2(file_path, destination)
        except Exception:
            pass
    
    def _print_summary(self, df: pd.DataFrame, output_file: str, df_with_emails: pd.DataFrame = None, df_without_emails: pd.DataFrame = None):
        """Print final summary statistics (compact)"""
        n_with = len(df_with_emails) if df_with_emails is not None else df[df['Email'].ne('')].shape[0]
        n_without = len(df_without_emails) if df_without_emails is not None else df[df['Email'] == ''].shape[0]
        n_churches = df['Church Name'].nunique()
        email_pct = df['Email'].ne('').sum() / len(df) * 100 if len(df) else 0
        phone_pct = df['Phone'].ne('').sum() / len(df) * 100 if len(df) else 0
        log_warn(f"Compiler: {len(df)} contacts, {n_churches} churches, {n_with} with email ({email_pct:.0f}%), {phone_pct:.0f}% with phone -> {output_file}")
    
    def _create_quality_report(self, df: pd.DataFrame, report_file: str):
        """Create detailed quality report"""
        with open(report_file, 'w') as f:
            f.write("="*70 + "\n")
            f.write("CONTACT DATA QUALITY REPORT\n")
            f.write("="*70 + "\n")
            f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            
            f.write(f"Total Contacts: {len(df)}\n")
            f.write(f"Unique Churches: {df['Church Name'].nunique()}\n\n")
            
            f.write("DATA COMPLETENESS\n")
            f.write("-" * 70 + "\n")
            for col in ['First Name', 'Last Name', 'Phone']:
                complete = df[col].ne('').sum()
                pct = complete / len(df) * 100
                f.write(f"{col:15} {complete:5} / {len(df):5} ({pct:5.1f}%)\n")
            
            f.write("\n" + "CONFIDENCE DISTRIBUTION\n")
            f.write("-" * 70 + "\n")
            bins = [(90, 100), (80, 89), (70, 79), (60, 69), (0, 59)]
            for low, high in bins:
                count = len(df[(df['Confidence Score'] >= low) & (df['Confidence Score'] <= high)])
                pct = count / len(df) * 100
                f.write(f"{low:2}-{high:3}: {count:5} ({pct:5.1f}%)\n")
            
            f.write("\n" + "CHURCHES BY CONTACT COUNT\n")
            f.write("-" * 70 + "\n")
            church_counts = df.groupby('Church Name').size().sort_values(ascending=False)
            for church, count in church_counts.items():
                f.write(f"{church[:50]:50} {count:3}\n")
            
            f.write("\n" + "TITLE DISTRIBUTION\n")
            f.write("-" * 70 + "\n")
            title_counts = df['Title'].value_counts()
            for title, count in title_counts.items():
                f.write(f"{title[:50]:50} {count:3}\n")
        
        log_warn(f"Compiler: quality report -> {report_file}")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Compile final validated CSV')
    parser.add_argument('--input', required=True, help='Input CSV from Step 10')
    parser.add_argument('--output', default=None, help='Output CSV filename (will generate based on state if not provided)')
    parser.add_argument('--state', default='Texas', help='State name for filename generation (e.g., Texas, California)')
    
    args = parser.parse_args()
    
    compiler = FinalCompiler()
    compiler.compile_final_csv(args.input, args.output, args.state)
