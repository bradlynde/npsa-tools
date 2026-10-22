"""
STREAMING PIPELINE ORCHESTRATOR
================================
Process one lead through all steps, then write to final CSV only.
No intermediate CSV files - all in memory streaming.

Usage:
    python pipeline.py --api-key KEY --anthropic-key ANTHROPIC_KEY
"""

import os
import sys
import csv
import argparse
import time
from typing import List, Iterator, Optional, Dict
from datetime import datetime
from pathlib import Path
import traceback
import importlib.util


def _maybe_traceback():
    if os.environ.get("SCHOOL_LOG_TRACEBACK", "").strip() in ("1", "true", "yes"):
        traceback.print_exc()

# Import shared models
from assets.shared.models import School, Page, PageContent, Contact
from school_run_log import log_err, log_warn

# Import streaming steps
# Handle hyphens in filenames using importlib.util
_script_dir = Path(__file__).parent
_steps_dir = _script_dir / "steps"
step1_spec = importlib.util.spec_from_file_location("step1_search", _steps_dir / "step1-search.py")
step1_module = importlib.util.module_from_spec(step1_spec)
step1_spec.loader.exec_module(step1_module)
SchoolSearcher = step1_module.SchoolSearcher

step2_spec = importlib.util.spec_from_file_location("step2_school_filter", _steps_dir / "step2-school_filter.py")
step2_module = importlib.util.module_from_spec(step2_spec)
step2_spec.loader.exec_module(step2_module)
filter_school = step2_module.filter_school
LLMSchoolFilter = step2_module.LLMSchoolFilter


def load_counties_from_state(state: str) -> List[str]:
    """
    Load counties for a given state from assets/data/state_counties/{state}.txt
    
    Args:
        state: State name (e.g., 'texas', 'Texas', 'TEXAS')
        
    Returns:
        List of county names
        
    Raises:
        FileNotFoundError: If state file doesn't exist
    """
    # Normalize state name: lowercase, replace spaces with underscores
    state_normalized = state.lower().replace(' ', '_')
    
    # Get the directory where this script is located
    script_dir = Path(__file__).parent
    state_file = script_dir / 'assets' / 'data' / 'state_counties' / f'{state_normalized}.txt'
    
    if not state_file.exists():
        raise FileNotFoundError(
            f"State file not found: {state_file}\n"
            f"Please create assets/data/state_counties/{state_normalized}.txt with one county per line"
        )
    
    counties = []
    with open(state_file, 'r', encoding='utf-8') as f:
        for line in f:
            county = line.strip()
            # Skip empty lines and comments
            if county and not county.startswith('#'):
                counties.append(county)
    
    if not counties:
        raise ValueError(f"No counties found in {state_file}")
    
    return counties

# Import step classes (will need to refactor these to support streaming)
# For now, we'll import the existing classes and wrap them
# Handle hyphens in filenames using importlib.util
def load_module_with_hyphen(filename, module_name):
    """Load a Python module from a file with hyphens in the filename"""
    spec = importlib.util.spec_from_file_location(module_name, _steps_dir / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

step3 = load_module_with_hyphen('step3-discovery.py', 'step3_discovery')   # Step 3 – page discovery
step4 = load_module_with_hyphen('step4-crawler.py', 'step4_crawler')   # Step 4 – content collection
step5 = load_module_with_hyphen('step5-html_reduction.py', 'step5_html_reduction')   # Step 5 – HTML reduction
step6 = load_module_with_hyphen('step6-html_chunking.py', 'step6_html_chunking')   # Step 6 – HTML chunking
step7 = load_module_with_hyphen('step7-llm_parser.py', 'step7_llm_parser')   # Step 7 – LLM parsing
step8 = load_module_with_hyphen('step8-lead_cleaner.py', 'step8_lead_cleaner')   # Step 8 – CSV/email cleaning
step9 = load_module_with_hyphen('step9-lead_dedupe.py', 'step9_lead_dedupe')   # Step 9 – deduplication
step10 = load_module_with_hyphen('step10-lead_filter.py', 'step10_lead_filter')  # Step 10 – title filtering
step11_contact_splitter = load_module_with_hyphen('step11-contact_splitter.py', 'step11_contact_splitter')  # Step 11 – split contacts with/without emails
step12_hunter_io = load_module_with_hyphen('step12-enrichment.py', 'step12_enrichment')  # Step 12 – email enrichment (Hunter.io)
step13_final_compiler = load_module_with_hyphen('step13-compiler.py', 'step13_compiler')  # Step 13 – final CSV compilation


class StreamingPipeline:
    """Process leads through entire pipeline one at a time"""
    
    def __init__(
        self,
        google_api_key: str,
        anthropic_api_key: str,
        global_max_api_calls: int = 25,
        max_pages_per_school: int = 3,
        state: str = 'Texas',
        max_schools: int = None,
        chrome_tmp_dir: Optional[str] = None
    ):
        self.google_api_key = google_api_key
        self.anthropic_api_key = anthropic_api_key
        self.global_max_api_calls = global_max_api_calls
        self.max_pages_per_school = max_pages_per_school
        self._state = state
        self.max_schools = max_schools
        
        # Initialize step processors
        self.school_searcher = SchoolSearcher(google_api_key, global_max_api_calls, max_schools=max_schools, target_state=state)
        
        # Initialize LLM school filter if Anthropic key provided
        if anthropic_api_key:
            try:
                self.llm_school_filter = LLMSchoolFilter(
                    api_key=anthropic_api_key,
                    target_state=state,  # Pass state to LLM filter
                    model="claude-haiku-5-5",
                    batch_size=20
                )
            except Exception as e:
                log_warn(f"Could not initialize LLM school filter: {e}")
                self.llm_school_filter = None
        else:
            self.llm_school_filter = None
        
        self.page_discoverer = step3.PageDiscoverer(timeout=10, max_retries=3)
        # ContentCollector will create Selenium driver on init
        # Driver will be recycled after each county to prevent resource accumulation
        # chrome_tmp_dir: use volume path to avoid ephemeral storage exhaustion ( Railway file limit)
        self.content_collector = step4.ContentCollector(timeout=10, max_retries=3, use_selenium=True, chrome_user_data_dir=chrome_tmp_dir)
        self.html_reducer = step5.HTMLReducer()
        self.html_chunker = step6.HTMLChunker()
        self.llm_parser = step7.LLMParser(anthropic_api_key, model="claude-haiku-5-5")
        self.csv_parser = step8.CSVParser()
        self.deduplicator = step9.ContactDeduplicator(email_cleaner=self.csv_parser.clean_email)
        self.title_filter = step10.TitleFilter(anthropic_api_key, model="claude-haiku-5-5", batch_size=10)
        self.contact_splitter = step11_contact_splitter.ContactSplitter()
        self.final_compiler = step13_final_compiler.FinalCompiler()
        self.enable_hunter_io = os.getenv('HUNTER_IO_API_KEY') is not None
        
        # Results accumulator
        self.all_contacts = []
        # Track unique contacts for progress display (key: normalized contact identifier)
        self.unique_contacts_set = set()
        self.stats = {
            'schools_discovered': 0,
            'schools_filtered_out': 0,
            'schools_processed': 0,
            'pages_discovered': 0,
            'pages_collected': 0,
            'contacts_extracted': 0,
            'contacts_with_emails': 0,
            'places_api_calls': 0,
            'openai_calls': 0,
            'openai_prompt_tokens': 0,
            'openai_completion_tokens': 0,
        }
    
    def _get_contact_key(self, contact: Contact) -> str:
        """
        Generate a unique key for a contact for deduplication tracking.
        Uses email if available, otherwise name + school.
        
        Args:
            contact: Contact object
            
        Returns:
            Normalized string key for uniqueness tracking
        """
        # If contact has email, use that as the key (normalized)
        if contact.email:
            email_key = contact.email.lower().strip()
            if email_key:
                return f"email:{email_key}"
        
        # Otherwise, use name + school (normalized)
        first_name = (contact.first_name or '').lower().strip()
        last_name = (contact.last_name or '').lower().strip()
        school_name = (contact.school_name or '').lower().strip()
        
        # Only create key if we have at least first or last name
        if first_name or last_name:
            return f"name:{first_name}|{last_name}|{school_name}"
        
        # Fallback: use all available fields
        return f"fallback:{first_name}|{last_name}|{school_name}|{contact.title or ''}"
    
    def process_single_lead(self, school: School) -> List[Contact]:
        """
        Process one school through all steps.
        Returns list of Contact objects extracted from this school.
        """
        # Step 2: Filter school
        filter_result = filter_school(school, target_state=self._state, llm_filter=self.llm_school_filter)
        if isinstance(filter_result, tuple):
            filtered_school, filter_reason = filter_result
        else:
            filtered_school, filter_reason = filter_result, None

        if not filtered_school:
            self.stats['schools_filtered_out'] += 1
            return []

        if not filtered_school.website:
            return []

        # Step 3: Discover pages
        try:
            pages = self._discover_pages_for_school(filtered_school)
            self.stats['pages_discovered'] += len(pages)

            if not pages:
                return []
        except Exception as e:
            log_err(f"Page discovery: {school.name}: {e}")
            _maybe_traceback()
            return []
        
        # Step 4: Collect content
        page_contents = []
        for page in pages[:self.max_pages_per_school]:  # Limit pages per school
            try:
                content = self._collect_content_for_page(page)
                if content:
                    page_contents.append(content)
                    self.stats['pages_collected'] += 1
            except Exception as e:
                continue
        
        if not page_contents:
            return []
        
        # Step 5: Parse content with LLM
        all_contacts = []
        for page_content in page_contents:
            try:
                contacts = self._parse_content_with_llm(page_content, filtered_school)
                all_contacts.extend(contacts)
            except Exception as e:
                continue
        
        self.stats['schools_processed'] += 1
        return all_contacts
    
    def _discover_pages_for_school(self, school: School) -> List[Page]:
        """
        Discover pages for a single school using step3's discover_pages method.
        """
        if not school.website:
            return []
        
        pages = []
        try:
            # Use step3's discover_pages method
            discovered_pages = self.page_discoverer.discover_pages(
                school_name=school.name,
                base_url=school.website,
                max_depth=3,
                max_pages_per_school=self.max_pages_per_school,
                top_pages_limit=self.max_pages_per_school
            )
            
            # Convert dicts to Page objects
            for page_dict in discovered_pages:
                pages.append(Page(
                    url=page_dict['url'],
                    school_name=school.name,
                    school_place_id=school.place_id,
                    school_website=school.website,
                    priority_score=page_dict.get('priority_score', 0),
                    page_title=page_dict.get('title'),
                    discovered_via=page_dict.get('url')  # Could enhance this
                ))
        except Exception as e:
            log_err(f"Page discovery inner: {e}")
            _maybe_traceback()
        
        return pages
    
    def _collect_content_for_page(self, page: Page) -> Optional[PageContent]:
        """
        Collect content for a single page using step4's collect_page_content method.
        """
        try:
            # Use step4's collect_page_content method (requires school_name and url)
            result = self.content_collector.collect_page_content(page.school_name, page.url)
            
            if not result:
                return None
            
            # Extract HTML content and metadata from result dict
            html_content = result.get('html_content', '')
            fetch_method = result.get('fetch_method', 'unknown')
            email_count = result.get('email_count', 0)
            
            return PageContent(
                url=page.url,
                school_name=page.school_name,
                html_content=html_content or '',
                email_count=email_count,
                has_emails=email_count > 0,
                collection_method=fetch_method
            )
        except Exception as e:
            log_err(f"Content collection: {e}")
            _maybe_traceback()
            return None
    
    def _parse_content_with_llm(self, page_content: PageContent, school: School) -> List[Contact]:
        """
        Parse content with LLM using step5's reduction and chunking logic.
        """
        if not page_content.html_content:
            return []
        
        try:
            # Step 5: Reduce HTML to contact-focused sections
            reduced_html = self.html_reducer.reduce_html(page_content.html_content)
            if not reduced_html:
                return []
            
            # Step 6: Chunk HTML if needed
            chunks = self.html_chunker.chunk_html(reduced_html, max_chunk_size=50000)  # Increased from 20k to 50k for cost optimization
            
            # Step 7-8: LLM parsing + CSV parsing
            page_contacts_dicts = []
            for chunk_idx, chunk in enumerate(chunks):
                csv_text = self.llm_parser.parse_with_llm(
                    chunk,
                    school.name,
                    page_content.url,
                    max_retries=1
                )
                
                if csv_text:
                    chunk_contacts = self.csv_parser.parse_csv_response(csv_text)
                    for contact in chunk_contacts:
                        contact['school_name'] = school.name
                        contact['source_url'] = page_content.url
                    page_contacts_dicts.extend(chunk_contacts)
                
                if chunk_idx < len(chunks) - 1:
                    time.sleep(1.0)
            
            if not page_contacts_dicts:
                return []
            
            # Step 9: Deduplicate contacts from this page
            deduped_contacts = self.deduplicator.deduplicate_contacts(page_contacts_dicts)
            
            # Step 10: Batch filter contacts by title (~8x faster)
            filter_payloads = [
                {
                    'first_name': cd.get('first_name', ''),
                    'last_name': cd.get('last_name', ''),
                    'title': cd.get('title', ''),
                    'email': cd.get('email', ''),
                    'phone': cd.get('phone', '')
                }
                for cd in deduped_contacts
            ]
            batch_results = self.title_filter.filter_contacts_batch(filter_payloads, max_retries=1)

            filtered_contacts = []
            for contact_dict, should_keep in zip(deduped_contacts, batch_results):
                if should_keep:
                    contact = Contact(
                        first_name=contact_dict.get('first_name', '').strip(),
                        last_name=contact_dict.get('last_name', '').strip(),
                        title=contact_dict.get('title', ''),
                        email=contact_dict.get('email') or None,
                        phone=contact_dict.get('phone') or None,
                        school_name=school.name,
                        source_url=page_content.url
                    )
                    filtered_contacts.append(contact)
            
            return filtered_contacts
        except Exception as e:
            log_err(f"LLM parsing: {e}")
            _maybe_traceback()
            return []
    
    def run(
        self,
        counties: List[str] = None,
        batch_size: int = 0,
        output_csv: str = "final_contacts.csv"
    ):
        """
        Run the streaming pipeline.
        Processes schools one at a time through all steps.
        """
        schools_discovered = 0

        if not counties:
            if not hasattr(self, '_state') or not self._state:
                raise ValueError("--state parameter is required for county-based search")
            counties = load_counties_from_state(self._state)

        max_search_terms_per_county = 6

        school_generator = self.school_searcher.discover_schools(
            counties=counties,
            state=self._state or 'Texas',
            batch_size=batch_size,
            max_search_terms=max_search_terms_per_county
        )

        for school in school_generator:
            schools_discovered += 1
            self.stats['schools_discovered'] = schools_discovered

            contacts = self.process_single_lead(school)

            for contact in contacts:
                contact_key = self._get_contact_key(contact)
                if contact_key not in self.unique_contacts_set:
                    self.unique_contacts_set.add(contact_key)

            self.all_contacts.extend(contacts)

        if self.llm_school_filter:
            self.llm_school_filter.flush()

        if not output_csv or output_csv == "final_contacts.csv":
            output_csv = "final_contacts.csv"

        if self.all_contacts:
            self._write_final_csv(self.all_contacts, output_csv)

        # Update stats
        self.stats['contacts_extracted'] = len(self.all_contacts)
        self.stats['unique_contacts'] = len(self.unique_contacts_set)

        contacts_with_emails = [c for c in self.all_contacts if c.has_email()]
        contacts_without_emails = [c for c in self.all_contacts if not c.has_email()]
        self.stats['contacts_with_emails'] = len(contacts_with_emails)
        self.stats['contacts_without_emails'] = len(contacts_without_emails)

        # Cost tracking
        self.stats["places_api_calls"] = self.school_searcher.stats.get("total_api_calls", 0)
        self.stats["openai_calls"] = getattr(self.llm_parser, "total_api_calls", 0) + getattr(self.title_filter, "total_api_calls", 0)
        self.stats["openai_prompt_tokens"] = getattr(self.llm_parser, "total_prompt_tokens", 0) + getattr(self.title_filter, "total_prompt_tokens", 0)
        self.stats["openai_completion_tokens"] = getattr(self.llm_parser, "total_completion_tokens", 0) + getattr(self.title_filter, "total_completion_tokens", 0)
    
    def cleanup(self):
        """
        Basic cleanup: quit Selenium driver if it exists.
        """
        try:
            if hasattr(self, 'content_collector') and self.content_collector:
                if self.content_collector.driver:
                    self.content_collector.driver.quit()
                    self.content_collector.driver = None
        except Exception:
            pass  # Ignore cleanup errors
    
    def __del__(self):
        """Destructor - safety net to ensure resources are cleaned up"""
        try:
            self.cleanup()
        except:
            # Ignore errors in destructor
            pass
    
    def _write_final_csv(self, contacts: List[Contact], filename: str):
        """Write contacts to final CSV file"""
        if not contacts:
            return

        fieldnames = ['first_name', 'last_name', 'title', 'email', 'phone',
                     'school_name', 'source_url']

        with open(filename, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for contact in contacts:
                writer.writerow(contact.to_dict())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Streaming Pipeline - One Lead Through Entire System')
    parser.add_argument('--state', required=True, help='State to search (e.g., texas, california) - loads counties from assets/data/state_counties/{state}.txt')
    parser.add_argument('--global-max-api-calls', type=int, default=3000, help='Global API call cap (default: 3000 for full Texas run, ~254 counties × 5 terms + pagination + Place Details)')
    parser.add_argument('--max-schools', type=int, default=None, help='Maximum number of schools to discover (default: unlimited)')
    parser.add_argument('--county', action='append', default=None, help='County to process (e.g., "Denton"). Can be specified multiple times for multiple counties. If not provided, processes all counties in state.')
    parser.add_argument('--batch-size', type=int, default=0, help='Number of counties to search (0 = all counties in state)')
    parser.add_argument('--max-pages-per-school', type=int, default=3, help='Max pages per school (default: 3)')
    parser.add_argument('--output', default=None, help='Output CSV. If not provided, will generate based on state name (e.g., "Texas leads.csv")')
    
    args = parser.parse_args()
    
    # Get API keys from environment variables only
    google_api_key = os.getenv("GOOGLE_PLACES_API_KEY", "")
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
    
    if not google_api_key or len(google_api_key) < 10:
        sys.exit("GOOGLE_PLACES_API_KEY not set or invalid")
    if not anthropic_api_key or len(anthropic_api_key) < 10:
        sys.exit("ANTHROPIC_API_KEY not set or invalid")
    
    # Create pipeline
    pipeline = StreamingPipeline(
        google_api_key=google_api_key,
        anthropic_api_key=anthropic_api_key,
        global_max_api_calls=args.global_max_api_calls,
        max_pages_per_school=args.max_pages_per_school,
        state=args.state,
        max_schools=args.max_schools
    )
    
    # Determine counties to process
    counties_to_process = None
    if args.county:
        counties_to_process = args.county
    
    # Run pipeline
    try:
        pipeline.run(
            counties=counties_to_process,  # Will use all counties if None, or single county if specified
            batch_size=args.batch_size,
            output_csv=args.output
        )
    except KeyboardInterrupt:
        if pipeline.all_contacts:
            partial_output = args.output or f"partial_{pipeline._state or 'Texas'}_leads.csv"
            pipeline._write_final_csv(pipeline.all_contacts, partial_output)
    except Exception as e:
        sys.exit(f"Pipeline failed: {e}")

