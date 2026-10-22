"""
CHURCH STREAMING PIPELINE ORCHESTRATOR
======================================
Process one church lead through all steps, then write to final CSV only.
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
    if os.environ.get("CHURCH_LOG_TRACEBACK", "").strip() in ("1", "true", "yes"):
        traceback.print_exc()

# Import shared models
from assets.shared.models import Church, Page, PageContent, Contact
from church_run_log import (
    log_church_skip,
    log_church_success,
    log_county_done,
    log_err,
    log_warn,
)

# Import streaming steps
_script_dir = Path(__file__).parent
_steps_dir = _script_dir / "steps"
step1_spec = importlib.util.spec_from_file_location("step1_search", _steps_dir / "step1-search.py")
step1_module = importlib.util.module_from_spec(step1_spec)
step1_spec.loader.exec_module(step1_module)
ChurchSearcher = step1_module.ChurchSearcher

step2_spec = importlib.util.spec_from_file_location("step2_church_filter", _steps_dir / "step2-church_filter.py")
step2_module = importlib.util.module_from_spec(step2_spec)
step2_spec.loader.exec_module(step2_module)
filter_church = step2_module.filter_church
LLMChurchFilter = step2_module.LLMChurchFilter


def load_counties_from_state(state: str) -> List[str]:
    """Load counties for a given state from assets/data/state_counties/{state}.txt"""
    state_normalized = state.lower().replace(' ', '_')
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
            if county and not county.startswith('#'):
                counties.append(county)
    
    if not counties:
        raise ValueError(f"No counties found in {state_file}")
    
    return counties


def load_module_with_hyphen(filename, module_name):
    """Load a Python module from a file with hyphens in the filename"""
    spec = importlib.util.spec_from_file_location(module_name, _steps_dir / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

step3 = load_module_with_hyphen('step3-discovery.py', 'step3_discovery')
step4 = load_module_with_hyphen('step4-crawler.py', 'step4_crawler')
step5 = load_module_with_hyphen('step5-html_reduction.py', 'step5_html_reduction')
step6 = load_module_with_hyphen('step6-html_chunking.py', 'step6_html_chunking')
step7 = load_module_with_hyphen('step7-llm_parser.py', 'step7_llm_parser')
step8 = load_module_with_hyphen('step8-lead_cleaner.py', 'step8_lead_cleaner')
step9 = load_module_with_hyphen('step9-lead_dedupe.py', 'step9_lead_dedupe')
step10 = load_module_with_hyphen('step10-lead_filter.py', 'step10_lead_filter')
step11_contact_splitter = load_module_with_hyphen('step11-contact_splitter.py', 'step11_contact_splitter')
step12_hunter_io = load_module_with_hyphen('step12-enrichment.py', 'step12_enrichment')
step13_final_compiler = load_module_with_hyphen('step13-compiler.py', 'step13_compiler')


class StreamingPipeline:
    """Process church leads through entire pipeline one at a time"""
    
    def __init__(
        self,
        google_api_key: str,
        anthropic_api_key: str,
        global_max_api_calls: int = 25,
        max_pages_per_church: int = 3,
        state: str = 'Texas',
        max_churches: int = None,
        chrome_tmp_dir: Optional[str] = None
    ):
        self.google_api_key = google_api_key
        self.anthropic_api_key = anthropic_api_key
        self.global_max_api_calls = global_max_api_calls
        self.max_pages_per_church = max_pages_per_church
        self._state = state
        self.max_churches = max_churches
        
        if not google_api_key or len(google_api_key) < 10:
            log_warn(
                f"Google API key appears invalid in Pipeline (length: {len(google_api_key) if google_api_key else 0})"
            )
        self.church_searcher = ChurchSearcher(google_api_key, global_max_api_calls, max_churches=max_churches, target_state=state)
        
        if anthropic_api_key:
            try:
                self.llm_church_filter = LLMChurchFilter(
                    api_key=anthropic_api_key,
                    target_state=state,
                    model="claude-haiku-5-5",
                    batch_size=20
                )
            except Exception as e:
                log_warn(f"Could not initialize LLM church filter: {e}")
                self.llm_church_filter = None
        else:
            self.llm_church_filter = None
        
        self.page_discoverer = step3.PageDiscoverer(timeout=10, max_retries=3)
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
        
        self.all_contacts = []
        self.unique_contacts_set = set()
        self.stats = {
            "churches_discovered": 0,
            "churches_filtered_out": 0,
            "churches_processed": 0,
            "pages_discovered": 0,
            "pages_collected": 0,
            "contacts_extracted": 0,
            "contacts_with_emails": 0,
            "places_api_calls": 0,
            "openai_calls": 0,
            "openai_prompt_tokens": 0,
            "openai_completion_tokens": 0,
        }
    
    def _get_contact_key(self, contact: Contact) -> str:
        """Generate a unique key for a contact for deduplication tracking."""
        if contact.email:
            email_key = contact.email.lower().strip()
            if email_key:
                return f"email:{email_key}"
        
        first_name = (contact.first_name or '').lower().strip()
        last_name = (contact.last_name or '').lower().strip()
        church_name = (contact.church_name or '').lower().strip()
        
        if first_name or last_name:
            return f"name:{first_name}|{last_name}|{church_name}"
        
        return f"fallback:{first_name}|{last_name}|{church_name}|{contact.title or ''}"
    
    def process_single_lead(self, church: Church) -> List[Contact]:
        """Process one church through all steps. Returns list of Contact objects."""
        t_start = time.time()

        filter_result = filter_church(
            church, target_state=self._state, llm_filter=self.llm_church_filter
        )
        if isinstance(filter_result, tuple):
            filtered_church, filter_reason = filter_result
        else:
            filtered_church, filter_reason = filter_result, None

        if not filtered_church:
            if filter_reason and "LLM rejected" in filter_reason:
                log_church_skip(church.name, "filtered (LLM)")
            elif filter_reason and "failed pre-filters" in filter_reason:
                log_church_skip(church.name, "filtered (pre-filter)")
            elif filter_reason:
                log_church_skip(church.name, f"filtered ({filter_reason[:40]})")
            else:
                log_church_skip(church.name, "filtered")
            self.stats["churches_filtered_out"] += 1
            return []

        if not filtered_church.website:
            log_church_skip(church.name, "no website")
            return []

        t_discover = time.time()
        try:
            pages = self._discover_pages_for_church(filtered_church)
            self.stats["pages_discovered"] += len(pages)

            if not pages:
                log_church_skip(church.name, "no pages found")
                return []
        except Exception as e:
            log_err(f"Page discovery: {church.name}: {e}")
            _maybe_traceback()
            return []
        t_after_discover = time.time()

        page_contents = []
        for page in pages[:self.max_pages_per_church]:
            try:
                content = self._collect_content_for_page(page)
                if content:
                    page_contents.append(content)
                    self.stats['pages_collected'] += 1
            except Exception as e:
                continue
        t_after_crawl = time.time()

        if not page_contents:
            log_church_skip(church.name, "no content collected")
            return []

        all_contacts = []
        for page_content in page_contents:
            try:
                contacts = self._parse_content_with_llm(page_content, filtered_church)
                all_contacts.extend(contacts)
            except Exception as e:
                continue
        t_after_parse = time.time()

        if all_contacts:
            if os.getenv("CHURCH_LOG_TIMING", "").strip() in ("1", "true", "yes"):
                log_church_success(
                    church.name,
                    len(all_contacts),
                    timing=f"discover:{t_after_discover - t_discover:.1f}s "
                           f"crawl:{t_after_crawl - t_after_discover:.1f}s "
                           f"parse:{t_after_parse - t_after_crawl:.1f}s "
                           f"total:{t_after_parse - t_start:.1f}s",
                )
            else:
                log_church_success(church.name, len(all_contacts))
        else:
            log_church_skip(church.name, "no contacts")

        self.stats["churches_processed"] += 1
        return all_contacts
    
    def _discover_pages_for_church(self, church: Church) -> List[Page]:
        """Discover pages for a single church using step3's discover_pages method."""
        if not church.website:
            return []
        
        pages = []
        try:
            discovered_pages = self.page_discoverer.discover_pages(
                church_name=church.name,
                base_url=church.website,
                max_depth=3,
                max_pages_per_church=self.max_pages_per_church,
                top_pages_limit=self.max_pages_per_church
            )
            
            for page_dict in discovered_pages:
                pages.append(Page(
                    url=page_dict['url'],
                    church_name=church.name,
                    church_place_id=church.place_id,
                    church_website=church.website,
                    priority_score=page_dict.get('priority_score', 0),
                    page_title=page_dict.get('title'),
                    discovered_via=page_dict.get('url')
                ))
        except Exception as e:
            log_err(f"Page discovery inner: {e}")
            _maybe_traceback()
        
        return pages
    
    def _collect_content_for_page(self, page: Page) -> Optional[PageContent]:
        """Collect content for a single page using step4's collect_page_content method."""
        try:
            result = self.content_collector.collect_page_content(page.church_name, page.url)
            
            if not result:
                return None
            
            html_content = result.get('html_content', '')
            fetch_method = result.get('fetch_method', 'unknown')
            email_count = result.get('email_count', 0)
            
            return PageContent(
                url=page.url,
                church_name=page.church_name,
                html_content=html_content or '',
                email_count=email_count,
                has_emails=email_count > 0,
                collection_method=fetch_method
            )
        except Exception as e:
            log_err(f"Content collection: {e}")
            _maybe_traceback()
            return None
    
    def _parse_content_with_llm(self, page_content: PageContent, church: Church) -> List[Contact]:
        """Parse content with LLM using step5's reduction and chunking logic."""
        if not page_content.html_content:
            return []
        
        try:
            reduced_html = self.html_reducer.reduce_html(page_content.html_content)
            if not reduced_html:
                return []
            
            chunks = self.html_chunker.chunk_html(reduced_html, max_chunk_size=50000)
            
            page_contacts_dicts = []
            for chunk_idx, chunk in enumerate(chunks):
                csv_text = self.llm_parser.parse_with_llm(
                    chunk,
                    church.name,
                    page_content.url,
                    max_retries=1
                )
                
                if csv_text:
                    chunk_contacts = self.csv_parser.parse_csv_response(csv_text)
                    for contact in chunk_contacts:
                        contact['church_name'] = church.name
                        contact['source_url'] = page_content.url
                    page_contacts_dicts.extend(chunk_contacts)
                
                if chunk_idx < len(chunks) - 1:
                    time.sleep(1.0)
            
            if not page_contacts_dicts:
                return []
            
            deduped_contacts = self.deduplicator.deduplicate_contacts(page_contacts_dicts)
            
            # Use batched LLM filtering for speed (~8x faster at batch_size=10)
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
                        church_name=church.name,
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
        """Run the streaming pipeline. Processes churches one at a time through all steps."""
        county_wall_start = time.time()
        churches_discovered = 0

        if not counties:
            if not hasattr(self, '_state') or not self._state:
                raise ValueError("--state parameter is required for county-based search")
            counties = load_counties_from_state(self._state)
        
        max_search_terms_per_county = 16
        
        church_generator = self.church_searcher.discover_churches(
            counties=counties,
            state=self._state or 'Texas',
            batch_size=batch_size,
            max_search_terms=max_search_terms_per_county
        )
        
        for church in church_generator:
            churches_discovered += 1
            self.stats["churches_discovered"] = churches_discovered

            contacts = self.process_single_lead(church)

            for contact in contacts:
                contact_key = self._get_contact_key(contact)
                if contact_key not in self.unique_contacts_set:
                    self.unique_contacts_set.add(contact_key)

            self.all_contacts.extend(contacts)

        if self.llm_church_filter:
            self.llm_church_filter.flush()
        
        if not output_csv or output_csv == "final_contacts.csv":
            output_csv = "final_contacts.csv"

        if self.all_contacts:
            self._write_final_csv(self.all_contacts, output_csv)
        else:
            pass

        self.stats["contacts_extracted"] = len(self.all_contacts)
        self.stats["unique_contacts"] = len(self.unique_contacts_set)

        contacts_with_emails = [c for c in self.all_contacts if c.has_email()]
        contacts_without_emails = [c for c in self.all_contacts if not c.has_email()]
        self.stats["contacts_with_emails"] = len(contacts_with_emails)
        self.stats["contacts_without_emails"] = len(contacts_without_emails)

        self.stats["places_api_calls"] = self.church_searcher.stats.get(
            "total_api_calls", 0
        )
        self.stats["openai_calls"] = getattr(
            self.llm_parser, "total_api_calls", 0
        ) + getattr(self.title_filter, "total_api_calls", 0)
        self.stats["openai_prompt_tokens"] = getattr(
            self.llm_parser, "total_prompt_tokens", 0
        ) + getattr(self.title_filter, "total_prompt_tokens", 0)
        self.stats["openai_completion_tokens"] = getattr(
            self.llm_parser, "total_completion_tokens", 0
        ) + getattr(self.title_filter, "total_completion_tokens", 0)

        if counties and len(counties) == 1:
            elapsed_min = (time.time() - county_wall_start) / 60.0
            log_county_done(
                len(self.all_contacts),
                len(contacts_with_emails),
                elapsed_min,
            )
    
    def cleanup(self):
        """Basic cleanup: quit Selenium driver if it exists."""
        try:
            if hasattr(self, 'content_collector') and self.content_collector:
                if self.content_collector.driver:
                    self.content_collector.driver.quit()
                    self.content_collector.driver = None
        except Exception:
            pass
    
    def __del__(self):
        try:
            self.cleanup()
        except:
            pass
    
    def _write_final_csv(self, contacts: List[Contact], filename: str):
        """Write contacts to final CSV file"""
        if not contacts:
            return

        fieldnames = [
            "first_name",
            "last_name",
            "title",
            "email",
            "phone",
            "church_name",
            "source_url",
        ]

        with open(filename, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for contact in contacts:
                writer.writerow(contact.to_dict())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Church Streaming Pipeline')
    parser.add_argument('--state', required=True, help='State to search (e.g., texas, california)')
    parser.add_argument('--global-max-api-calls', type=int, default=3000, help='Global API call cap')
    parser.add_argument('--max-churches', type=int, default=None, help='Maximum number of churches to discover')
    parser.add_argument('--county', action='append', default=None, help='County to process (can specify multiple)')
    parser.add_argument('--batch-size', type=int, default=0, help='Number of counties to search (0 = all)')
    parser.add_argument('--max-pages-per-church', type=int, default=3, help='Max pages per church (default: 3)')
    parser.add_argument('--output', default=None, help='Output CSV filename')
    
    args = parser.parse_args()
    
    google_api_key = os.getenv("GOOGLE_PLACES_API_KEY", "")
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
    
    if not google_api_key or len(google_api_key) < 10:
        print(f"ERROR: GOOGLE_PLACES_API_KEY environment variable not set or invalid")
        sys.exit(1)
    
    if not anthropic_api_key or len(anthropic_api_key) < 10:
        print(f"ERROR: ANTHROPIC_API_KEY environment variable not set or invalid")
        sys.exit(1)
    
    pipeline = StreamingPipeline(
        google_api_key=google_api_key,
        anthropic_api_key=anthropic_api_key,
        global_max_api_calls=args.global_max_api_calls,
        max_pages_per_church=args.max_pages_per_church,
        state=args.state,
        max_churches=args.max_churches
    )
    
    counties_to_process = None
    if args.county:
        counties_to_process = args.county
        if len(counties_to_process) == 1:
            print(f"Processing single county: {counties_to_process[0]}")
        else:
            print(f"Processing {len(counties_to_process)} counties: {', '.join(counties_to_process)}")
    
    try:
        pipeline.run(
            counties=counties_to_process,
            batch_size=args.batch_size,
            output_csv=args.output
        )
    except KeyboardInterrupt:
        print("\n\nPipeline interrupted by user.")
        print(f"Partial results: {len(pipeline.all_contacts)} contacts extracted")
        if pipeline.all_contacts:
            partial_output = args.output or f"partial_{pipeline._state or 'Texas'}_church_leads.csv"
            pipeline._write_final_csv(
                pipeline.all_contacts,
                partial_output
            )
    except Exception as e:
        print(f"\n\nPipeline failed: {e}")
        _maybe_traceback()
        sys.exit(1)
