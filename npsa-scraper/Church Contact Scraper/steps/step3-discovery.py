"""
STEP 3: DISCOVER SITE PAGES
===========================
Crawl each church's website to discover priority internal pages.

Input: CSV from Step 2 with filtered churches + websites
Output: CSV with top-priority staff/ministry pages per church
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
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        
        self.min_priority_threshold = 0
        
        # Keywords for church staff/ministry pages
        self.high_value_keywords = [
            'staff', 'faculty', 'directory', 'administration', 'admin', 'team',
            'leadership', 'ministry', 'pastor', 'clergy', 'elders', 'vestry', 'session',
            'our-team', 'who-we-are', 'meet-our', 'meet our', 'meet-our-team',
            'meet our team', 'meet the team', 'meet the staff', 'meet-the-team',
            'meet-the-staff', 'meet our staff', 'meet our ministry',
            'personnel', 'our staff', 'our team', 'our ministry', 'our leadership',
            'about-us', 'about us', 'about-our', 'about our', 'church-leadership', 'church leadership',
            'administrative', 'administrators', 'executive', 'management', 'directors'
        ]
        self.support_value_keywords = []
        self.low_value_keywords = ['info', 'location']
        
        self.exclude_keywords = [
            'teacher favorites', 'teacher-favorites', 'favorites'
        ]
        
        self.zero_priority_keywords = [
            'contact', 'contact-us', 'contactus', 'contact_us',
            'admission', 'admissions', 'apply', 'enrollment', 'enroll',
            'home', 'index',
            'login', 'sign-in', 'signin', 'log-in',
            'board', 'trustees', 'board-of-trustees', 'board_of_trustees', 'boardoftrustees',
            'board-members', 'board_members', 'boardmembers',
            'mission', 'vision', 'history',
            'calendar', 'event', 'events',
            'athletic', 'athletics', 'sports',
            'news', 'blog',
            'lunch', 'menu', 'cafeteria', 'dining',
            'forms', 'download', 'downloads',
            'employment', 'jobs', 'careers', 'hiring',
            'linktr.ee', 'facebook.com', 'instagram.com', 'twitter.com',
            'youtube.com', 'vimeo.com', 'docs.google.com', 'drive.google.com'
        ]
        
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
                if attempt == 0:
                    time.sleep(0.2)
                else:
                    time.sleep(0.3)
                
                response = get_public(url, headers=self.headers, timeout=self.timeout)
                response.raise_for_status()
                return response
            except BlockedURLError as e:
                from church_run_log import log_warn

                log_warn(f"Page discovery: skipped {e.url} ({e.reason})")
                return None
            except requests.exceptions.Timeout:
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return None
            except requests.exceptions.RequestException:
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return None
        return None
    
    def extract_links(self, base_url: str, html: str) -> Set[str]:
        """Extract all internal links from HTML"""
        soup = BeautifulSoup(html, 'html.parser')
        links = set()
        prioritized_links = []
        
        base_parsed = urlparse(base_url)
        base_domain = base_parsed.netloc.lower()
        base_domain_normalized = base_domain.replace('www.', '')
        
        important_fragment_keywords = [
            'team', 'staff', 'faculty', 'leadership', 'directory', 'ministry', 'pastor', 'clergy',
            'contact', 'about', 'administrat', 'office',
            'meet our', 'meet our team', 'our-staff', 'our_staff',
            'ourstaff', 'our-team', 'ourteam', 'staff-directory'
        ]
        
        for link in soup.find_all('a', href=True):
            href = link['href']
            link_text = link.get_text(strip=True).lower()
            
            full_url = urljoin(base_url, href)
            parsed = urlparse(full_url)
            link_domain = parsed.netloc.lower()
            link_domain_normalized = link_domain.replace('www.', '')
            
            if link_domain_normalized == base_domain_normalized:
                fragment = parsed.fragment.lower() if parsed.fragment else ''
                has_important_fragment = any(keyword in fragment for keyword in important_fragment_keywords)
                has_high_value_link_text = any(keyword in link_text for keyword in self.high_value_keywords)
                
                if has_important_fragment and parsed.fragment:
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}#{parsed.fragment}"
                else:
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                
                skip_patterns = [
                    r'\.pdf$', r'\.jpg$', r'\.png$', r'\.gif$', r'\.jpeg$',
                    r'\.doc$', r'\.docx$', r'\.zip$', r'\.mp4$', r'\.mp3$',
                    r'/wp-admin/', r'/wp-login', r'/wp-content/uploads/',
                    r'/login', r'/sign-in', r'/signin', r'/log-in',
                    r'javascript:', r'mailto:', r'tel:'
                ]
                
                if not any(re.search(pattern, clean_url, re.IGNORECASE) for pattern in skip_patterns):
                    if has_high_value_link_text:
                        prioritized_links.append(clean_url)
                    else:
                        links.add(clean_url)
        
        all_links = set(prioritized_links) | links
        return all_links

    def score_page_priority(self, url: str) -> int:
        """Score URL based on likelihood of containing contact info"""
        url_lower = url.lower()
        parsed = urlparse(url_lower)
        netloc = parsed.netloc
        score = 0
        
        board_specific_keywords = ['board-of-trustees', 'board_of_trustees', 'boardoftrustees',
                                   'board-members', 'board_members', 'boardmembers', '/board/', '/trustees/']
        if any(keyword in url_lower for keyword in board_specific_keywords):
            return 0
        
        for keyword in self.zero_priority_keywords:
            if keyword == 'board':
                continue
            if keyword in url_lower:
                return 0
        
        for keyword in self.high_value_keywords:
            if keyword in url_lower:
                score += 80
        
        for keyword in self.support_value_keywords:
            if keyword in url_lower:
                score += 10
        for keyword in self.low_value_keywords:
            if keyword in url_lower:
                score += 5
        
        for keyword in self.bad_url_keywords:
            if keyword in url_lower:
                score -= 25
        if any(bad_domain in netloc for bad_domain in self.bad_domains):
            score -= 40
        
        if '#' in url_lower:
            hash_part = url_lower.split('#')[1]
            hash_keywords = ['team', 'staff', 'faculty', 'leadership', 'directory', 'admin', 'ministry', 'pastor']
            if any(keyword in hash_part for keyword in hash_keywords):
                score += 20
        
        return min(score, 100)
    
    def score_page_content(self, soup: BeautifulSoup) -> int:
        """Score page based on keywords and email detection"""
        content_score = 0
        
        heading_text = ' '.join([h.get_text(separator=' ', strip=True).lower() for h in soup.find_all(['h1', 'h2', 'h3'])])
        for keyword in self.high_value_keywords:
            if keyword in heading_text:
                content_score += 15
                break
        
        body_text = soup.get_text(separator=' ', strip=True).lower()
        for keyword in self.high_value_keywords:
            if keyword in body_text:
                content_score += 10
                break
        
        mailto_links = soup.select('a[href^="mailto:"]')
        mailto_count = len(mailto_links)
        if mailto_count >= 5:
            content_score += 20
        elif mailto_count >= 2:
            content_score += 15
        elif mailto_count == 1:
            content_score += 10
        
        email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
        email_matches = re.findall(email_pattern, body_text)
        if len(email_matches) >= 5 and mailto_count == 0:
            content_score += 15
        elif len(email_matches) >= 2 and mailto_count == 0:
            content_score += 10
        
        return content_score

    def discover_pages(self, church_name: str, base_url: str, max_depth: int = 4, max_pages_per_church: int = 5, top_pages_limit: int = 3) -> List[Dict]:
        """
        Discover all pages on a church website
        
        Args:
            church_name: Name of the church
            base_url: Homepage URL
            max_depth: Maximum crawl depth
            max_pages_per_church: Maximum pages to discover per church
            top_pages_limit: Limit of top pages to return
        
        Returns:
            List of page dictionaries with url, church_name, title, priority_score
        """
        if not base_url or base_url == "":
            from church_run_log import log_warn

            log_warn("Page discovery: no website URL")
            return []
        
        visited = set()
        import heapq
        to_visit = []
        heapq.heappush(to_visit, (0, 0, base_url))
        discovered_pages = []
        high_value_page_found = False
        sufficient_pages_found = False
        
        min_sufficient_pages = min(4, top_pages_limit) if top_pages_limit >= 5 else min(3, top_pages_limit)
        
        while to_visit and len(discovered_pages) < max_pages_per_church and not sufficient_pages_found:
            neg_priority, depth, current_url = heapq.heappop(to_visit)
            priority_estimate = -neg_priority
            
            if current_url in visited or depth > max_depth:
                continue
            
            if len(discovered_pages) >= max_pages_per_church:
                break
            
            if priority_estimate <= 0 and depth > 0:
                continue
            
            visited.add(current_url)
            
            try:
                response = self.safe_get(current_url)
                if not response:
                    continue
                
                soup = BeautifulSoup(response.text, 'html.parser')
                title_text = ''
                
                title = soup.find('title')
                if title:
                    title_text = title.get_text().strip()
                
                if not title_text:
                    h1 = soup.find('h1')
                    if h1:
                        title_text = h1.get_text().strip()
                
                if not title_text:
                    og_title = soup.find('meta', property='og:title')
                    if og_title and og_title.get('content'):
                        title_text = og_title.get('content').strip()
                
                if not title_text:
                    parsed_url = urlparse(current_url)
                    path_parts = [p for p in parsed_url.path.split('/') if p]
                    if path_parts:
                        title_text = ' '.join(word.capitalize() for word in path_parts[-1].replace('-', ' ').replace('_', ' ').split())
                    else:
                        title_text = 'Home'
                
                title_lower = title_text.lower()
                url_lower = current_url.lower()
                priority = 0
                should_include = False
                
                # Church name suffixes for comparison
                church_name_normalized = church_name.lower().strip()
                title_normalized = title_lower.strip()
                church_name_clean = church_name_normalized
                for suffix in [' church', ' parish', ' congregation', ' fellowship', ' ministry', ' academy']:
                    if church_name_clean.endswith(suffix):
                        church_name_clean = church_name_clean[:-len(suffix)].strip()
                
                title_is_church_name = (
                    title_normalized == church_name_normalized or 
                    title_normalized == church_name_clean or
                    (title_normalized.startswith(church_name_clean) and len(title_normalized) <= len(church_name_clean) + 15)
                )
                
                board_specific_keywords = ['board-of-trustees', 'board_of_trustees', 'boardoftrustees',
                                           'board-members', 'board_members', 'boardmembers', '/board/', '/trustees/']
                if any(keyword in url_lower for keyword in board_specific_keywords):
                    should_include = False
                else:
                    excluded_by_keyword = False
                    for exclude_kw in self.exclude_keywords:
                        if exclude_kw in title_lower or exclude_kw in url_lower:
                            excluded_by_keyword = True
                            break
                    
                    if not excluded_by_keyword:
                        has_high_value = False
                        for keyword in self.high_value_keywords:
                            if keyword in title_lower or keyword in url_lower:
                                has_high_value = True
                                break
                        
                        if not has_high_value:
                            heading_text = ' '.join([h.get_text(separator=' ', strip=True).lower() for h in soup.find_all(['h1', 'h2', 'h3', 'h4'])])
                            for keyword in self.high_value_keywords:
                                if keyword in heading_text:
                                    has_high_value = True
                                    break
                    
                    if has_high_value:
                        excluded = False
                        for keyword in self.zero_priority_keywords:
                            if keyword == 'board':
                                continue
                            if keyword in url_lower or keyword in title_lower:
                                if keyword == 'about' and has_high_value:
                                    continue
                                excluded = True
                                break
                        
                        if not excluded:
                            should_include = True
                            priority = 100
                    else:
                        for keyword in self.zero_priority_keywords:
                            if keyword == 'board':
                                continue
                            if keyword in url_lower or keyword in title_lower:
                                should_include = False
                                break
                
                if title_is_church_name:
                    should_include = False
                    priority = 0
                
                if not should_include:
                    priority = 0
                
                if priority >= 80:
                    high_value_page_found = True
                
                page_info = {
                    'church_name': church_name,
                    'url': current_url,
                    'title': title_text,
                    'priority_score': priority,
                    'depth': depth
                }
                discovered_pages.append(page_info)
                
                if high_value_page_found and len(discovered_pages) >= min_sufficient_pages:
                    sufficient_pages_found = True
                    break
                
                if depth < max_depth and len(discovered_pages) < max_pages_per_church and not sufficient_pages_found:
                    new_links = self.extract_links(base_url, response.text)
                    scored_links = []
                    for link in new_links:
                        if link not in visited:
                            link_priority = self.score_page_priority(link)
                            scored_links.append((link, link_priority))
                    
                    scored_links.sort(key=lambda x: x[1], reverse=True)
                    for link, link_priority in scored_links[:100]:
                        if link not in visited and len(discovered_pages) < max_pages_per_church:
                            heapq.heappush(to_visit, (-link_priority, depth + 1, link))
                
                time.sleep(0.5)
            
            except Exception:
                continue
        
        discovered_pages.sort(key=lambda x: x['priority_score'], reverse=True)
        valid_pages = [page for page in discovered_pages if page['priority_score'] > 0]
        
        # Church fallback paths
        if len(valid_pages) < top_pages_limit:
            common_paths = ['/staff', '/ministry', '/pastor', '/clergy', '/elders', '/vestry',
                           '/team', '/leadership', '/about/team', '/about/staff', '/about/leadership',
                           '/our-team', '/our-staff', '/our-ministry', '/administration',
                           '/aboutus', '/about-us']
            
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
                            
                            url_score = self.score_page_priority(fallback_url)
                            content_score = self.score_page_content(soup)
                            total_score = min(url_score + content_score, 100)
                            
                            title_lower_fallback = title_text.lower().strip()
                            church_name_normalized = church_name.lower().strip()
                            church_name_clean = church_name_normalized
                            for suffix in [' church', ' parish', ' congregation', ' fellowship', ' ministry', ' academy']:
                                if church_name_clean.endswith(suffix):
                                    church_name_clean = church_name_clean[:-len(suffix)].strip()
                            
                            title_is_church_name = (
                                title_lower_fallback == church_name_normalized or 
                                title_lower_fallback == church_name_clean or
                                (title_lower_fallback.startswith(church_name_clean) and len(title_lower_fallback) <= len(church_name_clean) + 15)
                            )
                            
                            if total_score > 0 and not title_is_church_name:
                                valid_pages.append({
                                    "url": fallback_url,
                                    "title": title_text,
                                    "priority_score": total_score,
                                    "church_name": church_name,
                                })
                    except Exception:
                        pass
        
        valid_pages.sort(key=lambda x: x['priority_score'], reverse=True)
        discovered_pages = valid_pages[:top_pages_limit]
        
        return discovered_pages

    def process_churches_csv(self, input_csv: str, output_csv: str, max_depth: int = 3, max_pages_per_church: int = 3, top_pages_limit: int = 3):
        """Process churches from Step 1 CSV and discover all their pages"""
        df = pd.read_csv(input_csv)
        df_with_urls = df[df["website"].notna() & (df["website"] != "")]

        all_pages = []
        
        for idx, row in df_with_urls.iterrows():
            church_name = row['name']
            base_url = row['website']
            
            
            try:
                pages = self.discover_pages(church_name, base_url, max_depth=max_depth, max_pages_per_church=max_pages_per_church, top_pages_limit=top_pages_limit)
                all_pages.extend(pages)
                
            except Exception as e:
                from church_run_log import log_err

                log_err(f"Step3 CSV row: {e}")
                continue
            
            if (idx + 1) % 10 == 0:
                self._save_progress(all_pages, output_csv)
        
        self._save_progress(all_pages, output_csv)
        
        
    def _save_progress(self, pages: List[Dict], filename: str):
        """Save discovered pages to CSV"""
        if not pages:
            return
        
        df = pd.DataFrame(pages)
        df.to_csv(filename, index=False)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Discover pages on church websites')
    parser.add_argument('--input', required=True, help='Input CSV from Step 2')
    parser.add_argument('--output', default='step3_pages.csv', help='Output CSV filename')
    parser.add_argument('--max-depth', type=int, default=3, help='Maximum crawl depth (default: 3)')
    parser.add_argument('--max-pages-per-church', type=int, default=1000, help='Maximum pages per church')
    parser.add_argument('--top-pages-limit', type=int, default=1000, help='Top N pages per church')
    
    args = parser.parse_args()
    
    discoverer = PageDiscoverer()
    discoverer.process_churches_csv(args.input, args.output, max_depth=args.max_depth, max_pages_per_church=args.max_pages_per_church, top_pages_limit=args.top_pages_limit)
