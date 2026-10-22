"""
STEP 2: FILTER CHURCHES - STREAMING VERSION
===========================================
Filter single church object - remove schools, camps, non-Christian places, out-of-state results.

Input: Church object from Step 1
Output: Filtered Church object or None (if filtered out)
"""

import re
from typing import Optional, List, Dict, Tuple
from assets.shared.models import Church

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


# Required church/Christian keywords (church MUST have at least one)
CHURCH_KEYWORDS = [
    'church', 'chapel', 'parish', 'congregation', 'ministry', 'fellowship',
    'worship', 'catholic', 'christian', 'baptist', 'methodist', 'lutheran',
    'presbyterian', 'episcopal', 'pentecostal', 'assembly of god',
    'church of god', 'nondenominational', 'non-denominational',
    'christ-centered', 'christ centered', 'faith-based', 'faith based',
    'covenant', 'community church', 'bible church'
]

# Exclusion keywords - places we don't want (schools, camps, secular)
EXCLUDE_KEYWORDS = [
    'school', 'academy', 'college', 'university', 'seminary', 'bible institute',
    'theological seminary', 'divinity school', 'bible college',
    'camp', 'retreat center', 'conference center',
    'museum', 'library', 'hospital', 'clinic',
    'bookstore', 'coffee shop', 'cafe', 'restaurant'
]

# School-specific keywords (exclude if present - we want churches, not schools)
SCHOOL_KEYWORDS = [
    'school', 'academy', 'elementary', 'high school', 'middle school',
    'prep', 'preparatory', 'education', 'isd', 'school district'
]

# Non-Christian religious keywords
NON_CHRISTIAN_RELIGIOUS = [
    'islamic', 'muslim', 'mosque', 'jewish', 'judaism', 'synagogue',
    'hindu', 'buddhist', 'sikh', 'bahai', 'mormon', 'lds'
]

# State name to abbreviation mapping
STATE_ABBREVIATIONS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new_hampshire': 'NH', 'new_jersey': 'NJ', 'new_mexico': 'NM', 'new_york': 'NY',
    'north_carolina': 'NC', 'north_dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode_island': 'RI', 'south_carolina': 'SC',
    'south_dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west_virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY'
}


def get_state_info(state_name: str) -> tuple:
    """Get state abbreviation and normalized name from state name."""
    normalized = state_name.lower().replace(' ', '_')
    base_state = normalized.split('_')[0] if '_' in normalized else normalized
    
    abbrev = STATE_ABBREVIATIONS.get(base_state, '')
    if not abbrev:
        abbrev = STATE_ABBREVIATIONS.get(normalized, '')
    
    if base_state in STATE_ABBREVIATIONS:
        normalized = base_state
    
    full_name = normalized.replace('_', ' ').title()
    return abbrev, normalized, full_name


def is_state_church(church: Church, target_state: str) -> bool:
    """Check if church is in the target state."""
    state_abbrev, normalized_state, full_state_name = get_state_info(target_state)
    
    detected_state = (church.detected_state or '').strip().lower()
    state_field = (church.state or '').strip().lower()
    address_field = (church.address or '').upper()
    
    if state_field:
        if state_field == normalized_state or state_field == full_state_name.lower():
            return True
        
        state_normalized = state_field.replace(' ', '').replace('_', '').replace('-', '').strip()
        target_normalized = normalized_state.replace(' ', '').replace('_', '').replace('-', '').strip()
        full_normalized = full_state_name.lower().replace(' ', '').replace('_', '').replace('-', '').strip()
        
        if state_normalized == target_normalized or state_normalized == full_normalized:
            return True
        
        if normalized_state in state_field or full_state_name.lower() in state_field:
            return True
    
    if detected_state:
        if detected_state == state_abbrev.lower() or detected_state == normalized_state or detected_state == full_state_name.lower():
            return True
    
    if state_abbrev and f', {state_abbrev} ' in address_field:
        return True
    if state_abbrev and address_field.endswith(f', {state_abbrev}'):
        return True
    
    if f' {full_state_name.upper()}' in address_field:
        return True
    
    if normalized_state and f' {normalized_state.upper()}' in address_field:
        return True
    
    if state_abbrev:
        match = re.search(r',\s*([A-Z]{2})\s+\d{5}', address_field)
        if match and match.group(1) == state_abbrev:
            return True
    
    if state_field:
        target_normalized = normalized_state.lower()
        state_normalized = state_field.replace(' ', '_').lower()
        if state_normalized == target_normalized:
            return True
    
    return False


def passes_pre_filters(church: Church) -> bool:
    """
    Fast pre-filtering - removes obvious non-church places.
    """
    if not church.name:
        return False
    
    name_lower = (church.name or '').lower()
    
    # Remove schools (we want churches, not schools)
    if any(kw in name_lower for kw in SCHOOL_KEYWORDS):
        return False
    
    # Remove colleges/universities/seminaries
    if any(kw in name_lower for kw in ['college', 'university', 'seminary', 'bible institute', 'bible college', 'divinity school']):
        return False
    
    # Remove non-Christian religious
    if any(kw in name_lower for kw in NON_CHRISTIAN_RELIGIOUS):
        return False
    
    # Must have at least one church keyword
    has_church_keyword = any(kw in name_lower for kw in CHURCH_KEYWORDS)
    if not has_church_keyword:
        return False
    
    return True


class LLMChurchFilter:
    """
    Filter churches using Claude to determine if they're Christian/Catholic churches.
    """
    
    def __init__(self, api_key: str, target_state: str = 'texas', model: str = "claude-haiku-5-5", batch_size: int = 20):
        if not ANTHROPIC_AVAILABLE:
            raise ImportError("Anthropic library not available. Install with: pip install anthropic")
        
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.batch_size = batch_size
        self.target_state = target_state
        _, _, self.full_state_name = get_state_info(target_state)
        self.pending_churches: List[Church] = []
        self.cache: Dict[str, bool] = {}
    
    def is_christian_church(self, church: Church) -> bool:
        """Check if a place is a Christian/Catholic church using LLM."""
        if not church.name:
            return False
        
        church_name_lower = church.name.lower().strip()
        if church_name_lower in self.cache:
            return self.cache[church_name_lower]
        
        self.pending_churches.append(church)
        
        if len(self.pending_churches) >= self.batch_size:
            self._process_batch()
        else:
            self._process_batch()
        
        return self.cache.get(church_name_lower, False)
    
    def flush(self):
        """Process any remaining churches in the batch."""
        if self.pending_churches:
            self._process_batch()
    
    def _process_batch(self):
        """Process current batch of churches through Claude."""
        if not self.pending_churches:
            return
        
        batch = self.pending_churches[:]
        self.pending_churches = []
        
        try:
            prompt = self._build_prompt(batch)
            # Thinking off: short classification, and the 200-token cap must hold the answer.
            # (Claude Haiku 5.5 rejects non-default temperature, so none is sent.)
            response = self.client.messages.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                thinking={"type": "disabled"},
                max_tokens=200
            )
            
            response_text = "".join(
                getattr(block, "text", "") for block in response.content
                if getattr(block, "type", None) == "text"
            )
            results = self._parse_responses(response_text, batch)
            
            for church, is_valid in zip(batch, results):
                self.cache[church.name.lower().strip()] = is_valid
        
        except Exception as e:
            from church_run_log import log_err
            log_err(f"LLM church filter: {e}")
            for church in batch:
                self.cache[church.name.lower().strip()] = False
    
    def _build_prompt(self, churches: List[Church]) -> str:
        """Build prompt for batch of churches."""
        church_list = "\n".join([f"{i+1}. {church.name}" for i, church in enumerate(churches)])
        
        prompt = f"""You are filtering places for a Christian/Catholic church lead database in {self.full_state_name}.

For each place name below, determine if it is a Christian or Catholic church (or similar worship congregation).

INCLUDE (YES):
- Churches (any Christian denomination: Catholic, Baptist, Methodist, Lutheran, Episcopal, Presbyterian, etc.)
- Chapels, parishes, congregations
- Non-denominational Christian churches
- Worship centers, fellowship churches
- Any place of Christian worship

EXCLUDE (NO):
- Schools, academies, colleges, universities
- Seminaries, bible institutes, divinity schools (educational institutions)
- Camps, retreat centers
- Non-Christian religious places (mosques, synagogues, temples)
- Museums, libraries, bookstores
- Generic or secular organizations

When in doubt → SAY YES. Better to include and verify later.

Place names:
{church_list}

For each place, respond with ONLY YES or NO, one per line:
1. YES/NO
2. YES/NO
...
{len(churches)}. YES/NO"""
        
        return prompt
    
    def _parse_responses(self, response_text: str, churches: List[Church]) -> List[bool]:
        """Parse YES/NO responses from Claude."""
        results = []
        lines = response_text.strip().split('\n')
        
        for i, church in enumerate(churches):
            expected_num = i + 1
            found = False
            
            for line in lines:
                line = line.strip()
                if re.match(rf'^{expected_num}[\.:\)]\s*(YES|NO)', line, re.IGNORECASE):
                    is_valid = 'YES' in line.upper()
                    results.append(is_valid)
                    found = True
                    break
            
            if not found:
                results.append(False)
        
        return results


def filter_church(church: Church, target_state: str = 'texas', 
                  llm_filter: Optional[LLMChurchFilter] = None) -> Tuple[Optional[Church], Optional[str]]:
    """
    Filter a single church object.
    Returns the Church if it passes filters, None if it should be excluded.
    """
    if not is_state_church(church, target_state):
        return None, f"not in {target_state}"
    
    if not passes_pre_filters(church):
        return None, "failed pre-filters"
    
    if llm_filter:
        if not llm_filter.is_christian_church(church):
            return None, "LLM rejected (not Christian/Catholic church)"
    
    return church, None


def filter_churches_generator(churches: list, target_state: str = 'texas', 
                              llm_filter: Optional[LLMChurchFilter] = None) -> list:
    """Filter a list of churches (for batch processing compatibility)."""
    filtered = []
    for church in churches:
        filtered_church, _ = filter_church(church, target_state, llm_filter=llm_filter)
        if filtered_church:
            filtered.append(filtered_church)
    
    if llm_filter:
        llm_filter.flush()
    
    return filtered
