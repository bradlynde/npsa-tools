"""
STEP 3: DISCOVER SITE PAGES
===========================
Crawl each school's website to discover priority internal pages.

Input: CSV from Step 2 with filtered schools + websites
Output: CSV with top-priority staff/admin pages per school
"""

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import csv
import time
from typing import List, Dict, Set
import re
import pandas as pd
from assets.shared.url_safety import BlockedURLError, get_public

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


class PageDiscoverer:
    def __init__(self, timeout: int = 7, max_retries: int = 3):
        self.timeout = timeout  # 7 second timeout
        self.max_retries = max_retries  # 1 retry only
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        
        # Configurable thresholds
        self.min_priority_threshold = 0  # No threshold - title-based filtering only
        
        # Keywords to prioritize pages likely to have decision-maker info
        # NOTE: 'board' removed - we don't want board of trustees pages
        self.high_value_keywords = [
            'staff', 'faculty', 'directory', 'administration', 'admin', 'team',
            'leadership', 'teachers', 'teacher', 'our-team', 'who-we-are', 'meet-our', 'meet our', 'meet-our-team',
            'meet our team', 'meet the team', 'meet the staff', 'meet-the-team',
            'meet-the-staff', 'meet-the-faculty', 'meet our staff', 'meet our faculty',
            'faculty-and-staff', 'faculty-staff', 'faculty-staff-directory',
            'personnel', 'principal', 'superintendent',
            'our staff', 'our team', 'our faculty', 'our leadership', 'our-school',
            # Additional keywords for better discovery
            'about-us', 'about us', 'about-our', 'about our', 'school-leadership', 'school leadership',
            'administrative', 'administrators', 'executive', 'management', 'directors'
        ]
        # Removed 'mission', 'vision', 'history', 'about' from support - they're now zero priority
        self.support_value_keywords = []  # Removed 'about' - it's now zero priority
        self.low_value_keywords = ['info', 'location']  # Removed 'contact' - it's now zero priority
        
        # Keywords that should NOT match (too generic or wrong context)
        # These exclude pages even if they contain high-value keywords
        self.exclude_keywords = [
            'teacher favorites', 'teacher-favorites', 'favorites'  # Not staff directory pages
        ]
        
        # Keywords that immediately set score to 0 (ZERO priority - checked first)
        self.zero_priority_keywords = [
            # Contact pages
            'contact', 'contact-us', 'contactus', 'contact_us',
            # Admissions pages
            'admission', 'admissions', 'apply', 'enrollment', 'enroll',
            # Home and general pages
            'home', 'index',
            # Login pages (require authentication, not useful)
            'login', 'sign-in', 'signin', 'sign-in', 'log-in',
            # Board of Trustees pages (not looking for board members)
            'board', 'trustees', 'board-of-trustees', 'board_of_trustees', 'boardoftrustees',
            'board-members', 'board_members', 'boardmembers',
            # Student leadership pages (not looking for student programs)
            'student leadership', 'student-leadership', 'student_leadership', 'studentleadership',
            'student-leaders', 'student_leaders', 'studentleaders',
            # Mission/vision/history pages (not useful for contacts)
            'mission', 'vision', 'history',
            # Calendar and events
            'calendar', 'event', 'events',
            # Sports and athletics
            'athletic', 'athletics', 'sports',
            # News and blog
            'news', 'blog',
            # Food service
            'lunch', 'menu', 'cafeteria', 'dining',
            # Forms and downloads
            'forms', 'download', 'downloads',
            # Employment
            'employment', 'jobs', 'careers', 'hiring',
            # Social media domains (in URL path)
            'linktr.ee', 'facebook.com', 'instagram.com', 'twitter.com',
            'youtube.com', 'vimeo.com', 'docs.google.com', 'drive.google.com'
        ]
        
        # These are now in zero_priority_keywords, keeping for backward compatibility if needed
        self.bad_url_keywords = [
            'calendar', 'athletic', 'sports', 'admission', 'apply', 'enroll',
            'event', 'news', 'blog', 'lunch', 'menu', 'forms', 'download',
            'linktr.ee', 'facebook.com', 'instagram.com', 'twitter.com',
            'youtube.com', 'vimeo.com', 'docs.google.com', 'drive.google.com'
        ]
        self.bad_domains = [
            'linktr.ee', 'facebook.com', 'instagram.com', 'twitter.com',
            'youtube.com', 'vimeo.com', 'docs.google.com', 'drive.google.com'
        ]
    
    def safe_get(self, url: str) -> requests.Response:
        """Make HTTP request with retry logic"""
        for attempt in range(self.max_retries):
            try:
                # Small delay before request to avoid overwhelming servers
                if attempt == 0:
                    time.sleep(0.2)  # 200ms delay before initial request
                else:
                    time.sleep(0.3)  # 300ms delay before retries
                
                response = get_public(url, headers=self.headers, timeout=self.timeout)
                response.raise_for_status()
                return response
            except BlockedURLError as e:
                from school_run_log import log_warn

                log_warn(f"Page discovery: skipped {e.url} ({e.reason})")
                return None
            except requests.exceptions.Timeout:
                # Silent retry - don't print errors
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff
                else:
                    return None  # Return None instead of raising
            except requests.exceptions.RequestException as e:
                # Silent retry - don't print errors
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return None  # Return None instead of raising
        return None
    
    def extract_links(self, base_url: str, html: str) -> Set[str]:
        """Extract all internal links from HTML, prioritizing links with relevant anchor text"""
        soup = BeautifulSoup(html, 'html.parser')
        links = set()
        prioritized_links = []  # Links with high-value anchor text
        
        # Get domain for filtering internal links only
        # Normalize domain (remove www, handle protocol differences)
        base_parsed = urlparse(base_url)
        base_domain = base_parsed.netloc.lower()
        # Remove 'www.' prefix for comparison
        base_domain_normalized = base_domain.replace('www.', '')
        
        # Keywords that indicate important hash fragments to preserve
        important_fragment_keywords = [
            'team', 'staff', 'faculty', 'leadership', 'directory',
            'contact', 'about', 'administrat', 'office',
            'meet our', 'meet our team', 'our-staff', 'our_staff',
            'ourstaff', 'our-team', 'ourteam', 'staff-directory'
        ]
        
        for link in soup.find_all('a', href=True):
            href = link['href']
            link_text = link.get_text(strip=True).lower()
            
            # Convert relative URLs to absolute
            full_url = urljoin(base_url, href)
            
            # Parse URL
            parsed = urlparse(full_url)
            link_domain = parsed.netloc.lower()
            # Normalize domain (remove www for comparison)
            link_domain_normalized = link_domain.replace('www.', '')
            
            # Only include internal links from same domain (normalized, ignoring www and protocol)
            if link_domain_normalized == base_domain_normalized:
                # Check if fragment contains important keywords
                fragment = parsed.fragment.lower() if parsed.fragment else ''
                has_important_fragment = any(keyword in fragment for keyword in important_fragment_keywords)
                
                # Check if link text contains high-value keywords (boost priority)
                has_high_value_link_text = any(keyword in link_text for keyword in self.high_value_keywords)
                
                # Preserve fragment if it contains important keywords, otherwise remove it
                if has_important_fragment and parsed.fragment:
                    # Keep the fragment for important sections
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}#{parsed.fragment}"
                else:
                    # Remove fragments and query params for cleaner URLs (standard behavior)
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                
                # Skip common non-content URLs
                skip_patterns = [
                    r'\.pdf$', r'\.jpg$', r'\.png$', r'\.gif$', r'\.jpeg$',
                    r'\.doc$', r'\.docx$', r'\.zip$', r'\.mp4$', r'\.mp3$',
                    r'/wp-admin/', r'/wp-login', r'/wp-content/uploads/',
                    r'/login', r'/sign-in', r'/signin', r'/log-in',  # Exclude login pages
                    r'javascript:', r'mailto:', r'tel:'
                ]
                
                # Skip patterns check (removed '#' from patterns since we're preserving some)
                if not any(re.search(pattern, clean_url, re.IGNORECASE) for pattern in skip_patterns):
                    # Prioritize links with high-value anchor text
                    if has_high_value_link_text:
                        prioritized_links.append(clean_url)
                    else:
                        links.add(clean_url)
        
        # Return prioritized links first, then regular links (as a list to preserve order)
        # Convert to set for deduplication, but prioritize will be handled by scoring
        all_links = set(prioritized_links) | links
        return all_links

    def score_page_priority(self, url: str) -> int:
        """Score URL based on likelihood of containing contact info (max 100)"""
        url_lower = url.lower()
        parsed = urlparse(url_lower)
        netloc = parsed.netloc
        score = 0
        
        # ZERO PRIORITY: Contact, admissions, about pages (emails never there)
        # Special handling for "board" - only exclude if it's specifically about boards
        # (not if it's part of "faculty, staff & board" which is primarily staff/faculty)
        board_specific_keywords = ['board-of-trustees', 'board_of_trustees', 'boardoftrustees',
                                   'board-members', 'board_members', 'boardmembers', '/board/', '/trustees/']
        if any(keyword in url_lower for keyword in board_specific_keywords):
            return 0  # Exclude board-specific pages
        
        # Check other zero priority keywords
        for keyword in self.zero_priority_keywords:
            # Skip 'board' here since we handle it above more specifically
            if keyword == 'board':
                continue
            if keyword in url_lower:
                return 0  # Immediately return 0 - these pages are worthless
        
        # High-value keywords get maximum points (these should score 100)
        # Pages like "faculty & staff", "staff directory", "leadership" should hit 100
        for keyword in self.high_value_keywords:
            if keyword in url_lower:
                score += 80  # High value - faculty, staff, team, leadership, etc. (will be capped at 100)
        
        for keyword in self.support_value_keywords:
            if keyword in url_lower:
                score += 10
        for keyword in self.low_value_keywords:
            if keyword in url_lower:
                score += 5
        
        # Penalize low-value keywords / hosts
        for keyword in self.bad_url_keywords:
            if keyword in url_lower:
                score -= 25
        if any(bad_domain in netloc for bad_domain in self.bad_domains):
            score -= 40
        
        # EXTRA BOOST for hash fragments indicating team/staff pages
        if '#' in url_lower:
            hash_part = url_lower.split('#')[1]
            hash_keywords = ['team', 'staff', 'faculty', 'leadership', 'directory', 'admin']
            if any(keyword in hash_part for keyword in hash_keywords):
                score += 20
        
        # Cap at 100 (before email bonus)
        return min(score, 100)
    
    def score_page_content(self, soup: BeautifulSoup) -> int:
        """Score page based on keywords and email detection (bonus up to 100 total)"""
        content_score = 0
        
        # Check heading keywords
        heading_text = ' '.join([h.get_text(separator=' ', strip=True).lower() for h in soup.find_all(['h1', 'h2', 'h3'])])
        for keyword in self.high_value_keywords:
            if keyword in heading_text:
                content_score += 15  # Boost for keywords in headings
                break
        
        # Also check page body text for "meet our team" type phrases
        body_text = soup.get_text(separator=' ', strip=True).lower()
        for keyword in self.high_value_keywords:
            if keyword in body_text:
                content_score += 10  # Boost for keywords in body content
                break
        
        # EMAIL DETECTION BONUS (up to 20 points, but total score capped at 100)
        mailto_links = soup.select('a[href^="mailto:"]')
        mailto_count = len(mailto_links)
        if mailto_count >= 5:
            content_score += 20  # Maximum email bonus
        elif mailto_count >= 2:
            content_score += 15
        elif mailto_count == 1:
            content_score += 10
        
        # Also check for email patterns in text (regex)
        import re
        email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
        email_matches = re.findall(email_pattern, body_text)
        if len(email_matches) >= 5 and mailto_count == 0:
            content_score += 15  # Bonus for emails in text if no mailto links
        elif len(email_matches) >= 2 and mailto_count == 0:
            content_score += 10
        
        return content_score

    def discover_pages(self, school_name: str, base_url: str, max_depth: int = 4, max_pages_per_school: int = 5, top_pages_limit: int = 3) -> List[Dict]:
        """
        Discover all pages on a school website
        
        Args:
            school_name: Name of the school
            base_url: Homepage URL
            max_depth: Maximum crawl depth (default 2)
            max_pages_per_school: Maximum pages to discover per school (default 30)
        
        Returns:
            List of page dictionaries with URL, title, and priority score
        """
        print(f"  Discovering pages for: {school_name}")
        print(f"  Base URL: {base_url}")
        
        if not base_url or base_url == '':
            print("    WARNING: No website URL provided")
            return []
        
        visited = set()
        # Use priority queue: (negative_priority, depth, url) - negative for max-heap behavior
        import heapq
        to_visit = []
        heapq.heappush(to_visit, (0, 0, base_url))  # Start with homepage (priority 0)
        discovered_pages = []
        high_priority_found = 0  # Count pages with score >= 40
        high_value_page_found = False  # Track if a high-value page (score >= 80) was found
        sufficient_pages_found = False  # Early exit flag
        
        # OPTIMIZATION: Stop after finding enough high-scoring pages (early exit)
        # With 5 pages limit, require at least 4 pages AND at least one high-value page before exiting
        # This ensures we get more comprehensive coverage
        min_sufficient_pages = min(4, top_pages_limit) if top_pages_limit >= 5 else min(3, top_pages_limit)
        
        while to_visit and len(discovered_pages) < max_pages_per_school and not sufficient_pages_found:
            # Pop highest priority page
            neg_priority, depth, current_url = heapq.heappop(to_visit)
            priority_estimate = -neg_priority
            
            # Skip if already visited or max depth reached
            if current_url in visited or depth > max_depth:
                continue
            
            # Early stopping: if we found enough pages, stop crawling
            if len(discovered_pages) >= max_pages_per_school:
                break
            
            # Skip zero-priority pages (contact, admissions, home, mission, etc.) - but allow homepage (depth 0)
            if priority_estimate <= 0 and depth > 0:
                continue
            
            visited.add(current_url)
            
            try:
                response = self.safe_get(current_url)
                if not response:
                    continue
                
                # Extract page title (try multiple methods)
                soup = BeautifulSoup(response.text, 'html.parser')
                title_text = ''
                
                # Method 1: Standard <title> tag
                title = soup.find('title')
                if title:
                    title_text = title.get_text().strip()
                
                # Method 2: If no title, try <h1>
                if not title_text:
                    h1 = soup.find('h1')
                    if h1:
                        title_text = h1.get_text().strip()
                
                # Method 3: If still no title, try og:title meta tag
                if not title_text:
                    og_title = soup.find('meta', property='og:title')
                    if og_title and og_title.get('content'):
                        title_text = og_title.get('content').strip()
                
                # Method 4: If still no title, use URL path as fallback
                if not title_text:
                    parsed_url = urlparse(current_url)
                    path_parts = [p for p in parsed_url.path.split('/') if p]
                    if path_parts:
                        # Use last path segment, capitalize words
                        title_text = ' '.join(word.capitalize() for word in path_parts[-1].replace('-', ' ').replace('_', ' ').split())
                    else:
                        title_text = 'Home'
                
                # SIMPLIFIED: Title-based filtering only (no scoring)
                # Check if page should be included based on title/URL keywords
                title_lower = title_text.lower()
                url_lower = current_url.lower()
                priority = 0
                should_include = False
                
                # EXCLUDE: Pages where title is just the school name (likely homepage)
                # Normalize school name and title for comparison (remove common suffixes, punctuation)
                school_name_normalized = school_name.lower().strip()
                title_normalized = title_lower.strip()
                
                # Remove common suffixes from school name for comparison
                school_name_clean = school_name_normalized
                for suffix in [' school', ' academy', ' high school', ' elementary', ' middle school']:
                    if school_name_clean.endswith(suffix):
                        school_name_clean = school_name_clean[:-len(suffix)].strip()
                
                # Check if title matches school name (exact match or title is just school name with minimal text)
                title_is_school_name = (
                    title_normalized == school_name_normalized or 
                    title_normalized == school_name_clean or
                    (title_normalized.startswith(school_name_clean) and len(title_normalized) <= len(school_name_clean) + 15)
                )
                
                # First check: Exclude zero-priority pages (contact, login, board of trustees, student leadership, etc.)
                board_specific_keywords = ['board-of-trustees', 'board_of_trustees', 'boardoftrustees',
                                           'board-members', 'board_members', 'boardmembers', '/board/', '/trustees/']
                if any(keyword in url_lower for keyword in board_specific_keywords):
                    should_include = False  # Exclude board-specific pages
                else:
                    # First check: Exclude pages with exclude keywords (too generic/wrong context)
                    excluded_by_keyword = False
                    for exclude_kw in self.exclude_keywords:
                        if exclude_kw in title_lower or exclude_kw in url_lower:
                            excluded_by_keyword = True
                            break
                    
                    if not excluded_by_keyword:
                        # Check for high-value keywords FIRST (before zero-priority check)
                        # This ensures pages like "/about/faculty-and-staff" are included
                        has_high_value = False
                        for keyword in self.high_value_keywords:
                            if keyword in title_lower or keyword in url_lower:
                                has_high_value = True
                                break
                        
                        # Also check page content (headings) for "Meet Our Staff" type phrases
                        if not has_high_value:
                            heading_text = ' '.join([h.get_text(separator=' ', strip=True).lower() for h in soup.find_all(['h1', 'h2', 'h3', 'h4'])])
                            for keyword in self.high_value_keywords:
                                if keyword in heading_text:
                                    has_high_value = True
                                    break
                    
                    # If it has high-value keywords, check zero-priority keywords
                    # Only exclude if it has zero-priority keywords AND no high-value keywords
                    if has_high_value:
                        # Check zero-priority keywords, but allow if high-value keywords are present
                        excluded = False
                        for keyword in self.zero_priority_keywords:
                            if keyword == 'board':  # Skip generic 'board' - handled above
                                continue
                            # Only exclude if the zero-priority keyword is in the URL/title
                            # AND it's not part of a high-value phrase (e.g., "about" in "/about/faculty" is OK)
                            if keyword in url_lower or keyword in title_lower:
                                # Special case: "about" is OK if it's part of a path with high-value keywords
                                if keyword == 'about' and has_high_value:
                                    continue  # Don't exclude if high-value keywords are present
                                excluded = True
                                break
                        
                        if not excluded:
                            should_include = True
                            priority = 100
                    else:
                        # No high-value keywords, check zero-priority keywords normally
                        for keyword in self.zero_priority_keywords:
                            if keyword == 'board':  # Skip generic 'board' - handled above
                                continue
                            if keyword in url_lower or keyword in title_lower:
                                should_include = False  # Exclude
                                break
                
                # EXCLUDE: If title is just the school name, exclude even if it passed other checks
                if title_is_school_name:
                    should_include = False
                    priority = 0
                
                # If not included, set priority to 0
                if not should_include:
                    priority = 0
                
                # Track high-priority pages
                if priority >= 30:
                    high_priority_found += 1
                if priority >= 80:
                    high_value_page_found = True
                
                # Store page info (we'll filter by threshold later)
                page_info = {
                    'school_name': school_name,
                    'url': current_url,
                    'title': title_text,
                    'priority_score': priority,
                    'depth': depth
                }
                discovered_pages.append(page_info)
                
                # OPTIMIZATION: Early exit - stop crawling if we found enough pages
                # Count all pages (no threshold)
                # Only early exit if we found at least 2 pages (don't exit after just 1 page)
                if high_value_page_found and len(discovered_pages) >= min_sufficient_pages:
                    # We have enough pages, stop crawling
                    sufficient_pages_found = True
                    print(f"    {bold('[STEP 3]')} Found {len(discovered_pages)} sufficient pages - stopping crawl")
                    break
                
                # Extract links for next level crawl (if not at max depth and not at page limit)
                if depth < max_depth and len(discovered_pages) < max_pages_per_school and not sufficient_pages_found:
                    new_links = self.extract_links(base_url, response.text)
                    
                    # Prioritize links: score them before adding to queue
                    scored_links = []
                    for link in new_links:
                        if link not in visited:
                            link_priority = self.score_page_priority(link)
                            # Boost priority if link was in prioritized_links (has high-value anchor text)
                            # Check if link text would have matched (we can't check here, but URL might have keywords)
                            scored_links.append((link, link_priority))
                    
                    # Sort by priority and add top links first (increased to 100 per page to catch more pages)
                    scored_links.sort(key=lambda x: x[1], reverse=True)
                    for link, link_priority in scored_links[:100]:
                        if link not in visited and len(discovered_pages) < max_pages_per_school:
                            heapq.heappush(to_visit, (-link_priority, depth + 1, link))
                
                time.sleep(0.5)  # Polite crawling delay
            
            except Exception as e:
                # Silent error - don't print individual crawl errors
                continue
        
        # Sort by priority score (highest first)
        discovered_pages.sort(key=lambda x: x['priority_score'], reverse=True)
        
        # Filter out pages with score 0 (excluded pages)
        valid_pages = [page for page in discovered_pages if page['priority_score'] > 0]
        
        # FALLBACK: If we didn't find enough high-value pages, try common staff page paths
        if len(valid_pages) < top_pages_limit:
            common_paths = ['/staff', '/faculty', '/team', '/leadership', '/about/team', 
                           '/about/staff', '/about/faculty', '/about/leadership',
                           '/our-team', '/our-staff', '/our-faculty', '/administration']
            
            for path in common_paths:
                if len(valid_pages) >= top_pages_limit:
                    break
                    
                fallback_url = urljoin(base_url, path)
                if fallback_url not in visited and fallback_url != base_url:
                    try:
                        response = self.safe_get(fallback_url)
                        if response and response.status_code == 200:
                            soup = BeautifulSoup(response.text, 'html.parser')
                            title = soup.find('title')
                            title_text = title.get_text().strip() if title else path
                            
                            # Score the fallback page
                            url_score = self.score_page_priority(fallback_url)
                            content_score = self.score_page_content(soup)
                            total_score = min(url_score + content_score, 100)
                            
                            # EXCLUDE: Don't add if title is just the school name
                            title_lower_fallback = title_text.lower().strip()
                            school_name_normalized = school_name.lower().strip()
                            school_name_clean = school_name_normalized
                            for suffix in [' school', ' academy', ' high school', ' elementary', ' middle school']:
                                if school_name_clean.endswith(suffix):
                                    school_name_clean = school_name_clean[:-len(suffix)].strip()
                            
                            title_is_school_name = (
                                title_lower_fallback == school_name_normalized or 
                                title_lower_fallback == school_name_clean or
                                (title_lower_fallback.startswith(school_name_clean) and len(title_lower_fallback) <= len(school_name_clean) + 15)
                            )
                            
                            if total_score > 0 and not title_is_school_name:  # Only add if it has some value and title isn't just school name
                                valid_pages.append({
                                    'url': fallback_url,
                                    'title': title_text,
                                    'priority_score': total_score,
                                    'school_name': school_name
                                })
                                print(f"    {bold('[STEP 3]')} Found fallback page: {path} (score: {total_score})")
                    except:
                        pass  # Silently skip if fallback fails
        
        # Limit to top pages per school (highest scores)
        # Sort by score descending
        valid_pages.sort(key=lambda x: x['priority_score'], reverse=True)
        discovered_pages = valid_pages[:top_pages_limit]
        
        if discovered_pages:
            print(f"    {bold('[STEP 3]')} Found {len(discovered_pages)} page(s)")
            for page in discovered_pages:
                title = page['title']
                if len(title) > 80:
                    title = title[:77] + "..."
                print(f"      Page: \"{title}\"")
        else:
            print(f"    ⚠ No pages found")
        
        return discovered_pages

    def process_schools_csv(self, input_csv: str, output_csv: str, max_depth: int = 3, max_pages_per_school: int = 3, top_pages_limit: int = 3):
        """
        Process schools from Step 1 CSV and discover all their pages
        
        Args:
            input_csv: CSV file from Step 1 with school data
            output_csv: Output CSV with discovered pages
            max_depth: Maximum crawl depth
            max_pages_per_school: Maximum pages per school
        """
        print("\n" + "="*70)
        print("STEP 3: PAGE DISCOVERY")
        print("="*70)
        
        # Read input CSV
        df = pd.read_csv(input_csv)
        
        # Filter to schools with websites (process ALL schools)
        df_with_urls = df[df['website'].notna() & (df['website'] != '')]
        
        print(f"Processing {len(df_with_urls)} schools with websites")
        print("="*70 + "\n")
        
        all_pages = []
        
        for idx, row in df_with_urls.iterrows():
            school_name = row['name']
            base_url = row['website']
            
            print(f"\n[{idx + 1}/{len(df_with_urls)}] {school_name}")
            
            try:
                pages = self.discover_pages(school_name, base_url, max_depth=max_depth, max_pages_per_school=max_pages_per_school, top_pages_limit=top_pages_limit)
                all_pages.extend(pages)
                
            except Exception as e:
                print(f"    ERROR: {e}")
                continue
            
            # Save progress every 10 schools
            if (idx + 1) % 10 == 0:
                self._save_progress(all_pages, output_csv)
                print(f"\n  Progress saved: {len(all_pages)} pages discovered")
        
        # Final save
        self._save_progress(all_pages, output_csv)
        
        print("\n" + "="*70)
        print("PAGE DISCOVERY COMPLETE")
        print("="*70)
        print(f"Total pages discovered: {len(all_pages)}")
        print(f"Output file: {output_csv}")
        print("="*70)
        
    def _save_progress(self, pages: List[Dict], filename: str):
        """Save discovered pages to CSV"""
        if not pages:
            return
        
        df = pd.DataFrame(pages)
        df.to_csv(filename, index=False)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Discover pages on school websites')
    parser.add_argument('--input', required=True, help='Input CSV from Step 2')
    parser.add_argument('--output', default='step3_pages.csv', help='Output CSV filename')
    parser.add_argument('--max-depth', type=int, default=3, help='Maximum crawl depth (default: 3)')
    parser.add_argument('--max-pages-per-school', type=int, default=1000, help='Maximum pages to discover per school (default: 1000 - no practical limit)')
    parser.add_argument('--top-pages-limit', type=int, default=1000, help='Final filter: keep only top N pages per school by priority (default: 1000 - no practical limit)')
    
    args = parser.parse_args()
    
    discoverer = PageDiscoverer()
    discoverer.process_schools_csv(args.input, args.output, max_depth=args.max_depth, max_pages_per_school=args.max_pages_per_school, top_pages_limit=args.top_pages_limit)
