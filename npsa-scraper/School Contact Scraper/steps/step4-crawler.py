"""
STEP 4: COLLECT PAGE CONTENT
============================
Collect HTML/text content from the prioritized pages discovered in Step 3.

FALLBACK APPROACH (per Giorgio's recommendation):
1. TIER 1: Beautiful Soup (simple HTML) - fast, cheap (~40% of sites)
2. TIER 2: If no emails found: Selenium (click/hover to reveal hidden emails)

This step ONLY collects content - LLM parsing happens in Step 5.

Input: CSV from Step 3 with high-value staff/admin pages
Output: CSV with page URLs and their collected HTML/text content
"""

import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.action_chains import ActionChains
import re
import csv
import time
import subprocess
import gc
import os
import threading
import platform  # For OS detection
from typing import List, Dict, Set, Optional
import pandas as pd
from collections import defaultdict

from assets.shared.url_safety import UNRESOLVED, BlockedURLError, blocked_reason, get_public

# Try to import psutil for process tree killing (optional)
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# Suppress urllib3 connection pool warnings (redundant - we handle driver crashes explicitly)
import logging
urllib3_logger = logging.getLogger('urllib3.connectionpool')
urllib3_logger.setLevel(logging.ERROR)  # Only show ERROR level, suppress WARNING

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


class ContentCollector:
    def __init__(self, timeout: int = 7, max_retries: int = 3, use_selenium: bool = True, chrome_user_data_dir: Optional[str] = None):
        self.timeout = timeout  # HTTP request timeout (7 seconds)
        self.max_retries = max_retries  # 1 retry only
        self.use_selenium = use_selenium
        self.chrome_user_data_dir = chrome_user_data_dir  # Use volume path to avoid ephemeral storage exhaustion
        self.driver = None
        # URLs refused by the public-address check (incl. via a redirect), so the
        # Selenium fallback doesn't load them either
        self._blocked_urls = set()
        
        # Track if selenium was used for current school (for cleanup message)
        self._selenium_used_for_school = False
        # Track cleanup status and process counts for reporting
        self._cleanup_status = None
        self._process_counts_after_cleanup = None
        
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        if use_selenium:
            self.driver = self._setup_selenium()
        
        # Email regex pattern (to check if we should try Selenium)
        self.email_pattern = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b')
    
    def extract_emails_from_html_only(self, html: str) -> Set[str]:
        """Fast regex-only email extraction (no parsing) - for initial quick check"""
        if not html:
            return set()
        
        emails = set()
        
        # Find emails in raw HTML using regex
        emails.update(self.email_pattern.findall(html))
        
        # Quick mailto extraction using regex
        mailto_pattern = re.compile(r'mailto:([^\s\'"<>?]+)', re.IGNORECASE)
        mailto_matches = mailto_pattern.findall(html)
        emails.update(mailto_matches)
        
        # Quick data-email extraction using regex
        data_email_pattern = re.compile(r'data-email=["\']([^\s\'"<>?]+)["\']', re.IGNORECASE)
        data_email_matches = data_email_pattern.findall(html)
        emails.update(data_email_matches)
        
        # Quick data-mailto extraction using regex
        data_mailto_pattern = re.compile(r'data-mailto=["\']([^\s\'"<>?]+)["\']', re.IGNORECASE)
        data_mailto_matches = data_mailto_pattern.findall(html)
        emails.update(data_mailto_matches)
        
        return emails
    
    def extract_emails(self, html: str, soup: Optional[BeautifulSoup] = None) -> Set[str]:
        """Extract all email addresses from HTML (comprehensive, uses BeautifulSoup if provided)"""
        if not html:
            return set()
        
        # If soup is provided, use it (avoid re-parsing)
        if soup is None:
            soup = BeautifulSoup(html, 'html.parser')
        
        # Remove script and style elements
        for script in soup(["script", "style"]):
            script.decompose()
        
        # Get text
        text = soup.get_text()
        
        # Find all emails in text
        emails = set(self.email_pattern.findall(text))
        
        # Also check href attributes for mailto links
        for link in soup.find_all('a', href=True):
            if link['href'].startswith('mailto:'):
                email = link['href'].replace('mailto:', '').split('?')[0]
                emails.add(email)
        
        # Check data attributes that might contain emails
        for element in soup.find_all(attrs={'data-email': True}):
            emails.add(element.get('data-email', ''))
        
        for element in soup.find_all(attrs={'data-mailto': True}):
            emails.add(element.get('data-mailto', ''))
        
        return emails
    
    def _setup_selenium(self, retry_count: int = 0, max_retries: int = 3):
        """
        Initialize headless Chrome browser with resource limits.
        
        Args:
            retry_count: Current retry attempt (internal use)
            max_retries: Maximum number of retry attempts
        """
        
        chrome_options = Options()
        chrome_options.add_argument('--headless')
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--disable-gpu')
        chrome_options.add_argument('--window-size=1920,1080')
        chrome_options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
        
        # Resource limits to prevent crashes
        chrome_options.add_argument('--disable-extensions')
        chrome_options.add_argument('--disable-plugins')
        chrome_options.add_argument('--disable-images')  # Don't load images to save memory
        # Note: We keep JavaScript enabled because we need it for click/hover interactions
        chrome_options.add_argument('--disable-background-networking')
        chrome_options.add_argument('--disable-background-timer-throttling')
        chrome_options.add_argument('--disable-renderer-backgrounding')
        chrome_options.add_argument('--disable-backgrounding-occluded-windows')
        chrome_options.add_argument('--disable-ipc-flooding-protection')
        
        # Memory and process limits
        chrome_options.add_argument('--memory-pressure-off')
        chrome_options.add_argument('--max_old_space_size=512')  # Limit memory to 512MB per instance
        
        # Performance optimizations
        chrome_options.add_argument('--disable-features=TranslateUI')
        chrome_options.add_argument('--disable-ipc-flooding-protection')
        chrome_options.add_argument('--disable-hang-monitor')
        chrome_options.add_argument('--disable-prompt-on-repost')
        chrome_options.add_argument('--disable-sync')
        chrome_options.add_argument('--metrics-recording-only')
        chrome_options.add_argument('--no-first-run')
        chrome_options.add_argument('--safebrowsing-disable-auto-update')
        chrome_options.add_argument('--enable-automation')
        chrome_options.add_argument('--password-store=basic')
        chrome_options.add_argument('--use-mock-keychain')
        
        # Set preferences to reduce resource usage
        prefs = {
            'profile.default_content_setting_values': {
                'images': 2,  # Block images
                'plugins': 2,  # Block plugins
                'popups': 2,  # Block popups
            },
            'profile.managed_default_content_settings': {
                'images': 2
            }
        }
        chrome_options.add_experimental_option('prefs', prefs)
        
        # Redirect Chrome to volume to avoid Railway ephemeral storage file limit
        if self.chrome_user_data_dir:
            os.makedirs(self.chrome_user_data_dir, exist_ok=True)
            chrome_options.add_argument(f'--user-data-dir={self.chrome_user_data_dir}')
        
        driver = None
        try:
            # Use explicit ChromeDriver path to bypass Selenium Manager network issues
            service = Service(executable_path=os.getenv('CHROMEDRIVER_PATH', '/usr/bin/chromedriver'))
            driver = webdriver.Chrome(service=service, options=chrome_options)
            # Page load timeout handled by thread timeout (900s)
            driver.set_script_timeout(900)  # Script timeout matches unified timeout
            # Remove implicit wait, use explicit waits instead
            # driver.implicitly_wait(2)  # Removed - use explicit waits
            
            # Verify dumb-init is PID 1 (critical for proper process reaping)
            # If PID 1 is not dumb-init, Railway may have overridden ENTRYPOINT
            # This will cause zombie processes to accumulate over time
            if HAS_PSUTIL:
                try:
                    pid1 = psutil.Process(1)
                    pid1_name = pid1.name().lower()
                    # Check if PID 1 is dumb-init (or init system)
                    if 'dumb-init' not in pid1_name and 'init' not in pid1_name:
                        # This is a real issue - log it once per driver setup
                        # Don't spam logs, but make it clear this needs attention
                        import sys
                        print(f"    {bold('[SELENIUM]')} WARNING: PID 1 is '{pid1_name}', expected 'dumb-init'. Process reaping may not work correctly.", file=sys.stderr)
                        print(f"    {bold('[SELENIUM]')} This may cause zombie Chrome processes. Check Railway ENTRYPOINT configuration.", file=sys.stderr)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass  # Can't verify, but continue anyway
            
            return driver
        except Exception as e:
            if retry_count < max_retries:
                # Cleanup any leftover Chrome processes before retry (bottom-up)
                self._kill_all_chrome_processes()
                
                # 2 second grace period between retries
                print(f"    {bold('[SELENIUM]')} Failed to create Chrome driver (attempt {retry_count + 1}/{max_retries + 1}): {e}")
                print(f"    {bold('[SELENIUM]')} Retrying in 2s...")
                time.sleep(2)
                return self._setup_selenium(retry_count=retry_count + 1, max_retries=max_retries)
            else:
                # Final attempt with minimal options
                # Cleanup any leftover Chrome processes before final attempt (bottom-up)
                self._kill_all_chrome_processes()
                print(f"    {bold('[SELENIUM]')} All retries exhausted, trying minimal options...")
            try:
                minimal_options = Options()
                minimal_options.add_argument('--headless')
                minimal_options.add_argument('--no-sandbox')
                minimal_options.add_argument('--disable-dev-shm-usage')
                if self.chrome_user_data_dir:
                    minimal_options.add_argument(f'--user-data-dir={self.chrome_user_data_dir}')
                # Always use explicit ChromeDriver path to bypass Selenium Manager network lookups
                chromedriver_path = os.getenv('CHROMEDRIVER_PATH', '/usr/bin/chromedriver')
                service = Service(executable_path=chromedriver_path)
                driver = webdriver.Chrome(service=service, options=minimal_options)
                # Page load timeout handled by thread timeout (900s)
                driver.set_script_timeout(900)  # Script timeout matches unified timeout
                print(f"    {bold('[SELENIUM]')} Driver created with minimal options")
                return driver
            except Exception as e2:
                print(f"    {bold('[SELENIUM]')} ERROR: Could not create Chrome driver even with minimal options: {e2}")
                raise
    
    def _wait_for_driver_ready(self, driver, max_wait=5):
        """Wait for driver to be ready (ChromeDriver fully initialized)"""
        for attempt in range(max_wait):
            try:
                # Try to get window handles - this confirms ChromeDriver is ready
                driver.window_handles
                return True
            except:
                time.sleep(1)
        return False
    
    def _ensure_driver_healthy(self):
        """Check and restart Selenium driver if needed"""
        if not self.driver:
            # Driver doesn't exist, create it
            self.driver = self._setup_selenium()
            # Wait for driver to be fully ready before use
            if self.driver:
                if not self._wait_for_driver_ready(self.driver):
                    # Driver creation failed, try again
                    try:
                        self.driver.quit()
                    except:
                        pass
                    self._kill_all_chrome_processes()
                    time.sleep(2)
                    self.driver = self._setup_selenium()
                    if self.driver:
                        self._wait_for_driver_ready(self.driver)
            return
        
        try:
            self.driver.execute_script("return document.readyState")
        except:
            
            driver = None
            try:
                if self.driver:
                    # Kill children BEFORE quitting driver to prevent orphans
                    self._kill_all_chrome_processes()
                    time.sleep(0.5)
                    self.driver.quit()
                    time.sleep(0.5)
            except Exception as e:
                pass
            
            # Cleanup any leftover Chrome processes before restart (bottom-up)
            self._kill_all_chrome_processes()
            self._kill_orphaned_chrome_processes()
            self.driver = None
            
            # 2 second grace period before restart
            time.sleep(2)
            
            # Restart the driver
            self.driver = self._setup_selenium()
            # Wait for driver to be fully ready
            if self.driver:
                self._wait_for_driver_ready(self.driver)
    
    def cleanup(self):
        """Basic cleanup: quit Selenium driver and kill all Chrome processes (bottom-up)"""
        # Monitor processes before cleanup
        before_zombies, before_orphaned, before_active = self._get_process_counts()
        print(f"    {bold('[CLEANUP]')} BEFORE: Chrome processes - Active: {before_active}, Zombies: {before_zombies}, Orphaned: {before_orphaned}")
        
        # Cleanup Chrome processes first (bottom-up) before quitting driver
        self._kill_all_chrome_processes()
        time.sleep(0.5)  # Wait for children to die
        
        driver = None
        try:
            if self.driver:
                driver = self.driver
                self.driver = None
                driver.quit()
                # Wait for driver.quit() to complete and children to die
                time.sleep(1.0)
                
                # Final cleanup pass to catch any stragglers
                self._kill_all_chrome_processes()
                self._kill_orphaned_chrome_processes()
        except Exception as e:
            # Even if quit() fails, try to kill processes
            self._kill_all_chrome_processes()
            self._kill_orphaned_chrome_processes()
        finally:
            self.driver = None
            
            # Monitor processes after cleanup
            after_zombies, after_orphaned, after_active = self._get_process_counts()
            print(f"    {bold('[CLEANUP]')} AFTER: Chrome processes - Active: {after_active}, Zombies: {after_zombies}, Orphaned: {after_orphaned}")
    
    def _get_process_counts(self):
        """Get current Chrome process counts: (zombies, orphaned_zombies, active)"""
        if not HAS_PSUTIL:
            return (0, 0, 0)
        
        zombies = 0
        orphaned_zombies = 0
        active = 0
        
        try:
            current_pid = os.getpid()
            for proc in psutil.process_iter(['name', 'pid', 'ppid', 'status']):
                try:
                    name = proc.info.get('name', '').lower()
                    status = proc.info.get('status', '').lower()
                    ppid = proc.info.get('ppid', -1)
                    
                    if ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                        if status == 'zombie':
                            if ppid == 1:
                                orphaned_zombies += 1
                            else:
                                zombies += 1
                        else:
                            active += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, KeyError):
                    continue
        except:
            pass
        
        return (zombies, orphaned_zombies, active)
    
    def __del__(self):
        """Destructor - safety net to ensure driver is cleaned up"""
        self.cleanup()
    
    def _kill_all_chrome_processes(self):
        """
        PROCESS-SCOPED cleanup of Chrome/Chromium/ChromeDriver processes.
        Kills processes BOTTOM-UP (children first, then parents) to prevent zombies.
        Only targets processes in the current worker's process tree (not system-wide).
        Protects main container processes (waitress-serve, main Python process, PID 1).
        
        This prevents killing Chrome processes from other concurrent workers/states.
        
        Returns:
            int: Number of processes killed
        """
        if not HAS_PSUTIL:
            return 0
        
        # Monitor processes before cleanup
        before_zombies, before_orphaned, before_active = self._get_process_counts()
        print(f"      {bold('[CLEANUP]')} BEFORE kill_all: Active: {before_active}, Zombies: {before_zombies}, Orphaned: {before_orphaned}")
        
        killed_count = 0  # Initialize early to ensure it's always defined
        
        try:
            current_pid = os.getpid()
            current_process = psutil.Process(current_pid)
            
            # Identify main container processes to protect
            # These should never be killed, even if they match patterns
            protected_names = {'waitress-serve', 'dumb-init', 'python', 'python3', 'waitress'}
            protected_pids = {1}  # Always protect PID 1 (init process)
            
            # Get main container PID (parent or grandparent process)
            try:
                parent = current_process.parent()
                if parent:
                    protected_pids.add(parent.pid)
                    # Also protect parent's parent (grandparent, likely waitress)
                    try:
                        grandparent = parent.parent()
                        if grandparent:
                            protected_pids.add(grandparent.pid)
                            # Also protect great-grandparent
                            try:
                                great_grandparent = grandparent.parent()
                                if great_grandparent:
                                    protected_pids.add(great_grandparent.pid)
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            
            # Collect Chrome processes in worker's process tree ONLY (not system-wide)
            chrome_processes = []
            chrome_process_map = {}  # pid -> Process object
            
            try:
                for child in current_process.children(recursive=True):
                    try:
                        # child.name() returns the process name directly (no .info attribute)
                        name = child.name().lower()
                        # Check if it's a Chrome process
                        if ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                            # Skip protected processes
                            if child.pid not in protected_pids:
                                if name not in protected_names:
                                    chrome_processes.append(child)
                                    chrome_process_map[child.pid] = child
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
                        continue
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            
            if not chrome_processes:
                return 0
            
            # Build process tree to determine depth (children first, parents last)
            # Depth = distance from current process (deeper = more descendants)
            depth_map = {}
            
            def get_depth(proc):
                """Calculate depth based on distance from current process"""
                if proc.pid in depth_map:
                    return depth_map[proc.pid]
                try:
                    if proc.pid == current_pid:
                        depth = 0
                    else:
                        parent = proc.parent()
                        if parent:
                            parent_depth = get_depth(parent)
                            depth = parent_depth + 1
                        else:
                            depth = 999  # Unknown parent, kill last
                    depth_map[proc.pid] = depth
                    return depth
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    depth_map[proc.pid] = 999
                    return 999
            
            # Calculate depths for all Chrome processes
            for proc in chrome_processes:
                if proc.pid not in depth_map:
                    get_depth(proc)
            
            # Sort by depth DESCENDING (deepest = children first, shallowest = parents last)
            # This ensures BOTTOM-UP killing (children before parents)
            chrome_processes.sort(key=lambda p: depth_map.get(p.pid, 999), reverse=True)
            
            # Kill processes BOTTOM-UP (deepest children first)
            for proc in chrome_processes:
                try:
                    if proc.is_running():
                        # Try graceful termination first
                        proc.terminate()
                        killed_count += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    continue
            
            # Wait for processes to die
            if killed_count > 0:
                time.sleep(0.5)
                
                # Force kill any remaining processes (still in reverse order)
                for proc in chrome_processes:
                    try:
                        if proc.is_running():
                            proc.kill()  # Force kill if still running
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue
            
            # Reap zombie Chrome processes to prevent accumulation
            # Zombies can't be killed - they must be reaped by their parent
            reaped_count = 0
            try:
                # Find zombie Chrome processes that are direct children of our process
                zombie_processes = []
                for child in current_process.children(recursive=False):  # Only direct children
                    try:
                        name = child.name().lower()
                        status = child.status()
                        if status == psutil.STATUS_ZOMBIE and ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                            zombie_processes.append(child.pid)
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
                        continue
                
                # Reap zombie processes using os.waitpid()
                # WNOHANG flag means don't block - just reap if available
                for pid in zombie_processes:
                    try:
                        # Reap the zombie (non-blocking)
                        # os.waitpid() can only reap our own direct children
                        result = os.waitpid(pid, os.WNOHANG)
                        if result[0] == pid:
                            reaped_count += 1
                    except (ChildProcessError, ProcessLookupError, OSError):
                        # Process already reaped, not our child, or other error - ignore
                        pass
                
            except Exception as e:
                # Don't fail cleanup if zombie reaping fails
                pass
            
        except Exception as e:
            pass
        
        # Monitor processes after cleanup
        after_zombies, after_orphaned, after_active = self._get_process_counts()
        print(f"      {bold('[CLEANUP]')} AFTER kill_all: Active: {after_active}, Zombies: {after_zombies}, Orphaned: {after_orphaned}, Killed: {killed_count}")
        
        return killed_count
    
    def _kill_orphaned_chrome_processes(self):
        """
        Alias for _kill_all_chrome_processes() - now does process-scoped cleanup.
        Kept for backward compatibility with existing code that calls this function.
        
        Returns:
            int: Number of processes killed
        """
        return self._kill_all_chrome_processes()
    
    def _snapshot_chrome_processes(self, label: str = "SNAPSHOT"):
        """
        Create a comprehensive snapshot of all Chrome processes for diagnostics.
        Returns a dict with counts and details for analysis.
        
        Args:
            label: Label for this snapshot (e.g., "BEFORE_CLEANUP")
            
        Returns:
            dict: Snapshot data with counts and process details
        """
        if not HAS_PSUTIL:
            return {'active': 0, 'zombies': 0, 'orphaned_zombies': 0, 'total': 0, 'processes': []}
        
        current_pid = os.getpid()
        processes = []
        active_count = 0
        zombie_count = 0
        orphaned_zombie_count = 0
        
        try:
            for proc in psutil.process_iter(['name', 'pid', 'ppid', 'status', 'cmdline', 'create_time']):
                try:
                    name = proc.info.get('name', '')
                    name_lower = name.lower()
                    pid = proc.info['pid']
                    ppid = proc.info.get('ppid', -1)
                    status = proc.info.get('status', 'unknown').lower()
                    create_time = proc.info.get('create_time', 0)
                    
                    # Check if it's a Chrome-related process
                    if ('chrome' in name_lower or 'chromium' in name_lower or 'chromedriver' in name_lower):
                        cmdline = proc.info.get('cmdline', [])
                        if cmdline is None:
                            cmdline = []
                        cmdline_str = ' '.join(cmdline[:3]) if cmdline else ''
                        if len(cmdline) > 3:
                            cmdline_str += '...'
                        
                        age_seconds = time.time() - create_time if create_time > 0 else 0
                        
                        process_info = {
                            'name': name,
                            'pid': pid,
                            'ppid': ppid,
                            'status': status,
                            'cmdline': cmdline_str,
                            'age_seconds': age_seconds,
                            'is_zombie': status == 'zombie',
                            'is_orphaned': status == 'zombie' and ppid == 1,
                            'is_direct_child': ppid == current_pid
                        }
                        
                        processes.append(process_info)
                        
                        # Count by status
                        if status == 'zombie':
                            zombie_count += 1
                            if ppid == 1:
                                orphaned_zombie_count += 1
                        else:
                            active_count += 1
                            
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, KeyError):
                    continue
            
            # Sort by PID for consistent output
            processes.sort(key=lambda p: p['pid'])
            
            snapshot = {
                'label': label,
                'timestamp': time.time(),
                'current_pid': current_pid,
                'active': active_count,
                'zombies': zombie_count,
                'orphaned_zombies': orphaned_zombie_count,
                'total': len(processes),
                'processes': processes
            }
            
            return snapshot
            
        except Exception as e:
            return {'active': 0, 'zombies': 0, 'orphaned_zombies': 0, 'total': 0, 'processes': [], 'error': str(e)}
    
    def _list_all_chrome_processes(self):
        """
        List ALL Chrome/Chromium/ChromeDriver processes with exact names, PIDs, and PPIDs.
        Used for monitoring to ensure no process accumulation.
        
        Returns:
            int: Number of Chrome processes found
        """
        if not HAS_PSUTIL:
            return 0
        
        # Use snapshot function for consistency
        snapshot = self._snapshot_chrome_processes("PROCESS_LIST")
        return snapshot.get('total', 0)
    
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

                self._blocked_urls.add(url)
                log_warn(f"Crawler: skipped {e.url} ({e.reason})")
                return None
            except requests.exceptions.Timeout:
                # Silent retry - don't print errors
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return None  # Return None instead of raising
            except requests.exceptions.RequestException as e:
                # Silent retry - don't print errors
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return None  # Return None instead of raising
        return None
    
    def _get_url_with_timeout(self, driver, url: str, timeout: int = 900) -> bool:
        """
        Wrapper for driver.get() with a hard timeout (default 900 seconds).
        If the page load exceeds the timeout, forcefully quits the driver.
        
        Returns:
            True if page loaded successfully, False if timeout occurred or connection error
        """
        result = [None]  # Use list to allow modification from nested function
        exception = [None]
        
        # Check driver readiness right before use (catches race conditions)
        try:
            driver.window_handles
        except:
            # Driver not ready - return False so caller can retry
            return False
        
        def get_url():
            try:
                # Small delay before Selenium navigation to avoid overwhelming servers
                time.sleep(0.2)  # 200ms delay before driver.get()
                driver.get(url)
                result[0] = True
            except Exception as e:
                exception[0] = e
                result[0] = False
        
        # Start driver.get() in a separate thread
        thread = threading.Thread(target=get_url, daemon=True)
        thread.start()
        thread.join(timeout=timeout)
        
        # Check if thread is still alive (timed out)
        if thread.is_alive():
            # Timeout occurred - kill children FIRST (bottom-up) before quitting driver
            print(f"      [TIMEOUT] Page load exceeded {timeout}s, forcefully terminating...")
            try:
                # CRITICAL: Kill children BEFORE parent to prevent orphans
                # Step 1: Kill all Chrome processes in worker's tree (bottom-up)
                self._kill_all_chrome_processes()
                time.sleep(1.0)  # Wait longer for children to die
                
                # Step 2: Kill orphaned processes (PPID=1) that may have been created
                self._kill_orphaned_chrome_processes()
                time.sleep(0.5)
                
                # Step 3: Try to quit driver gracefully first
                try:
                    driver.quit()
                except:
                    pass  # Driver may already be dead
                
                time.sleep(0.5)  # Wait after quit
                
                # Step 4: Final cleanup - kill any remaining Chrome processes
                self._kill_all_chrome_processes()
                self._kill_orphaned_chrome_processes()
            except Exception as e:
                pass
            # Mark driver as dead so it gets recreated
            self.driver = None
            return False
        
        # Check if an exception occurred
        if exception[0]:
            error_str = str(exception[0]).lower()
            # Check if it's a connection error (driver not ready) - don't raise, return False for retry
            if 'connection refused' in error_str or 'errno 111' in error_str:
                return False
            # For other errors, raise them
            raise exception[0]
        
        return result[0] if result[0] is not None else False
    
    def fetch_with_selenium(self, url: str, interact: bool = True) -> Optional[str]:
        """
        Fetch page using Selenium and interact with it to reveal emails
        
        Clicks on profile photos, staff cards, and hovers over elements
        to reveal hidden emails (mailto links that appear on interaction)
        """
        if url in self._blocked_urls:
            return None
        reason = blocked_reason(url)
        if reason:
            self._blocked_urls.add(url)
            if reason != UNRESOLVED:
                from school_run_log import log_warn

                log_warn(f"Crawler: skipped {url} in browser ({reason})")
            return None

        driver = None
        max_retries = 2
        try:
            for attempt in range(max_retries):
                try:
                    self._ensure_driver_healthy()
                    driver = self.driver
                    
                    if not driver:
                        if attempt < max_retries - 1:
                            time.sleep(2)  # 2 second grace period before retry
                            continue
                        return None
                    
                    # Use timeout wrapper for driver.get() - 45 second hard limit
                    if not self._get_url_with_timeout(driver, url, timeout=900):
                        # Driver failed (timeout or connection error) - need to recreate it
                        self.driver = None
                        if attempt < max_retries - 1:
                            time.sleep(2)  # 2 second grace period before retry
                            continue
                        return None
                    
                    # Wait for page to load using explicit wait (with shorter timeout since page should be loaded)
                    try:
                        wait = WebDriverWait(driver, 5)
                        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
                    except TimeoutException:
                        # Page might be loaded but body not ready - continue anyway
                        pass
                    time.sleep(2)  # Wait for any dynamic content
                    
                    if interact:
                        # Look for clickable elements that might reveal emails
                        # Common patterns: profile photos, staff cards, staff member containers
                        clickable_selectors = [
                            "img[alt*='staff']", "img[alt*='team']", "img[alt*='faculty']",
                            "[class*='staff']", "[class*='team']", "[class*='faculty']",
                            "[class*='member']", "[class*='profile']", "[class*='card']",
                            "a[href*='staff']", "a[href*='team']", "a[href*='faculty']",
                            "[data-email]", "[data-mailto]", "[class*='email']"
                        ]
                        
                        for selector in clickable_selectors:
                            try:
                                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                                # Increased to 75 clicks per selector type to handle large staff directories
                                for element in elements[:75]:
                                    try:
                                        # Scroll element into view
                                        driver.execute_script("arguments[0].scrollIntoView(true);", element)
                                        time.sleep(0.5)
                                        
                                        # Try clicking
                                        element.click()
                                        time.sleep(0.5)
                                        
                                        # Try hovering
                                        ActionChains(driver).move_to_element(element).perform()
                                        time.sleep(0.3)
                                    except:
                                        continue
                            except:
                                continue
                        
                        # Additional wait for any JavaScript-revealed emails
                        time.sleep(2)
                    
                    # Success - break out of retry loop
                    return driver.page_source
                    
                except Exception as e:
                    error_str = str(e).lower()
                    # Check if it's a connection refused error (driver not ready)
                    if 'connection refused' in error_str or 'errno 111' in error_str:
                        if attempt < max_retries - 1:
                            print(f"    {bold('[SELENIUM]')} Driver not ready, retrying in 2s...")
                            self.driver = None
                            time.sleep(2)  # 2 second grace period before retry
                            continue
                        else:
                            return None
                    else:
                        # Other error - don't retry
                        return None
            
            return None
            
        except Exception as e:
            print(f"      Selenium error: {e}")
            return None
        finally:
            # Get process counts before cleanup
            before_zombies, before_orphaned, before_active = self._get_process_counts()
            
            # After each Selenium use, kill orphaned Chrome processes (PPID=1) to prevent accumulation
            self._kill_orphaned_chrome_processes()
            
            # Get process counts after cleanup
            after_zombies, after_orphaned, after_active = self._get_process_counts()
            
            # Determine cleanup status
            total_before = before_zombies + before_orphaned + before_active
            total_after = after_zombies + after_orphaned + after_active
            
            if total_after == 0:
                self._cleanup_status = "successful"
            elif total_after < total_before:
                self._cleanup_status = "successful"  # Some processes removed
            else:
                self._cleanup_status = "unsuccessful"  # No improvement or worse
            
            # Store process counts for reporting
            self._process_counts_after_cleanup = (after_zombies, after_orphaned, after_active)
            
            # Mark that selenium was used for this school
            self._selenium_used_for_school = True
    
    def collect_page_content(self, school_name: str, url: str) -> Optional[Dict]:
        """
        Collect HTML content from a page using OPTIMIZED approach:
        
        1. Check page titles (H2, H3, H4) FIRST to determine if page is relevant
        2. Extract emails using regex (fast, no LLM needed)
        3. Only process full HTML if page passes initial checks
        4. Hard timeout at 900 seconds - forces cleanup regardless of state
        
        Returns:
            Dictionary with school_name, url, html_content, fetch_method, email_count
            Returns None if page fetch failed or timed out
        """
        import time
        import threading
        
        # TIMEOUT: 900 seconds hard limit - always triggers cleanup
        TIMEOUT = 900
        page_start_time = time.time()
        result_container = [None]  # Use list to allow modification from nested function
        exception_container = [None]
        
        def _collect_with_timeout():
            """Inner function that does the actual collection"""
            try:
                result_container[0] = self._collect_page_content_inner(school_name, url, page_start_time)
            except Exception as e:
                exception_container[0] = e
        
        # Start collection in a separate thread
        collection_thread = threading.Thread(target=_collect_with_timeout, daemon=True)
        collection_thread.start()
        collection_thread.join(timeout=TIMEOUT)
        
        # Check if thread is still alive (timed out)
        if collection_thread.is_alive():
            # TIMEOUT: Kill everything and cleanup
            print(f"    [TIMEOUT] Page processing exceeded {TIMEOUT}s hard limit, forcefully terminating...")
            try:
                # List processes before cleanup
                
                # CRITICAL: Kill children BEFORE parent to prevent orphans
                # Step 1: Kill all Chrome processes in worker's tree (bottom-up)
                self._kill_all_chrome_processes()
                time.sleep(1.0)  # Wait longer for children to die
                
                # Step 2: Kill orphaned processes (PPID=1) that may have been created
                self._kill_orphaned_chrome_processes()
                time.sleep(0.5)
                
                # Step 3: Try to quit driver gracefully first
                if self.driver:
                    try:
                        self.driver.quit()
                    except:
                        pass  # Driver may already be dead
                    self.driver = None
                
                time.sleep(0.5)  # Wait after quit
                
                # Step 4: Final cleanup - kill any remaining Chrome processes
                self._kill_all_chrome_processes()
                self._kill_orphaned_chrome_processes()
                
                # List processes after cleanup to verify
                remaining = self._list_all_chrome_processes()
                if remaining > 0:
                    print(f"    {bold('[TIMEOUT]')} WARNING: {remaining} Chrome processes still active after cleanup!")
            except Exception as e:
                print(f"    [TIMEOUT] Error during cleanup: {e}")
            
            # Add 3-second buffer after cleanup to prevent connection refused warnings
            time.sleep(3.0)
            
            return None
        
        # Check if an exception occurred
        if exception_container[0]:
            raise exception_container[0]
        
        return result_container[0]
    
    def _collect_page_content_inner(self, school_name: str, url: str, page_start_time: float) -> Optional[Dict]:
        """
        Inner method that does the actual page content collection.
        Called by collect_page_content() which wraps it with a forced timeout.
        """
        try:
            html = None
            fetch_method = 'unknown'
            
            # TIER 1: Try Beautiful Soup first (simple HTML scraping)
            response = self.safe_get(url)
            if not response:
                # If requests failed, try Selenium directly (if enabled)
                if self.use_selenium:
                    print(f"    WARNING: Requests failed, trying Selenium...")
                    html_selenium = self.fetch_with_selenium(url, interact=True)
                    if html_selenium:
                        html = html_selenium
                        fetch_method = 'selenium'
                else:
                    print(f"    ERROR: Failed to fetch page content")
                    return None
            else:
                html = response.text
                fetch_method = 'requests'
            
            # Timeout is handled by thread timeout (900s) - no need to check here
            
            # OPTIMIZATION: Fast regex email extraction FIRST (no parsing)
            emails_fast = self.extract_emails_from_html_only(html)
            
            # OPTIMIZATION: Parse HTML ONCE and reuse soup object
            soup = BeautifulSoup(html, 'html.parser')
            
            # Check titles (H1, H2, H3, H4, title) for relevance
            title_tags = soup.find_all(['h1', 'h2', 'h3', 'h4', 'title'])
            title_text = ' '.join([tag.get_text(strip=True) for tag in title_tags]).lower()
            
            # High-value keywords that indicate staff/admin pages
            high_value_keywords = [
                'principal', 'superintendent', 'head of school', 'director',
                'administrator', 'dean', 'leadership', 'administration', 'staff', 'faculty'
            ]
            has_high_value_titles = any(keyword in title_text for keyword in high_value_keywords)
            
            # OPTIMIZATION: Use comprehensive email extraction with existing soup object
            emails = self.extract_emails(html, soup=soup)
            
            # Check if page is worth processing
            # Skip if no emails AND no high-value titles (likely not a staff page)
            if not emails and not has_high_value_titles:
                # Check for name patterns in titles as last resort
                name_pattern = re.search(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', title_text)
                if not name_pattern:
                    print(f"    [SKIP] Page doesn't appear relevant (no emails, no admin titles) - skipping")
                    return None
            
            # Timeout is handled by thread timeout (900s) - no need to check here
            
            # Cache full text (expensive operation, only do once)
            full_text = soup.get_text()
            text_lower = full_text.lower()
            has_high_value_titles_full = any(keyword in text_lower for keyword in high_value_keywords)
            name_pattern = re.search(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', full_text)
            has_name_pattern = bool(name_pattern)
            
            # OPTIMIZED Selenium logic: Skip if emails AND high-value titles found
            # Use Selenium only if:
            # 1. No emails found, OR
            # 2. Has high-value titles/names BUT no emails (might be hidden)
            # Skip Selenium if: emails found AND high-value titles found (already have what we need)
            should_use_selenium = False
            if not emails or len(emails) == 0:
                # No emails found - try Selenium
                should_use_selenium = True
            elif has_high_value_titles_full and has_name_pattern and not emails:
                # Has high-value content but no emails - might be hidden, try Selenium
                should_use_selenium = True
            # If emails found AND high-value titles found, skip Selenium (already have what we need)
            
            if should_use_selenium:
                # Timeout is handled by thread timeout (900s) - proceed with Selenium if needed
                if self.use_selenium:
                    if not emails or len(emails) == 0:
                        print(f"    No emails in HTML, trying Selenium (click/hover reveals)...")
                    else:
                        print(f"    Found {len(emails)} emails + high-value titles detected, using Selenium for comprehensive extraction...")
                    
                    # TIER 2: Use Selenium for better extraction
                    html_selenium = self.fetch_with_selenium(url, interact=True)
                    if html_selenium:
                        html = html_selenium
                        fetch_method = 'selenium'
                        
                        # Re-check emails after Selenium
                        emails_after = self.extract_emails(html)
                        if emails_after:
                            was_count = len(emails) if emails else 0
                            print(f"      Emails found: {len(emails_after)} (method=\"selenium\", was={was_count})")
                            emails = emails_after
            else:
                print(f"      Emails found: {len(emails)} (method=\"simple_html\")")
            
            # Timeout is handled by thread timeout (900s) - no need to check here
            
            # Count emails found
            email_count = len(emails) if emails else 0
            
            # Show cleanup message after school processing if selenium was used
            if self._selenium_used_for_school:
                # Print cleanup status
                status = self._cleanup_status if self._cleanup_status else "unknown"
                print(f"    [CLEANUP] Process cleanup {status}")
                
                # Print active processes list only if there are any
                if self._process_counts_after_cleanup:
                    zombies, orphaned, active = self._process_counts_after_cleanup
                    if zombies > 0 or orphaned > 0 or active > 0:
                        process_list = []
                        if zombies > 0:
                            process_list.append(f"Z {zombies}")
                        if orphaned > 0:
                            process_list.append(f"O {orphaned}")
                        if active > 0:
                            process_list.append(f"C {active}")
                        if process_list:
                            print(f"    [CLEANUP] Active processes: {' | '.join(process_list)}")
                
                # Reset for next school
                self._selenium_used_for_school = False
                self._cleanup_status = None
                self._process_counts_after_cleanup = None
            
            return {
                'school_name': school_name,
                'url': url,
                'html_content': html,
                'fetch_method': fetch_method,
                'email_count': email_count,
                'has_emails': email_count > 0
            }
        
        except Exception as e:
            elapsed = time.time() - page_start_time
            print(f"      Error collecting content from {url}: {e} [{elapsed:.1f}s]")
            return None
    
    def collect_content_from_pages(self, input_csv: str, output_csv: str):
        """
        Collect HTML content from all pages in the input CSV
        
        Process:
        1. Read all pages from Step 3
        2. For each page: Use fallback approach (Beautiful Soup → Selenium)
        3. Save page content (HTML) to CSV for LLM parsing in Step 5
        
        Uses FALLBACK approach per Giorgio's recommendation:
        - TIER 1: Try Beautiful Soup first (fast, cheap) - handles ~40% of sites
        - TIER 2: If no emails: Try Selenium (click/hover to reveal)
        
        This step ONLY collects content - LLM parsing happens in Step 5.
        
        Args:
            input_csv: CSV from Step 3 with discovered pages
            output_csv: Output CSV with collected page content
        """
        # Read discovered pages
        df = pd.read_csv(input_csv)
        print(f"{bold('[STEP 4]')} Processing {len(df)} pages from {df['school_name'].nunique()} schools")
        
        all_content = []
        
        for idx, row in df.iterrows():
            school_name = row['school_name']
            url = row['url']
            
            # Collect content from this page
            content = self.collect_page_content(school_name, url)
            
            if content:
                all_content.append(content)
                if (idx + 1) % 10 == 0:
                    print(f"{bold('[STEP 4]')} Progress: {idx+1}/{len(df)} pages, {len(all_content)} collected, {sum(c.get('email_count', 0) for c in all_content)} emails")
            else:
                if (idx + 1) % 10 == 0:
                    print(f"{bold('[STEP 4]')} Progress: {idx+1}/{len(df)} pages, {len(all_content)} collected")
            
            # Save progress every 10 pages
            if (idx + 1) % 10 == 0:
                self._save_content(all_content, output_csv)
            
            time.sleep(0.5)  # Polite delay
        
        # Final save
        self._save_content(all_content, output_csv)
        
        # Print final summary
        self._print_summary_content(all_content, output_csv, df)
    
    def _save_content(self, content_list: List[Dict], filename: str):
        """Save page content to CSV"""
        if not content_list:
            return
        
        df = pd.DataFrame(content_list)
        
        # Ensure all required columns exist
        required_cols = ['school_name', 'url', 'html_content', 'fetch_method', 'email_count', 'has_emails']
        for col in required_cols:
            if col not in df.columns:
                df[col] = ''
        
        # Reorder columns
        df = df[required_cols]
        
        df.to_csv(filename, index=False)
    
    def _print_summary_content(self, content_list: List[Dict], output_file: str, pages_df):
        """Print final summary"""
        if not content_list:
            print("\nERROR: No content collected")
            return
        
        df = pd.DataFrame(content_list)
        
        schools_processed = pages_df['school_name'].nunique()
        schools_with_content = df['school_name'].nunique()
        total_emails = df['email_count'].sum()
        pages_with_emails = df[df['has_emails'] == True]
        
        print(f"{bold('[STEP 4]')} Complete: {len(df)}/{len(pages_df)} pages collected, {schools_with_content}/{schools_processed} schools, {total_emails} emails")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Collect HTML content from Step 3 pages')
    parser.add_argument('--input', required=True, help='Input CSV from Step 3')
    parser.add_argument('--output', default='step4_content.csv', help='Output CSV filename')
    parser.add_argument('--no-selenium', action='store_true', help='Disable Selenium (use requests only)')
    
    args = parser.parse_args()
    
    collector = ContentCollector(use_selenium=not args.no_selenium)
    
    try:
        collector.collect_content_from_pages(args.input, args.output)
    finally:
        # Cleanup Selenium driver with nuclear option
        driver = None
        try:
            if collector.driver:
                driver = collector.driver
                collector.driver = None
                driver.quit()
        except:
            pass  # Don't let cleanup fail
