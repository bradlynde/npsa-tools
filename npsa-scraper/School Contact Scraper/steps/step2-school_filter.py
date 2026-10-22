"""
STEP 2: FILTER SCHOOLS - STREAMING VERSION
===========================================
Filter single school object - remove churches, camps, out-of-state results.

Input: School object from Step 1
Output: Filtered School object or None (if filtered out)
"""

import re
from typing import Optional, List, Dict, Tuple
from assets.shared.models import School

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


# Exclusion keywords (churches, camps, etc.)
EXCLUDE_KEYWORDS = [
    'church', 'camp', 'ministry', 'fellowship', 'worship center',
    'bible institute', 'seminary', 'theological seminary',
    'divinity school', 'theological institute', 'bible college',
    'mission', 'outreach center', 'worship', 'pastor', 'minister', 'chapel'
]

# Exclusion keywords for public schools (ISD, public schools, charter schools)
PUBLIC_SCHOOL_KEYWORDS = [
    'isd', 'independent school district', 'public school',
    'public schools', 'charter school', 'public charter',
    'public elementary', 'public high school', 'public middle school',
    'school district', 'isd elementary', 'isd high school',
    'isd middle school', 'isd primary', 'isd secondary',
    'public academy', 'charter academy'
]

# Required Christian/religious keywords (school MUST have at least one)
CHRISTIAN_KEYWORDS = [
    'christian', 'catholic', 'baptist', 'methodist', 'lutheran',
    'presbyterian', 'episcopal', 'pentecostal', 'assembly of god',
    'church of god', 'parochial', 'nondenominational christian',
    'christ-centered', 'christ centered', 'faith-based', 'faith based'
]

# Exclusion keywords for institutions we don't want (colleges, universities)
INSTITUTION_EXCLUDE_KEYWORDS = [
    'college', 'university', 'community college', 'junior college',
    'technical college', 'vocational college', 'graduate school',
    'law school', 'medical school', 'business school'
]

# Exclusion keywords for preschools and daycares (K-12 schools only)
PRESCHOOL_EXCLUDE_KEYWORDS = [
    'preschool', 'pre-school', 'pre school', 'early childhood center',
    'early childhood school', 'nursery school', 'daycare', 'day care',
    'childcare', 'child care', 'kindergarten only', 'pre-k only'
]

# School keywords (must have at least one if it also has exclusion keywords)
# Note: 'preschool' removed - standalone preschools are excluded (K-12 schools only)
SCHOOL_KEYWORDS = [
    'school', 'academy', 'elementary', 'high school',
    'middle school', 'primary school', 'secondary school',
    'prep', 'preparatory', 'education'
]

# Additional patterns for detecting public schools that don't have "ISD" in name
PUBLIC_SCHOOL_PATTERNS = [
    r'\b(steam|stem|magnet|charter)\s+academy\b',  # STEAM Academy, STEM Academy, etc.
    r'\b(early childhood|early learning)\s+center\b',
    r'\b(learning|education)\s+center\b',
    r'\b(alternative|continuation)\s+(school|academy)\b',
]

# Private school indicators (if present, likely NOT public)
PRIVATE_SCHOOL_INDICATORS = [
    'academy', 'prep', 'preparatory', 'montessori', 'waldorf',
    'classical', 'covenant', 'trinity', 'saint', 'st.', 'holy',
    'sacred', 'christian', 'catholic', 'baptist', 'methodist',
    'lutheran', 'presbyterian', 'episcopal', 'regents', 'legacy',
    'cornerstone', 'victory', 'kingdom', 'grace', 'faith',
    'bishop', 'archbishop', 'cardinal', 'diocese', 'archdiocese',
    'immaculate', 'conception', 'assumption', 'annunciation',
    'nativity', 'resurrection', 'ascension', 'transfiguration',
    'all saints', 'holy family', 'sacred heart', 'st mary', 'st. mary',
    'st joseph', 'st. joseph', 'st john', 'st. john', 'st paul', 'st. paul',
    'st peter', 'st. peter', 'st thomas', 'st. thomas', 'st anthony', 'st. anthony',
    'st mark', 'st. mark', 'st luke', 'st. luke', 'st matthew', 'st. matthew',
    'prince of peace', 'our lady', 'notre dame', 'jesuit', 'franciscan',
    'benedictine', 'dominican', 'carmelite', 'marian', 'divine',
    # Additional elite/prestigious school indicators
    'loyola', 'xavier', 'regis', 'marist', 'lasalle', 'la salle',
    'ignatian', 'incarnate word', 'cistercian', 'ursuline', 'monsignor',
    'pope john', 'john paul', 'pius', 'aquinas', 'seton', 'cabrini',
    'lasallian', 'mercymount', 'holy cross', 'holy trinity'
]

# Non-Christian religious keywords
NON_CHRISTIAN_RELIGIOUS = [
    'islamic', 'muslim', 'mosque', 'jewish', 'judaism', 'synagogue',
    'hindu', 'buddhist', 'sikh', 'bahai'
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
    """
    Get state abbreviation and normalized name from state name.
    
    Args:
        state_name: State name (e.g., 'texas', 'Texas', 'texas_ultra_test', 'new_york', 'New York')
        
    Returns:
        tuple: (state_abbrev, normalized_state_name, full_name)
    """
    # Normalize: lowercase, replace spaces with underscores
    normalized = state_name.lower().replace(' ', '_')
    
    # Extract base state name (e.g., "texas" from "texas_ultra_test")
    # Check if the base name (before underscore) is a valid state
    base_state = normalized.split('_')[0] if '_' in normalized else normalized
    
    # Try to get abbreviation - first try base_state, then normalized
    abbrev = STATE_ABBREVIATIONS.get(base_state, '')
    if not abbrev:
        abbrev = STATE_ABBREVIATIONS.get(normalized, '')
    
    # Use base_state for normalization if it's a valid state, otherwise use normalized
    if base_state in STATE_ABBREVIATIONS:
        normalized = base_state
    
    # Get full state name (capitalize words)
    full_name = normalized.replace('_', ' ').title()
    
    return abbrev, normalized, full_name


def is_state_school(school: School, target_state: str) -> bool:
    """
    Check if school is in the target state.
    
    Args:
        school: School object
        target_state: Target state name (e.g., 'texas', 'california')
        
    Returns:
        True if school is in target state, False otherwise
    """
    state_abbrev, normalized_state, full_state_name = get_state_info(target_state)
    
    detected_state = (school.detected_state or '').strip().lower()
    state_field = (school.state or '').strip().lower()
    address_field = (school.address or '').upper()
    
    # PRIMARY CHECK: If school.state was set by step1 (which already validated state), trust it
    # Step1 only creates School objects for in-state results, so if state field is set, it's valid
    # This is the most reliable check since step1 already validated the state before creating the School
    if state_field:
        # Direct match (most common: "texas" == "texas")
        if state_field == normalized_state or state_field == full_state_name.lower():
            return True
        
        # Normalize both for comparison (remove spaces, underscores, hyphens, case)
        state_normalized = state_field.replace(' ', '').replace('_', '').replace('-', '').strip()
        target_normalized = normalized_state.replace(' ', '').replace('_', '').replace('-', '').strip()
        full_normalized = full_state_name.lower().replace(' ', '').replace('_', '').replace('-', '').strip()
        
        # Normalized match (handles any spacing/formatting differences)
        if state_normalized == target_normalized or state_normalized == full_normalized:
            return True
        
        # Substring match (fallback for edge cases)
        if normalized_state in state_field or full_state_name.lower() in state_field:
            return True
    
    # Check detected state
    if detected_state:
        if detected_state == state_abbrev.lower() or detected_state == normalized_state or detected_state == full_state_name.lower():
            return True
    
    # Check address for state abbreviation
    if state_abbrev and f', {state_abbrev} ' in address_field:
        return True
    if state_abbrev and address_field.endswith(f', {state_abbrev}'):
        return True
    
    # Check address for full state name
    if f' {full_state_name.upper()}' in address_field:
        return True
    
    # Check address for normalized state name (e.g., "TEXAS" in address)
    if normalized_state and f' {normalized_state.upper()}' in address_field:
        return True
    
    # Last fallback: look for state abbreviation pattern in address
    if state_abbrev:
        match = re.search(r',\s*([A-Z]{2})\s+\d{5}', address_field)
        if match and match.group(1) == state_abbrev:
            return True
    
    # FINAL FALLBACK: If school.state matches target state (case-insensitive, normalized)
    # This catches cases where state was set correctly but address parsing failed
    if state_field:
        # Normalize both for comparison
        target_normalized = normalized_state.lower()
        state_normalized = state_field.replace(' ', '_').lower()
        if state_normalized == target_normalized:
            return True
    
    return False


def passes_pre_filters(school: School) -> bool:
    """
    Fast pre-filtering - removes obvious cases before LLM step.
    Only excludes clear-cut cases: obvious public schools, colleges, standalone preschools, churches/camps.
    
    Args:
        school: School object
        
    Returns:
        True if passes pre-filters (needs further checking), False if clearly invalid
    """
    if not school.name:
        return False
    
    name_lower = (school.name or '').lower()
    
    # Remove obvious public schools (ISD, explicit public/charter in name)
    obvious_public = ['isd', 'independent school district', 'public school',
                      'public schools', 'public charter', 'school district']
    if any(kw in name_lower for kw in obvious_public):
        return False
    
    # Remove colleges/universities
    if any(kw in name_lower for kw in INSTITUTION_EXCLUDE_KEYWORDS):
        return False
    
    # Remove standalone preschools (but allow "Mary's Preschool and PreK-12th" or similar)
    has_preschool = any(kw in name_lower for kw in PRESCHOOL_EXCLUDE_KEYWORDS)
    if has_preschool:
        # Check if it also has K-12 indicators
        has_k12 = any(kw in name_lower for kw in ['k-12', 'prek-12', 'pre-k to 12', 'prek to 12',
                                                   'pre-k-12', 'k through 12', 'kindergarten through 12',
                                                   'elementary', 'high school', 'middle school'])
        if not has_k12:
            return False  # Standalone preschool only
    
    # Remove churches/camps/seminaries (without school keywords)
    has_exclusion = any(kw in name_lower for kw in EXCLUDE_KEYWORDS)
    if has_exclusion:
        has_school_keyword = any(kw in name_lower for kw in SCHOOL_KEYWORDS)
        if not has_school_keyword:
            return False  # Church/camp without school
    
    # Remove non-Christian religious schools
    if any(kw in name_lower for kw in NON_CHRISTIAN_RELIGIOUS):
        return False
    
    return True  # Passes pre-filters, needs LLM check or further validation


class LLMSchoolFilter:
    """
    Filter schools using Claude to determine if they're private Christian/Catholic schools.
    Processes schools in batches for efficiency.
    """
    
    def __init__(self, api_key: str, target_state: str = 'texas', model: str = "claude-haiku-5-5", batch_size: int = 20):
        """
        Initialize LLM school filter.
        
        Args:
            api_key: Anthropic API key
            target_state: Target state name (e.g., 'texas', 'california')
            model: Model to use (default: claude-haiku-5-5)
            batch_size: Number of schools to process per API call (default: 20)
        """
        if not ANTHROPIC_AVAILABLE:
            raise ImportError("Anthropic library not available. Install with: pip install anthropic")
        
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.batch_size = batch_size
        self.target_state = target_state
        # Get full state name for prompt
        _, _, self.full_state_name = get_state_info(target_state)
        self.pending_schools: List[School] = []
        self.cache: Dict[str, bool] = {}  # Cache results by school name
    
    def is_private_christian_school(self, school: School) -> bool:
        """
        Check if a school is a private Christian/Catholic school using LLM.
        Uses batching for efficiency.
        
        Args:
            school: School object to check
            
        Returns:
            True if private Christian/Catholic school, False otherwise
        """
        if not school.name:
            return False
        
        # Check cache first
        school_name_lower = school.name.lower().strip()
        if school_name_lower in self.cache:
            return self.cache[school_name_lower]
        
        # Add to pending batch
        self.pending_schools.append(school)
        
        # Process batch if full, otherwise process immediately for streaming
        # This ensures we get immediate results during streaming while still batching when possible
        if len(self.pending_schools) >= self.batch_size:
            self._process_batch()
        else:
            # Process immediately for streaming (don't wait for full batch)
            # This is necessary because filter_school needs an immediate answer
            self._process_batch()
        
        # Return cached result (should now be in cache after processing)
        return self.cache.get(school_name_lower, False)
    
    def flush(self):
        """Process any remaining schools in the batch."""
        if self.pending_schools:
            self._process_batch()
    
    def _process_batch(self):
        """Process current batch of schools through Claude."""
        if not self.pending_schools:
            return
        
        batch = self.pending_schools[:]
        self.pending_schools = []
        
        try:
            prompt = self._build_prompt(batch)
            # Thinking off: short classification, and the 200-token cap must hold the answer.
            # (Claude Haiku 5.5 rejects non-default temperature, so none is sent.)
            response = self.client.messages.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                thinking={"type": "disabled"},
                max_tokens=200  # Just need YES/NO x 20
            )
            
            response_text = "".join(
                getattr(block, "text", "") for block in response.content
                if getattr(block, "type", None) == "text"
            )
            results = self._parse_responses(response_text, batch)
            
            # Cache results
            for school, is_valid in zip(batch, results):
                self.cache[school.name.lower().strip()] = is_valid
        
        except Exception as e:
            # On error, default to False (safer to exclude)
            print(f"  {bold('[LLM]')} Filter error: {e}")
            for school in batch:
                self.cache[school.name.lower().strip()] = False
    
    def _build_prompt(self, schools: List[School]) -> str:
        """Build prompt for batch of schools."""
        school_list = "\n".join([f"{i+1}. {school.name}" for i, school in enumerate(schools)])
        
        prompt = f"""You are filtering schools for a private Christian/Catholic school lead database in {self.full_state_name}.

For each school name below, determine if it meets ALL criteria:
1. Private school (NOT public, NOT charter, NOT ISD)
2. Christian or Catholic affiliation (explicit or implicit)
3. K-12 institution (NOT preschool-only, NOT college/university)

NOTE: State location has already been verified - you do NOT need to check location.

CRITICAL INSTRUCTION FOR ELITE SCHOOLS:
Many prestigious private Catholic and Christian schools have neutral, saint-only, or classical names and do NOT contain the words "Catholic" or "Christian" in their Google Places name.

Examples of schools you MUST classify as YES:
- Loyola Academy
- Benet Academy
- Fenwick High School
- Marist High School
- St. Ignatius College Prep
- Regis High School
- Georgetown Preparatory School
- Incarnate Word Academy
- Sacred Heart Schools
- Jesuit College Preparatory
- Any school with "St.", "Holy", "Sacred", "Jesuit", "Marian", "Xavier", "Loyola", "Regis", "Notre Dame", "Assumption", "Monsignor", "Academy", "Prep", "Preparatory"

RULE: If the name contains Academy, Prep, St., Holy, Sacred, Jesuit, Marian, Loyola, Xavier, Regis, or similar religious/elite indicators → CLASSIFY AS YES.

When in doubt → SAY YES. Better to include and verify later than to miss a high-value school.

EXCLUDE if:
- Public schools (ISD, public charter, district schools)
- Charter schools (unless explicitly "private charter")
- Colleges/universities
- Preschool-only institutions (unless it says "PreK-12th" or similar)
- Non-Christian religious schools (Islamic, Jewish, etc.)
- Generic public school names without religious indicators

School names:
{school_list}

For each school, respond with ONLY YES or NO, one per line:
1. YES/NO
2. YES/NO
...
{len(schools)}. YES/NO"""
        
        return prompt
    
    def _parse_responses(self, response_text: str, schools: List[School]) -> List[bool]:
        """Parse YES/NO responses from Claude."""
        results = []
        lines = response_text.strip().split('\n')
        
        for i, school in enumerate(schools):
            # Look for line starting with number
            expected_num = i + 1
            found = False
            
            for line in lines:
                line = line.strip()
                # Match patterns like "1. YES", "1 YES", "1: YES", etc.
                if re.match(rf'^{expected_num}[\.:\)]\s*(YES|NO)', line, re.IGNORECASE):
                    is_valid = 'YES' in line.upper()
                    results.append(is_valid)
                    found = True
                    break
            
            if not found:
                # Fallback: default to False if can't parse
                results.append(False)
        
        return results


def filter_school(school: School, target_state: str = 'texas', 
                 llm_filter: Optional[LLMSchoolFilter] = None) -> Tuple[Optional[School], Optional[str]]:
    """
    Filter a single school object.
    Returns the School if it passes filters, None if it should be excluded.
    
    Filtering order:
    1. State check (must be in target state)
    2. Pre-filters (obvious public schools, colleges, standalone preschools, churches/camps)
    3. LLM filter (if provided) for ambiguous cases
    4. No school indicator requirement (removed - only special cases filtered)
    
    Args:
        school: School object from Step 1
        target_state: Target state to filter for (default: 'texas')
        llm_filter: Optional LLM filter for ambiguous cases
        
    Returns:
        Tuple of (School object if valid, None if filtered out) and (reason string, None if passed)
    """
    # Step 1: Check state-only
    if not is_state_school(school, target_state):
        return None, f"not in {target_state}"  # Not in target state
    
    # Step 2: Fast pre-filters (obvious cases)
    if not passes_pre_filters(school):
        return None, "failed pre-filters (public/charter/college/preschool)"  # Failed pre-filters
    
    # Step 3: LLM filter (if provided) for ambiguous cases
    if llm_filter:
        if not llm_filter.is_private_christian_school(school):
            return None, "LLM rejected (not private Christian/Catholic)"  # LLM determined it's not a private Christian school
    
    # Step 4: REMOVED - no longer require school indicator
    # Only special cases are filtered in pre-filters (preschool-only, church/camp without school)
    
    # Passed all filters
    return school, None


def filter_schools_generator(schools: list, target_state: str = 'texas', 
                             llm_filter: Optional[LLMSchoolFilter] = None) -> list:
    """
    Filter a list of schools (for batch processing compatibility).
    Returns list of filtered schools.
    
    Args:
        schools: List of School objects
        target_state: Target state to filter for (default: 'texas')
        llm_filter: Optional LLM filter for ambiguous cases
        
    Returns:
        List of filtered School objects
    """
    filtered = []
    for school in schools:
        result = filter_school(school, target_state, llm_filter=llm_filter)
        if isinstance(result, tuple):
            filtered_school, _ = result
        else:
            filtered_school = result
        if filtered_school:
            filtered.append(filtered_school)
    
    # Flush any pending LLM batches
    if llm_filter:
        llm_filter.flush()
    
    return filtered


