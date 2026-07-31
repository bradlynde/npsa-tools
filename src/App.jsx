import { useState, useRef, useEffect } from "react";
import html2pdf from "html2pdf.js";
import { marked } from "marked";
import { LOGO_SRC } from "./generator/logo.js";
import {
  PRICING, TIER_LABELS, fmt,
  calcFees, buildInstallmentText, buildCompBlock,
  SHARED_FIELDS, POST_FIELDS,
  PROGRAMS, NPSA_SIGNATURES,
} from "./generator/engine.js";
import {
  DEFAULT_PRE, DEFAULT_INH, DEFAULT_POST, DEFAULT_ADDENDUM, DEFAULT_PROPOSAL,
  renderPreCallHtml,
} from "./generator/templates.js";
import { defaultForm, defaultPreCallForm } from "./generator/defaults.js";

function useAI() {
  const [loading, setLoading] = useState(false);
  const polish = async (text, cb) => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000,
          messages:[{role:"user",content:`You are a legal contract drafting assistant for Nonprofit Security Advisors. Rewrite the following rough clause into polished, professional legal contract language. Return ONLY the polished clause text.\n\nRough clause: ${text}`}]})
      });
      const d = await r.json();
      cb(d.content?.find(b=>b.type==="text")?.text||"");
    } catch { cb("Error generating clause."); }
    setLoading(false);
  };
  return { polish, loading };
}

// Slot-machine count-up: animates 0 → value whenever `playToken` changes (mount + each hover)
function RollUp({ value, format, playToken, duration = 850 }) {
  const [display, setDisplay] = useState(value);
  const rafRef = useRef();
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const to = Number(value) || 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(to * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else setDisplay(to);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playToken, value, duration]);
  return <>{format ? format(display) : Math.round(display)}</>;
}

export default function App() {
  const [docTab, setDocTab] = useState("inh");
  const [form, setForm] = useState(defaultForm);
  const [preSections, setPreSections] = useState(DEFAULT_PRE);
  const [postSections, setPostSections] = useState(DEFAULT_POST);
  const [inhSections, setInhSections] = useState(DEFAULT_INH);
  const [addendumTpl, setAddendumTpl] = useState(DEFAULT_ADDENDUM);
  const [proposalTpl, setProposalTpl] = useState(DEFAULT_PROPOSAL);
  const [preCallInput, setPreCallInput] = useState('');
  const [preCallOutput, setPreCallOutput] = useState('');
  const [preCallMeta, setPreCallMeta] = useState(null);
  const [preCallLoading, setPreCallLoading] = useState(false);
  const [preCallError, setPreCallError] = useState('');
  const [preCallCopied, setPreCallCopied] = useState(false);
  const [preCallForm, setPreCallForm] = useState({...defaultPreCallForm});
  const [preCallCalendlyText, setPreCallCalendlyText] = useState('');
  const [preCallParsing, setPreCallParsing] = useState(false);
  const [preCallDownloading, setPreCallDownloading] = useState(false);
  const [preCallViewMode, setPreCallViewMode] = useState('preview'); // 'preview' | 'edit'
  const [preCallFollowUpEmail, setPreCallFollowUpEmail] = useState('');
  const [preCallFollowUpLoading, setPreCallFollowUpLoading] = useState(false);
  const [preCallFollowUpCopied, setPreCallFollowUpCopied] = useState(false);
  const setPCF = (k, v) => setPreCallForm(f => ({...f, [k]: v}));
  const [signerApprovalModal, setSignerApprovalModal] = useState(null); // {name, title} pending approval
  const [mgmtApprovalModal, setMgmtApprovalModal] = useState(false); // AI clause approval gate
  const [emailModal, setEmailModal] = useState(false);
  const [emailFields, setEmailFields] = useState({to:"", subject:"", message:""});
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewHtml, setReviewHtml] = useState("");
  const [savedLetterOverride, setSavedLetterOverride] = useState(null);
  const [appView, setAppView] = useState('dashboard');
  // The ?view= we honoured on load, if any. Set means the toolbox shell sent us
  // straight to a screen and owns the landing page, so "← Dashboard" belongs to
  // it rather than to our own near-identical copy.
  const [enteredVia, setEnteredVia] = useState(null);
  const [letterRoll, setLetterRoll] = useState(0);
  const [feeRoll, setFeeRoll] = useState(0);
  const [dbAvailable, setDbAvailable] = useState(false);
  const [dashStats, setDashStats] = useState(null);
  const [savedLetters, setSavedLetters] = useState([]);
  const [showLetterBrowser, setShowLetterBrowser] = useState(false);
  const [letterSearch, setLetterSearch] = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [selectedRep, setSelectedRep] = useState('');
  // Reps were printing letters without ever saving them, so the letters never reached
  // the dashboard. Printing now routes through a save first; these track whether the
  // document on screen still matches what was last written to the database.
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState(null);
  const [pendingPrintAfterSave, setPendingPrintAfterSave] = useState(false);
  const [reps, setReps] = useState([]);
  const [currentLetterId, setCurrentLetterId] = useState(null);
  const [newRepName, setNewRepName] = useState('');
  const reviewIframeRef = useRef(null);
  const previewRef = useRef();
  const { polish, loading } = useAI();
  const setF = (k,v) => setForm(f=>({...f,[k]:v}));
  // Total applications = sum over programs of locations that include that program
  const programApps = (form.programs||[{key:"federal",year:"2026"}]).map(pg => ({
    ...pg,
    appCount: (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length || 0
  }));
  const totalApps = programApps.reduce((s,p)=>s+p.appCount,0) || 1;
  const numLocs = totalApps; // fees scale on total applications
  const fees = calcFees(form.engagementModel, form.pricingTier, numLocs, form.optPostAwardScope, form.postAwardFee, form.customFee, form.earlySigningAmount, form.customContingencyFee);
  const inhFees = calcFees(form.inhEngagementModel, form.inhPricingTier, numLocs, form.inhOptPostAwardScope, form.inhPostAwardFee, form.inhCustomFee, form.inhEarlySigningAmount, form.inhCustomContingencyFee);
  // Load templates from server on mount; fall back to hardcoded defaults
  useEffect(() => {
    const load = async (type, setter) => {
      try {
        const r = await fetch(`/api/templates/${type}`);
        if (r.ok) { const d = await r.json(); if (d.sections) setter(d.sections); }
      } catch {}
    };
    load('pre-award', setPreSections);
    load('in-house', setInhSections);
    load('post-award', setPostSections);
    // proposal & addendum templates have a different shape (no .sections array for proposal)
    fetch('/api/templates/proposal').then(r=>r.ok&&r.json()).then(d=>{ if(d&&d.phases) setProposalTpl(d); }).catch(()=>{});
    fetch('/api/templates/addendum').then(r=>r.ok&&r.json()).then(d=>{ if(d&&d.sections) setAddendumTpl(d); }).catch(()=>{});
    fetch('/api/letters/stats').then(r => { if (r.ok) { setDbAvailable(true); r.json().then(setDashStats); } }).catch(() => {});
    fetch('/api/reps').then(r => { if (r.ok) r.json().then(setReps); }).catch(() => {});
  }, []);
  // Deep-link: /?view=<screen> opens a screen directly, so the toolbox shell can
  // link to a tool rather than to a second copy of its own landing page.
  //
  // Each dashboard card does state setup before it switches views — resetting the
  // form, stamping today's signing date, picking the document tab — so these have
  // to do the same or the deep link lands on whatever was left over. Keep this in
  // step with the card handlers below; an unrecognised value falls through to the
  // dashboard exactly as before.
  useEffect(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    if (!view) return;

    const newDocument = (tab) => {
      setForm({...defaultForm, npsaSigningDate: new Date().toISOString().split('T')[0]});
      setDocTab(tab);
      setCurrentLetterId(null);
      setSavedLetterOverride(null);
      setAppView('generator');
    };

    switch (view) {
      case 'settings':   setAppView('settings'); break;
      case 'generator':  newDocument('inh'); break;
      case 'proposal':   newDocument('proposal'); break;
      case 'addendum':   newDocument('addendum'); break;
      case 'precall':
        setPreCallInput(''); setPreCallOutput(''); setPreCallMeta(null); setPreCallError('');
        setPreCallForm({...defaultPreCallForm}); setPreCallCalendlyText('');
        setPreCallViewMode('preview'); setAppView('precall');
        break;
      case 'letters':
        // An overlay rather than a view — it opens over the dashboard.
        setLetterSearch(''); setShowLetterBrowser(true); fetchLetters();
        break;
      default: return; // unknown — stay on the dashboard
    }
    setEnteredVia(view);
  }, []);

  // "← Dashboard". When the shell deep-linked us into a screen it never showed
  // our dashboard, so going back should leave the iframe and return to the
  // toolbox rather than reveal a second landing page. Opened directly on Railway
  // — no shell, no deep link — this is just the old behaviour.
  const goBack = () => {
    if (enteredVia && window.parent !== window) {
      let origin = '*';
      try { origin = new URL(document.referrer).origin; } catch { /* keep '*' */ }
      window.parent.postMessage({ type: 'npsa:navigate', to: '/toolbox' }, origin);
      return;
    }
    setAppView('dashboard');
  };
  // Inject Ms Madi font for signatures
  useEffect(()=>{
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Ms+Madi&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  // Sync Grant Writer guarantee options with pre-award toggles
  useEffect(()=>{
    setForm(f => ({
      ...f,
      gwGuar2: f.optNofo ? true  : f.gwGuar2,
      gwGuar3: f.optNofo ? false : f.gwGuar3,
      gwGuar4: f.optShortNotice ? true : f.gwGuar4,
    }));
  },[form.optNofo, form.optShortNotice]);
  // When reviewMode activates, write HTML into iframe and attach editing handlers.
  // Handlers are attached from the parent (same-origin iframe) using real JS so the
  // regexes below are NOT mangled by template-literal escape processing.
  useEffect(()=>{
    if(!reviewMode || !reviewIframeRef.current) return;
    const iframe = reviewIframeRef.current;

    // Plain-text paste: preserve line breaks as <br>, strip formatting
    const onPaste = (e) => {
      e.preventDefault();
      const doc = iframe.contentDocument;
      const text = (e.clipboardData || iframe.contentWindow.clipboardData).getData("text/plain");
      const sel = doc.getSelection();
      if(!sel.rangeCount) return;
      sel.deleteFromDocument();
      const range = sel.getRangeAt(0);
      const frag = doc.createDocumentFragment();
      text.split(/\r?\n/).forEach((line,i)=>{
        if(i>0) frag.appendChild(doc.createElement("br"));
        if(line) frag.appendChild(doc.createTextNode(line));
      });
      range.insertNode(frag);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    // Find the nearest enclosing list-item div (flex row: [prefix span][content span])
    const findListItem = (node, body) => {
      while(node && node !== body){
        if(node.nodeType===1 && node.tagName==="DIV" && node.style && node.style.display==="flex"){
          const first = node.firstElementChild, last = node.lastElementChild;
          if(first && last && first!==last && first.tagName==="SPAN" && last.tagName==="SPAN"){
            const pfx = (first.textContent||"").replace(/ /g," ").trim();
            if(/^(\d+\.|\([a-zA-Z]\)|[a-zA-Z]\.|[ivxIVX]+\.|[•\-*])$/.test(pfx)) return node;
          }
        }
        node = node.parentNode;
      }
      return null;
    };

    // Compute the next prefix in a sequence (1.->2., (a)->(b), bullet stays)
    const nextPrefix = (pfx) => {
      let m;
      if((m = pfx.match(/^(\d+)\.$/))) return (parseInt(m[1])+1)+".";
      if((m = pfx.match(/^\(([a-z])\)$/)))  return m[1]>="z" ? "(a)" : "("+String.fromCharCode(m[1].charCodeAt(0)+1)+")";
      if((m = pfx.match(/^\(([A-Z])\)$/)))  return m[1]>="Z" ? "(A)" : "("+String.fromCharCode(m[1].charCodeAt(0)+1)+")";
      if((m = pfx.match(/^([a-z])\.$/)))    return m[1]>="z" ? "a." : String.fromCharCode(m[1].charCodeAt(0)+1)+".";
      if((m = pfx.match(/^([•\-*])$/))) return m[1];
      return pfx;
    };

    const onKeyDown = (e) => {
      if(e.key !== "Enter") return;
      const doc = iframe.contentDocument;
      const body = doc.getElementById("editable-body");
      const sel = doc.getSelection();
      if(!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const item = findListItem(range.startContainer, body);

      // Shift+Enter, or not inside a list item → simple soft line break (never breaks layout)
      if(e.shiftKey || !item){
        e.preventDefault();
        range.deleteContents();
        const br = doc.createElement("br");
        range.insertNode(br);
        // trailing zero-width char so the caret lands on the new visual line
        const stop = doc.createTextNode("​");
        range.setStartAfter(br);
        range.insertNode(stop);
        range.setStart(stop, 1); range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
        return;
      }

      // Inside a list item: build a proper sibling list item with the next prefix
      e.preventDefault();
      const prefixSpan = item.firstElementChild;
      const contentSpan = item.lastElementChild;
      const pfx = (prefixSpan.textContent||"").replace(/ /g," ").trim();

      // Split the content span at the caret; trailing content moves to the new item
      let afterFrag = null;
      if(contentSpan.contains(range.startContainer) || range.startContainer===contentSpan){
        const tail = doc.createRange();
        tail.setStart(range.startContainer, range.startOffset);
        tail.setEnd(contentSpan, contentSpan.childNodes.length);
        afterFrag = tail.extractContents();
      }

      const newItem = item.cloneNode(false);
      const newPrefix = prefixSpan.cloneNode(false);
      newPrefix.appendChild(doc.createTextNode(nextPrefix(pfx)));
      newPrefix.appendChild(doc.createTextNode(" "));
      const newContent = contentSpan.cloneNode(false);
      if(afterFrag) newContent.appendChild(afterFrag);
      newItem.appendChild(newPrefix);
      newItem.appendChild(newContent);
      item.parentNode.insertBefore(newItem, item.nextSibling);

      const nr = doc.createRange();
      nr.setStart(newContent, 0); nr.collapse(true);
      sel.removeAllRanges(); sel.addRange(nr);
    };

    const attach = () => {
      const doc = iframe.contentDocument;
      const el = doc && doc.getElementById("editable-body");
      if(!el) return;
      el.innerHTML = reviewHtml;
      // remove-then-add so listeners are never duplicated (attach runs on both
      // the immediate call and the iframe onload event)
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("keydown", onKeyDown);
      el.addEventListener("paste", onPaste);
      el.addEventListener("keydown", onKeyDown);
    };
    iframe.onload = attach;
    attach();
    return () => {
      const doc = iframe.contentDocument;
      const el = doc && doc.getElementById("editable-body");
      if(el){ el.removeEventListener("paste", onPaste); el.removeEventListener("keydown", onKeyDown); }
      iframe.onload = null;
    };
  },[reviewMode, reviewHtml]);

  const today = (()=>{ const d=new Date(); const mm=String(d.getMonth()+1).padStart(2,"0"); const dd=String(d.getDate()).padStart(2,"0"); const yyyy=d.getFullYear(); return `${mm}-${dd}-${yyyy}`; })();
  const fmtExpiry = (()=>{ const v=form.expirationDate||""; if(!v) return ""; const d=new Date(v+"T12:00:00"); return d.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}); })();
  const loc0 = (form.locations||[])[0]||{};
  const clientAddr = [loc0.address,loc0.city,loc0.state,loc0.zip].filter(Boolean).join(", ");
  const interpolatePre = (t) => {
    const installmentsObj = form.installments ? {
      count: parseInt(form.installmentCount) || 2,
      payments: [
        { pct: form.installment1Pct, label: form.installment1Label },
        { pct: form.installment2Pct, label: form.installment2Label },
        { pct: form.installment3Pct, label: form.installment3Label },
      ]
    } : null;
    // Multi-program scope block for item 3
    const progs = form.programs||[{key:"federal",year:"2026"}];
    const numWords = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
    const subItems = ["a","b","c","d","e","f","g","h"];
    const multiProg = progs.length > 1;
    // Build scope item 3 content
    const scopeItem3 = multiProg
      ? `3. NPSA already believes, but does not guarantee, that CLIENT is likely eligible for the following grant programs:\n` +
        progs.map((pg,i) => {
          const cfg = PROGRAMS[pg.key] || PROGRAMS.federal;
          const pgLocs = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key));
          const n = pgLocs.length;
          const nWord = numWords[n] || String(n);
          const appWord = n===1?"application":"applications";
          const locLines = pgLocs.map((loc,li) => {
            const parts=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
            const label=loc.name?`${loc.name}${parts?": ":""}`:  "";
            return `           ${li+1}. ${label}${parts||"[Address TBD]"}`;
          }).join("\n");
          return `   (${subItems[i]}) ${cfg.fullName(pg.year||form.grantYear)} — maximum award $${cfg.maxAward} per location.\n` +
                 `       i.  Under current program guidelines, CLIENT may submit one application per physical address, for up to ${n} distinct location(s). Each location is scored independently and may be awarded the maximum funding amount.\n` +
                 `       ii. This engagement includes support for the submission of ${nWord} ${appWord} for ${n} distinct location(s), at the following address(es):\n${locLines}`;
        }).join("\n\n")
      : (() => {
          const pg = progs[0] || {key:"federal",year:form.grantYear};
          const cfg = PROGRAMS[pg.key] || PROGRAMS.federal;
          const pgLocs = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key));
          const n = pgLocs.length || (form.locations||[]).length || 1;
          const nWord = numWords[n] || String(n);
          const appWord = n===1?"application":"applications";
          const locLines = (pgLocs.length ? pgLocs : form.locations||[]).map((loc,li) => {
            const parts=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
            const label=loc.name?`${loc.name}${parts?": ":""}`:  "";
            return `   ${li+1}. ${label}${parts||"[Address TBD]"}`;
          }).join("\n");
          const eligibilityPhrase = n === 1
            ? `eligible for one application of the ${pg.year||form.grantYear} ${cfg.acronym}`
            : `eligible for one application for each of the (${n}) locations for the ${pg.year||form.grantYear} ${cfg.acronym}`;
          return `3. NPSA already believes, but does not guarantee, that CLIENT is likely ${eligibilityPhrase} which includes funding for target hardening and other physical security enhancements. The total maximum grant award is $${cfg.maxAward} per awarded location.\n   (a) Under current program guidelines, CLIENT may submit one application per physical address, for up to ${n} distinct location(s). Each location is scored independently and may be awarded the maximum funding amount.\n   (b) This engagement includes support for the submission of ${nWord} ${appWord} for ${n} distinct location(s), at the following address(es):\n${locLines}`;
        })();
    // Build GRANT_LABEL for intro (list all programs)
    const grantLabelStr = progs.map(pg => (PROGRAMS[pg.key]||PROGRAMS.federal).fullName(pg.year||form.grantYear)).join(" and the ");
    // Build comp block — per-program fee breakdown when multi-program
    let compBlock;
    if (multiProg) {
      const perAppFee = fees.upfront / Math.max(totalApps, 1);
      const lines = progs.map(pg => {
        const cfg = PROGRAMS[pg.key]||PROGRAMS.federal;
        const n = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length || 0;
        return `   ${cfg.label}: ${n} application${n!==1?"s":""} × ${fmt(perAppFee)} = ${fmt(perAppFee*n)}`;
      });
      const totalStr = fmt(fees.upfront);
      compBlock = `A. NPSA Pre-Award Consulting Fee\n\n1. CLIENT will pay NPSA ${totalStr} upon execution of this Engagement Letter. This fee includes the combined costs below:\n${lines.join("\n")}\n\nB. Third-Party Grant Writer\n\n1. CLIENT will pay a third-party grant writer for grant writing services. These costs are not listed in this Engagement Letter because CLIENT must contract directly with the third party grant writer outside of NPSA's direction or control to remain in compliance with grant program rules.`;
      if (form.optPostAwardScope) {
        compBlock += `\n\nC. Compliance Period Fee\n\n1. In the event CLIENT is awarded funding under any program covered by this engagement, CLIENT agrees to pay NPSA a fixed fee of ${fmt(fees.postAward)} for the Compliance Period services described in this Engagement Letter.\n2. This fee is not contingent upon the amount of funding awarded and is not calculated as a percentage of any grant award. Rather, this fee reflects the additional administrative workload required of NPSA upon award and covers services provided from award notification to receipt of formal written clearance from the State authorizing CLIENT to begin committing grant funds.\n3. The Compliance Period fee shall be due within thirty (30) days of CLIENT'S receipt of award notification.\n4. All fees payable to NPSA under this Engagement Letter are non-reimbursable from grant funds and shall not be charged to, paid from, or otherwise included in any grant-funded budget or reimbursement request. CLIENT acknowledges that such fees are the sole financial responsibility of CLIENT.`;
      } else {
        compBlock += `\n\nNote: None of the above costs are reimbursable from grant funds.`;
      }
    } else {
      const installmentsObjComp = form.installments ? installmentsObj : null;
      compBlock = buildCompBlock(form.engagementModel, fees, installmentsObjComp, form.grantYear, form.optPostAwardScope, form.postAwardFee, form.installmentCount, form.installment1Pct, form.installment1Label, form.installment2Pct, form.installment2Label, form.installment3Pct, form.installment3Label, form.pricingTier === "discounted", form.earlySigningDate, form.earlySigningAmount);
    }
    // NOFO clause — reference all programs
    const pg0 = progs[0]||{key:"federal",year:form.grantYear};
    const cfg0 = PROGRAMS[pg0.key]||PROGRAMS.federal;
    const federalProgs = progs.filter(pg => pg.key === "federal");
    const stateProgs = progs.filter(pg => pg.key !== "federal");
    const federalRef = federalProgs.length ? federalProgs.map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join("/") : "NSGP";
    const nofoClause = form.optNofo
      ? `If the federal government does not issue a Notice of Funding Opportunity for a ${pg0.year||form.grantYear} ${federalRef}, the CLIENT will have the sole right to choose either of the two options below.\n   (a) NPSA will refund the entire ${fmt(fees.upfront)} initial payment.\n   (b) NPSA will work with CLIENT to apply for the next available ${federalRef} Opportunity, and the scope of the project will apply to that opportunity.`
      : `If the federal government does not issue a Notice of Funding Opportunity for a ${pg0.year||form.grantYear} ${federalRef}, NPSA will work with CLIENT to apply for the next available ${federalRef} Opportunity, and the scope of the project will apply to that opportunity.`;
    const stateNofoClause = stateProgs.length > 0
      ? stateProgs.map((pg, i) => {
          const cfg = PROGRAMS[pg.key]||PROGRAMS.federal;
          const num = 4 + i;
          return `${num}. If the state government does not issue a Notice of Funding Opportunity for a ${pg.year||form.grantYear} ${cfg.acronym}, NPSA will work with CLIENT to apply for the next available ${cfg.acronym} Opportunity, and the scope of the project will apply to that opportunity.`;
        }).join("\n\n") + "\n\n"
      : "";
    return t
      .replace(/\[CLIENT_NAME\]/g, form.clientName||"[CLIENT NAME]")
      .replace(/\[GRANT_YEAR_NSGP\]/g, progs.length>1
        ? `${pg0.year||form.grantYear} ${progs.map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join(" and/or ")}`
        : `${pg0.year||form.grantYear} ${cfg0.acronym}`)
      .replace(/\[GRANT_YEAR\]/g, pg0.year||form.grantYear)
      .replace(/\[GRANT_TYPE\]/g, form.grantType)
      .replace(/\[GRANT_LABEL\]/g, grantLabelStr)
      .replace(/\[NSGP\]/g, cfg0.acronym)
      .replace(/\[STATE_ADMIN\]/g, pg0.key==="illinois"?"Illinois":pg0.key==="california"?"California":pg0.key==="newyork"?"New York":"State")
      .replace(/\bNSGP(?!-IL|SGP)\b/g, cfg0.acronym)
      .replace(/3\. NPSA already believes[^\n]*?\n[^]*?\[LOCATION_LIST\]/g, scopeItem3)
      .replace(/\[LOCATION_LIST\]/g, "")
      .replace(/\[MAX_AWARD\]/g, cfg0.maxAward)
      .replace(/\[NUM_LOCATIONS\]/g, totalApps)
      .replace(/\[NUM_APPLICATIONS\]/g, numWords[totalApps]||String(totalApps))
      .replace(/\[APPLICATION_PLURAL\]/g, totalApps===1?"application":"applications")
      .replace(/\[CONSULTING_FEE\]/g, fmt(fees.upfront))
      .replace(/\[UPFRONT_FEE\]/g, fmt(fees.upfront))
      .replace(/\[NOFO_CLAUSE\]/g, nofoClause)
      .replace(/\[STATE_NOFO_CLAUSE\]/g, stateNofoClause)
      .replace(/\[GUAR_4_NUM\]/g, String(4 + stateProgs.length))
      .replace(/\[GUAR_5_NUM\]/g, String(5 + stateProgs.length))
      .replace(/\[GUAR_ROLLOVER\]/g, (() => {
        const allAcronyms = progs.map(pg => (PROGRAMS[pg.key]||PROGRAMS.federal).acronym);
        const progList = allAcronyms.join(" and/or ");
        const govtRef = stateProgs.length > 0 ? "the federal and state governments provide" : "the federal government provides";
        const nextOpp = allAcronyms.join(" and ");
        const guarNum = 4 + stateProgs.length;
        const eitherProgram = stateProgs.length > 0 ? " under either program" : "";
        return `${guarNum}. If CLIENT applies for the ${pg0.year||form.grantYear} ${progList}, ${govtRef} a Notice of Funding, and CLIENT is not awarded any grant funding${eitherProgram}, no refunds will be issued for fees collected as part of this engagement, but NPSA will provide the services outlined in this engagement letter for the next available ${nextOpp} opportunity and waive the ${fmt(fees.upfront)} fee associated with COMPENSATION Section 1 above. In the event this occurs, and CLIENT is awarded grant funding${eitherProgram}, the fees associated with COMPENSATION Section 1 above will apply and all other provisions of this agreement will apply to the subsequent ${progList} opportunity.`;
      })())
      .replace(/\[COMP_BLOCK\]/g, compBlock);
  };
    const interpolateInh = (t) => {
    const installmentsObj = form.inhInstallments ? {
      count: parseInt(form.inhInstallmentCount) || 2,
      payments: [
        { pct: form.inhInstallment1Pct, label: form.inhInstallment1Label },
        { pct: form.inhInstallment2Pct, label: form.inhInstallment2Label },
        { pct: form.inhInstallment3Pct, label: form.inhInstallment3Label },
      ]
    } : null;
    const progs = form.programs||[{key:"federal",year:"2026"}];
    const numWords2 = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
    const subItems2 = ["a","b","c","d","e","f","g","h"];
    const multiProg2 = progs.length > 1;
    const scopeItem3inh = multiProg2
      ? `3. NPSA already believes, but does not guarantee, that CLIENT is likely eligible for the following grant programs:\n` +
        progs.map((pg,i) => {
          const cfg = PROGRAMS[pg.key] || PROGRAMS.federal;
          const pgLocs = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key));
          const n = pgLocs.length;
          const nWord = numWords2[n] || String(n);
          const appWord = n===1?"application":"applications";
          const locLines = pgLocs.map((loc,li) => {
            const parts=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
            const label=loc.name?`${loc.name}${parts?": ":""}`:  "";
            return `           ${li+1}. ${label}${parts||"[Address TBD]"}`;
          }).join("\n");
          return `   (${subItems2[i]}) ${cfg.fullName(pg.year||form.grantYear)} — maximum award $${cfg.maxAward} per location.\n       i.  Under current program guidelines, CLIENT may submit one application per physical address, for up to ${n} distinct location(s).\n       ii. This engagement includes support for the submission of ${nWord} ${appWord} for ${n} distinct location(s), at the following address(es):\n${locLines}`;
        }).join("\n\n")
      : (() => {
          const pg = progs[0]||{key:"federal",year:form.grantYear};
          const cfg = PROGRAMS[pg.key]||PROGRAMS.federal;
          const pgLocs = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key));
          const n = pgLocs.length || (form.locations||[]).length || 1;
          const nWord = numWords2[n] || String(n);
          const appWord = n===1?"application":"applications";
          const locLines = (pgLocs.length ? pgLocs : form.locations||[]).map((loc,li) => {
            const parts=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
            const label=loc.name?`${loc.name}${parts?": ":""}`:  "";
            return `   ${li+1}. ${label}${parts||"[Address TBD]"}`;
          }).join("\n");
          const eligibilityPhraseInh = n === 1
            ? `eligible for one application of the ${pg.year||form.grantYear} ${cfg.acronym}`
            : `eligible for one application for each of the (${n}) locations for the ${pg.year||form.grantYear} ${cfg.acronym}`;
          return `3. NPSA already believes, but does not guarantee, that CLIENT is likely ${eligibilityPhraseInh}. The total maximum grant award is $${cfg.maxAward} per awarded location.\n   (a) Under current program guidelines, CLIENT may submit one application per physical address, for up to ${n} distinct location(s).\n   (b) This engagement includes support for the submission of ${nWord} ${appWord} for ${n} distinct location(s), at the following address(es):\n${locLines}`;
        })();
    const grantLabelStrInh = progs.map(pg => (PROGRAMS[pg.key]||PROGRAMS.federal).fullName(pg.year||form.grantYear)).join(" and the ");
    const pg0inh = progs[0]||{key:"federal",year:form.grantYear};
    const cfg0inh = PROGRAMS[pg0inh.key]||PROGRAMS.federal;
    const federalProgsInh = progs.filter(pg => pg.key === "federal");
    const stateProgsInh = progs.filter(pg => pg.key !== "federal");
    const federalRefInh = federalProgsInh.length ? federalProgsInh.map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join("/") : "NSGP";
    const nofoClause = form.inhOptNofo
      ? `If the federal government does not issue a Notice of Funding Opportunity for a ${pg0inh.year||form.grantYear} ${federalRefInh}, the CLIENT will have the sole right to choose either of the two options below.\n   (a) NPSA will refund the entire ${fmt(inhFees.upfront)} initial payment.\n   (b) NPSA will work with CLIENT to apply for the next available ${federalRefInh} Opportunity, and the scope of the project will apply to that opportunity.`
      : `If the federal government does not issue a Notice of Funding Opportunity for a ${pg0inh.year||form.grantYear} ${federalRefInh}, NPSA will work with CLIENT to apply for the next available ${federalRefInh} Opportunity, and the scope of the project will apply to that opportunity.`;
    const stateNofoClauseInh = stateProgsInh.length > 0
      ? stateProgsInh.map((pg, i) => {
          const cfg = PROGRAMS[pg.key]||PROGRAMS.federal;
          const num = 4 + i;
          return `${num}. If the state government does not issue a Notice of Funding Opportunity for a ${pg.year||form.grantYear} ${cfg.acronym}, NPSA will work with CLIENT to apply for the next available ${cfg.acronym} Opportunity, and the scope of the project will apply to that opportunity.`;
        }).join("\n\n") + "\n\n"
      : "";
    const compBlock = buildCompBlock(form.inhEngagementModel, inhFees, installmentsObj, form.grantYear, form.inhOptPostAwardScope, form.inhPostAwardFee, form.inhInstallmentCount, form.inhInstallment1Pct, form.inhInstallment1Label, form.inhInstallment2Pct, form.inhInstallment2Label, form.inhInstallment3Pct, form.inhInstallment3Label, form.inhPricingTier === "discounted", form.inhEarlySigningDate, form.inhEarlySigningAmount);
    return t
      .replace(/\[CLIENT_NAME\]/g, form.clientName||"[CLIENT NAME]")
      .replace(/\[GRANT_YEAR_NSGP\]/g, progs.length>1
        ? `${pg0inh.year||form.grantYear} ${progs.map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join(" and/or ")}`
        : `${pg0inh.year||form.grantYear} ${cfg0inh.acronym}`)
      .replace(/\[GRANT_YEAR\]/g, pg0inh.year||form.grantYear)
      .replace(/\[GRANT_TYPE\]/g, form.grantType)
      .replace(/\[GRANT_LABEL\]/g, grantLabelStrInh)
      .replace(/\[NSGP\]/g, cfg0inh.acronym)
      .replace(/\[STATE_ADMIN\]/g, pg0inh.key==="illinois"?"Illinois":pg0inh.key==="california"?"California":pg0inh.key==="newyork"?"New York":"State")
      .replace(/\bNSGP(?!-IL|SGP)\b/g, cfg0inh.acronym)
      .replace(/3\. NPSA already believes[^\n]*?\n[^]*?\[LOCATION_LIST\]/g, scopeItem3inh)
      .replace(/\[LOCATION_LIST\]/g, "")
      .replace(/\[MAX_AWARD\]/g, cfg0inh.maxAward)
      .replace(/\[NUM_LOCATIONS\]/g, totalApps)
      .replace(/\[NUM_APPLICATIONS\]/g, numWords2[totalApps]||String(totalApps))
      .replace(/\[APPLICATION_PLURAL\]/g, totalApps===1?"application":"applications")
      .replace(/\[CONSULTING_FEE\]/g, fmt(inhFees.upfront))
      .replace(/\[UPFRONT_FEE\]/g, fmt(inhFees.upfront))
      .replace(/\[NOFO_CLAUSE\]/g, nofoClause)
      .replace(/\[STATE_NOFO_CLAUSE\]/g, stateNofoClauseInh)
      .replace(/\[GUAR_4_NUM\]/g, String(4 + stateProgsInh.length))
      .replace(/\[GUAR_5_NUM\]/g, String(5 + stateProgsInh.length))
      .replace(/\[GUAR_ROLLOVER\]/g, (() => {
        const allAcronymsInh = progs.map(pg => (PROGRAMS[pg.key]||PROGRAMS.federal).acronym);
        const progListInh = allAcronymsInh.join(" and/or ");
        const govtRefInh = stateProgsInh.length > 0 ? "the federal and state governments provide" : "the federal government provides";
        const nextOppInh = allAcronymsInh.join(" and ");
        const guarNumInh = 4 + stateProgsInh.length;
        const eitherProgramInh = stateProgsInh.length > 0 ? " under either program" : "";
        return `${guarNumInh}. If CLIENT applies for the ${pg0inh.year||form.grantYear} ${progListInh}, ${govtRefInh} a Notice of Funding, and CLIENT is not awarded any grant funding${eitherProgramInh}, no refunds will be issued for fees collected as part of this engagement, but NPSA will provide the services outlined in this engagement letter for the next available ${nextOppInh} opportunity and waive the ${fmt(inhFees.upfront)} fee associated with COMPENSATION Section 1 above. In the event this occurs, and CLIENT is awarded grant funding${eitherProgramInh}, the fees associated with COMPENSATION Section 1 above will apply and all other provisions of this agreement will apply to the subsequent ${progListInh} opportunity.`;
      })())
      .replace(/\[COMP_BLOCK\]/g, compBlock);
  };
  const postPrograms = form.postPrograms||[{key:"federal",year:String(new Date().getFullYear())}];
  const postGrantYear = postPrograms[0]?.year||String(new Date().getFullYear());
  const postNonFederal = postPrograms.filter(p=>p.key!=="federal");
  const interpolatePost = (t) => {
    const effDate = form.postEffectiveDate || "";
    let effDateLabel = "[Effective Date not set]";
    let pmt2DateLabel = "[Month 4 date]";
    let pmt3DateLabel = "[Month 8 date]";
    if (effDate) {
      const d = new Date(effDate + "T12:00:00");
      const m4 = new Date(d); m4.setMonth(m4.getMonth() + 4);
      const m8 = new Date(d); m8.setMonth(m8.getMonth() + 8);
      const fmtD = (dt) => dt.toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric"});
      effDateLabel = fmtD(d);
      pmt2DateLabel = fmtD(m4);
      pmt3DateLabel = fmtD(m8);
    }
    const postLocLines = (form.locations||[]).length > 0
      ? (form.locations||[]).map((loc,i) => {
          const parts = [loc.name, loc.address, [loc.city, loc.state, loc.zip].filter(Boolean).join(", ")].filter(Boolean);
          return `       ${i+1}. ${parts.join(" — ")}`;
        }).join("\n")
      : "       1. [No addresses entered — add locations in the Locations section]";
    const reimbOption = form.postReimbursementOption === "optionA"
      ? "\n6. CLIENT acknowledges that M&A consulting fees may be eligible for reimbursement through NSGP grant proceeds, subject to approval by the administering State agency. CLIENT further acknowledges that the timing of grant reimbursements may not align with NPSA's payment schedule, and that CLIENT is solely responsible for making all payments to NPSA in accordance with the schedule above, regardless of whether or when CLIENT receives grant reimbursement."
      : form.postReimbursementOption === "optionB"
      ? "\n6. CLIENT acknowledges that NPSA's M&A consulting fees are not reimbursable through NSGP grant proceeds and that CLIENT is solely responsible for all payments to NPSA from CLIENT's own funds."
      : "";
    return t
      .replace(/\[CLIENT_NAME\]/g, form.clientName||"[CLIENT NAME]")
      .replace(/\[GRANT_YEAR\]/g, postGrantYear)
      .replace(/\[STATE_FULL_SUFFIX\]/g, postNonFederal.map(p=>` & ${(PROGRAMS[p.key]||PROGRAMS.federal).fullName(p.year)}`).join(""))
      .replace(/\[STATE_AWARD_SUFFIX\]/g, postNonFederal.map(p=>` and ${(PROGRAMS[p.key]||PROGRAMS.federal).acronym}`).join(""))
      .replace(/\[POST_FEE\]/g, `$${form.postFee}`)
      .replace(/\[POST_PMT1\]/g, form.postPmt1)
      .replace(/\[POST_PMT2\]/g, form.postPmt2)
      .replace(/\[POST_PMT3\]/g, form.postPmt3)
      .replace(/\[POST_EFFECTIVE_DATE\]/g, effDateLabel)
      .replace(/\[POST_PMT2_DATE\]/g, pmt2DateLabel)
      .replace(/\[POST_PMT3_DATE\]/g, pmt3DateLabel)
      .replace(/\[POST_LOCATION_LIST\]/g, postLocLines)
      .replace(/\[POST_REIMBURSEMENT_OPTION\]/g, reimbOption);
  };
  // ── Addendum interpolation ──────────────────────────────────────────────────
  const joinWithBoth = (arr) => {
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `both ${arr[0]} and ${arr[1]}`;
    return arr.slice(0,-1).join(", ") + ", and " + arr[arr.length-1];
  };
  const addendumPrograms = form.addendumPrograms || [{key:"illinois",year:String(new Date().getFullYear())}];
  const interpolateAddendum = (t) => {
    const ruleNames = addendumPrograms.map(p => {
      const cfg = PROGRAMS[p.key] || PROGRAMS.federal;
      const nm = cfg.fullName("").replace(/[“”"]/g,"").replace(/\(\s*/,"(").trim();
      return `the ${nm}`;
    });
    const applied = addendumPrograms.map(p => {
      const cfg = PROGRAMS[p.key] || PROGRAMS.federal;
      return p.key === "federal" ? `the ${p.year} Federal NSGP` : `the ${p.year} ${cfg.acronym}`;
    });
    return t
      .replace(/\[ADDENDUM_CLIENT\]/g, form.addendumClientName || form.clientName || "[CLIENT NAME]")
      .replace(/\[ADDENDUM_PROGRAM_RULES\]/g, joinWithBoth(ruleNames))
      .replace(/\[ADDENDUM_PROGRAMS\]/g, joinWithBoth(applied));
  };
  // ── Proposal interpolation + computed summary ───────────────────────────────
  const proposalProgs = form.programs || [{key:"federal",year:form.grantYear}];
  const proposalAcronyms = proposalProgs.map(p => (PROGRAMS[p.key]||PROGRAMS.federal).acronym).join(" / ");
  const proposalProgramList = proposalProgs.map(p => {
    const cfg = PROGRAMS[p.key] || PROGRAMS.federal;
    return cfg.fullName(p.year||form.grantYear).replace(/[“”"]/g,"");
  }).join(" and the ");
  const proposalMaxFunding = proposalProgs.reduce((s,pg)=>{
    const cfg = PROGRAMS[pg.key]||PROGRAMS.federal;
    const n = (form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length || 0;
    return s + n*(parseFloat(cfg.maxAward.replace(/,/g,""))||200000);
  }, 0);
  const interpolateProposal = (t) => t
    .replace(/\[CLIENT_NAME\]/g, form.clientName || "[CLIENT NAME]")
    .replace(/\[PROPOSAL_PROGRAM_LIST\]/g, proposalProgramList)
    .replace(/\[PROPOSAL_PROGRAM_ACRONYMS\]/g, proposalAcronyms);
  const getContent = (sections,id,subId,interp) => {
    const s = sections.find(x=>x.id===id); if(!s) return "";
    if(subId&&s.subsections){ const sub=s.subsections.find(x=>x.id===subId); return sub?interp(sub.content):""; }
    return s.content?interp(s.content):"";
  };
  // Serialized view of everything saveLetter persists, so an edit made after saving
  // still counts as unsaved. Called at click time to avoid referencing state declared
  // further down this component.
  const docSnapshot = () => JSON.stringify({ form, savedLetterOverride: savedLetterOverride || null, docTab });
  const needsSaveBeforePrint = () => lastSavedSnapshot === null || docSnapshot() !== lastSavedSnapshot;
  const handlePrint = () => {
    if (!isAddendum && !form.expirationDate) {
      alert("Please set an Expiration Date before downloading or printing.");
      return;
    }
    if (needsSaveBeforePrint()) {
      setPendingPrintAfterSave(true);
      setShowSaveModal(true);
      return;
    }
    runPrint();
  };
  const runPrint = () => {
    const docTitle = isGw ? "Grant Writer New Client Form - "
      : isProposal ? "Proposal - "
      : isAddendum ? "Addendum to Engagement Letter - "
      : "Engagement Letter - ";
    const clientLabel = form.clientName || "Client";
    const filename = `${docTitle}${clientLabel}.pdf`;
    if (isGw) {
      // Grant Writer tab: use print dialog (has checkbox fields that render better via print)
      const bodyHtml = previewRef.current.innerHTML;
      const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle + clientLabel}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Ms+Madi&display=swap" rel="stylesheet"><style>
        body{font-family:Georgia,serif;font-size:11.5pt;line-height:1.7;color:#1a1a1a;margin:0;padding:0}
        .page{padding:72pt;max-width:8.5in;margin:0 auto}
        pre{white-space:pre-wrap;font-family:Georgia,serif;font-size:11pt;line-height:1.75;margin:0 0 8pt}
        div,span{font-family:Georgia,serif;font-size:11pt;line-height:1.75;box-sizing:border-box}
        button{display:none!important}.no-print{display:none!important}
        @media print{@page{margin:72pt;size:letter}body{margin:0}}
      </style></head><body><div class="page">${bodyHtml}</div><script>
        document.fonts.ready.then(function(){ window.print(); });
      <\/script></body></html>`;
      const win = window.open("", "_blank");
      if(win){ win.document.write(printHtml); win.document.close(); }
      // A popup opened right after the save request can trip the pop-up blocker, which
      // would otherwise fail silently. The document is already saved at this point, so
      // clicking Download again prints straight through.
      else { alert("Your browser blocked the download window. Allow pop-ups for this site, then click Download again — your document has been saved."); }
    } else {
      // Engagement letter tabs: native browser print for perfect page breaks + margins
      const bodyHtml = previewRef.current.innerHTML;
      const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle + clientLabel}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Ms+Madi&display=swap" rel="stylesheet"><style>
        *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
        @page{margin:0.75in;size:letter}
        body{margin:0;padding:0;font-family:Georgia,serif}
        button,.no-print{display:none!important}
        h1,h2,h3,h4{page-break-after:avoid;break-after:avoid}
        p,li{orphans:3;widows:3}
      </style></head><body><div style="font-family:Georgia,serif">${bodyHtml}</div><script>
        document.fonts.ready.then(function(){ window.print(); });
      <\/script></body></html>`;
      const win = window.open("", "_blank");
      if(win){ win.document.write(printHtml); win.document.close(); }
      // A popup opened right after the save request can trip the pop-up blocker, which
      // would otherwise fail silently. The document is already saved at this point, so
      // clicking Download again prints straight through.
      else { alert("Your browser blocked the download window. Allow pop-ups for this site, then click Download again — your document has been saved."); }
    }
  };
    // ── DOCUMENT MODE ──────────────────────────────────────────────────────────
  const isPre = docTab==="pre";
  const isGw = docTab==="gw";
  const isInh = docTab==="inh";
  const isProposal = docTab==="proposal";
  const isAddendum = docTab==="addendum";
  const sections = isPre?preSections:isInh?inhSections:postSections;
  const interp = isPre?interpolatePre:isInh?interpolateInh:interpolatePost;
  const gc = (id,subId) => getContent(sections,id,subId,interp);
  // Renders section text with proper hanging indents for numbered/lettered list items
  const renderLines = (text) => {
    if (!text) return null;
    return text.split("\n").map((line, i) => {
      if (line.trim() === "") {
        // Skip blank line if the previous non-blank line was a section header (A./B./C.)
        const allLines = text.split("\n");
        const prevNonBlank = allLines.slice(0, i).reverse().find(l => l.trim());
        if (prevNonBlank && /^[A-Z]\.\s+.+$/.test(prevNonBlank.trim())) return null;
        return <div key={i} style={{height:6}}/>;
      }
      // Detect prefix patterns and compute indent levels
      // Level 0: "1." "2." "10." etc at start (after optional spaces)
      // Level 1: "(a)" "(b)" "a." "b." indented with spaces
      // Level 2: deeper sub-items
      const trimmed = line.trimStart();
      const leadSpaces = line.length - trimmed.length;
      // Detect A. / B. section headers (bold, not list items)
      const sectionHeaderMatch = trimmed.match(/^([A-Z])\.\s+(.+)$/);
      if (sectionHeaderMatch && sectionHeaderMatch[1].length === 1) {
        return (
          <div key={i} style={{fontFamily:"Georgia,serif",fontSize:12,lineHeight:1.75,color:"#1a1a1a",fontWeight:700,marginTop:6,marginBottom:2}}>
            {trimmed}
          </div>
        );
      }
      // Match prefix: number+period, letter+period, (letter), (number)
      const prefixMatch = trimmed.match(/^(\d+\.|[a-z]\.|[A-Z]\.|[ivx]+\.|[IVX]+\.|\([a-z]\)|\([A-Z]\)|\(\d+\))\s+/);
      if (prefixMatch) {
        const prefix = prefixMatch[0]; // e.g. "1. " or "(a) "
        const rest = trimmed.slice(prefix.length);
        // Base indent from leading spaces (each space ≈ 0.55em in Georgia 13px)
        const baseIndent = leadSpaces * 0.55;
        // Fixed widths by prefix type so alignment is consistent regardless of digit count
        const isTopLevel = /^\d+\.\s/.test(trimmed);
        const isSubLetter = /^\([a-zA-Z]\)\s/.test(trimmed);
        const isRoman = /^[ivxIVX]+\.\s/.test(trimmed);
        const numMatch = trimmed.match(/^(\d+)\./);
        const digitCount = numMatch ? numMatch[1].length : 1;
        const hangEm = isTopLevel ? (digitCount >= 2 ? 2.8 : 2.2) : isSubLetter ? 2.0 : isRoman ? 1.8 : prefix.length * 0.6;
        return (
          <div key={i} style={{
            fontFamily:"Georgia,serif", fontSize:12, lineHeight:1.75, color:"#222",
            display:"flex", alignItems:"flex-start",
            marginLeft:`${baseIndent}em`, marginBottom:2,
          }}>
            <span style={{flexShrink:0, width:`${hangEm}em`, display:"inline-block"}}>{prefix.trimEnd()}&nbsp;</span>
            <span style={{flex:1}}>{rest}</span>
          </div>
        );
      }
      // Plain line — render with leading space indentation
      // Cost breakdown lines (contain "×") get extra indent to align under list item text
      const isCostLine = trimmed.includes("×") || trimmed.match(/^[A-Za-z].+:\s+\d/);
      return (
        <div key={i} style={{
          fontFamily:"Georgia,serif", fontSize:12, lineHeight:1.75, color:"#222",
          marginLeft: isCostLine ? `3.5em` : `${leadSpaces * 0.55}em`, marginBottom:2,
        }}>{trimmed}</div>
      );
    });
  };
  const SH = ({id}) => { const s=sections.find(x=>x.id===id); if(!s||!s.roman) return null;
    return <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:30,marginBottom:10,pageBreakAfter:"avoid",breakAfter:"avoid"}}>{s.roman} {s.title}</div>; };
  const SubH = ({label}) => <div style={{fontSize:13,fontWeight:700,fontStyle:"italic",marginTop:14,marginBottom:6,color:"#333",pageBreakAfter:"avoid",breakAfter:"avoid"}}>{label}</div>;
  const Body = ({id,subId}) => {
    const raw = gc(id,subId);
    const tokenRe = /\[EARLY_SIGNING_DISCOUNT:([^:]+):([^:]+):([^\]]+)\]/;
    const match = raw.match(tokenRe);
    if (!match) return <div style={{marginBottom:8}}>{renderLines(raw)}</div>;
    const [full, date, discAmt, baseFee] = match;
    const parts = raw.split(full);
    return <>
      <div style={{marginBottom:8}}>{renderLines(parts[0].trimEnd())}</div>
      <div style={{border:"1px solid #a7b4c6",borderRadius:4,background:"#f7f9fd",padding:"12px 16px",margin:"10px 0 8px",fontFamily:"Georgia,serif",fontSize:12,lineHeight:1.7,color:"#222"}}>
        <span style={{fontWeight:700,color:"#1e3a5f",fontSize:11,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:5}}>Early Signing Discount</span>
        {`A ${discAmt} early signing discount has been applied to the standard ${baseFee} consulting fee. To retain this discount, this Agreement must be executed on or before ${date}.`}
      </div>
      {parts[1]&&<div style={{marginBottom:8}}>{renderLines(parts[1].trimStart())}</div>}
    </>;
  };
  const fetchLetters = async (search = '') => {
    const r = await fetch(`/api/letters?search=${encodeURIComponent(search)}`);
    if (r.ok) setSavedLetters(await r.json());
  };

  const saveLetter = async () => {
    const parseFee = (s) => parseFloat(String(s||'').replace(/[^0-9.]/g,'')) || 0;
    const computedFee = docTab === 'post' ? parseFee(form.postFee)
      : docTab === 'gw' ? parseFee(form.gwProfFee)
      : docTab === 'inh' ? (inhFees.total || 0)
      : docTab === 'addendum' ? 0
      : docTab === 'proposal' ? (form.proposalFeeModel==='inh' ? (inhFees.total||0) : (fees.total||0))
      : (fees.total || 0); // proposal reuses pre-award fees (excluded from stats server-side)
    const payload = {
      client_name: form.clientName || 'Untitled',
      rep_name: selectedRep || 'Unknown',
      doc_tab: docTab,
      form_data: form,
      saved_html: savedLetterOverride || null,
      total_fee: computedFee,
    };
    if (currentLetterId) {
      await fetch(`/api/letters/${currentLetterId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } else {
      const data = await fetch('/api/letters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      setCurrentLetterId(data.id);
    }
    setLastSavedSnapshot(docSnapshot());
    setShowSaveModal(false);
    fetch('/api/letters/stats').then(r => r.json()).then(setDashStats);
    if (pendingPrintAfterSave) {
      setPendingPrintAfterSave(false);
      runPrint();
    }
  };

  const loadLetter = async (id) => {
    const letter = await fetch(`/api/letters/${id}`).then(r => r.json());
    // Always stamp today's date so a re-opened draft never goes out with a stale signing date
    const stamped = {...letter.form_data, npsaSigningDate: new Date().toISOString().split('T')[0]};
    setForm(stamped);
    setDocTab(letter.doc_tab);
    setSavedLetterOverride(letter.saved_html || null);
    setCurrentLetterId(id);
    setLastSavedSnapshot(JSON.stringify({ form: stamped, savedLetterOverride: letter.saved_html || null, docTab: letter.doc_tab }));
    setShowLetterBrowser(false);
    setAppView('generator');
  };

  const deleteLetter = async (id) => {
    if (!confirm('Delete this saved letter?')) return;
    await fetch(`/api/letters/${id}`, { method: 'DELETE' });
    setSavedLetters(prev => prev.filter(l => l.id !== id));
    if (currentLetterId === id) setCurrentLetterId(null);
    fetch('/api/letters/stats').then(r => r.json()).then(setDashStats);
  };

  const addRep = async () => {
    if (!newRepName.trim()) return;
    const r = await fetch('/api/reps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newRepName.trim() }),
    });
    if (r.ok) {
      const rep = await r.json();
      setReps(prev => [...prev, rep].sort((a, b) => a.name.localeCompare(b.name)));
      setNewRepName('');
    }
  };

  const deleteRep = async (id) => {
    await fetch(`/api/reps/${id}`, { method: 'DELETE' });
    setReps(prev => prev.filter(r => r.id !== id));
  };

  const rankColors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  const tabLabel = { pre: 'Pre-Award (Third Party)', inh: 'Pre-Award (In-House)', post: 'Award Implementation', gw: '3rd Party Grant Writer', proposal: 'Proposal', addendum: 'Addendum' };
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtFee = (n) => n > 0 ? '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0}) : '—';

  return (
    <>
      {/* ── DASHBOARD ── */}
      {appView === 'dashboard' && (
        <div style={{minHeight:'100vh',background:'#fbfaf8',fontFamily:'var(--font-sans)',display:'flex',flexDirection:'column',alignItems:'center'}}>
          {/* Gear — top right */}
          {dbAvailable && (
            <div style={{width:'100%',maxWidth:720,padding:'20px 24px 0',boxSizing:'border-box',display:'flex',justifyContent:'flex-end'}}>
              <button onClick={()=>setAppView('settings')}
                style={{background:'#fff',border:'1px solid #d9d5cc',borderRadius:12,width:46,height:46,display:'flex',alignItems:'center',justifyContent:'center',color:'#4a5462',cursor:'pointer',boxShadow:'0 2px 8px rgba(2,6,23,0.08)',transition:'color 0.2s, transform 0.3s'}}
                title="Settings"
                onMouseEnter={e=>{e.currentTarget.style.color='#182230';e.currentTarget.style.transform='rotate(60deg)';}}
                onMouseLeave={e=>{e.currentTarget.style.color='#4a5462';e.currentTarget.style.transform='rotate(0deg)';}}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>
          )}

          {/* Welcome heading */}
          <div style={{textAlign:'center',padding:'20px 32px 16px'}}>
            <div style={{fontSize:30,fontWeight:800,color:'#182230',letterSpacing:-0.5}}>Sales Toolbox</div>
            <div style={{fontSize:15,color:'#4a5462',marginTop:6}}>Generate engagement documents and prep for calls — all in one place.</div>
          </div>

          {/* All cards in one aligned container */}
          <div style={{width:'100%',maxWidth:720,padding:'0 24px 48px',boxSizing:'border-box'}}>

            {/* ── Engagement Letters ── */}
            <div style={{fontSize:13,fontWeight:800,color:'#4a5462',letterSpacing:0.6,textTransform:'uppercase',marginBottom:14}}>Engagement Letters</div>

            {/* Action cards */}
            <div style={{display:'flex',gap:18,marginBottom:18}}>
              <div onClick={()=>{ setForm({...defaultForm, npsaSigningDate: new Date().toISOString().split('T')[0]}); setDocTab('inh'); setCurrentLetterId(null); setSavedLetterOverride(null); setAppView('generator'); }}
                style={{flex:1,background:'#fff',borderRadius:18,padding:'20px',cursor:'pointer',boxShadow:'0 4px 16px rgba(2,6,23,0.07)',transition:'transform 0.15s, box-shadow 0.15s',display:'flex',alignItems:'center',gap:16,border:'1px solid rgba(255,255,255,0.8)'}}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow='0 12px 32px rgba(26,37,64,0.22)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow='0 4px 16px rgba(2,6,23,0.07)';}}>
                <div style={{width:56,height:56,borderRadius:15,background:'#1e3a5f',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:'0 6px 16px rgba(26,37,64,0.4)'}}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </div>
                <div>
                  <div style={{color:'#182230',fontWeight:700,fontSize:17}}>Generate New Letter</div>
                  <div style={{color:'#8a8577',fontSize:13,lineHeight:1.5,marginTop:2}}>Start a new engagement letter from scratch</div>
                </div>
              </div>
              {dbAvailable && (
                <div onClick={()=>{ fetchLetters(); setLetterSearch(''); setShowLetterBrowser(true); }}
                  style={{flex:1,background:'#fff',borderRadius:18,padding:'20px',cursor:'pointer',boxShadow:'0 4px 16px rgba(2,6,23,0.07)',transition:'transform 0.15s, box-shadow 0.15s',display:'flex',alignItems:'center',gap:16,border:'1px solid rgba(255,255,255,0.8)'}}
                  onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow='0 12px 32px rgba(122,140,30,0.25)';}}
                  onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow='0 4px 16px rgba(2,6,23,0.07)';}}>
                  <div style={{width:56,height:56,borderRadius:15,background:'#6b8e23',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:'0 6px 16px rgba(122,140,30,0.4)'}}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </div>
                  <div>
                    <div style={{color:'#182230',fontWeight:700,fontSize:17}}>Load Previous Letter</div>
                    <div style={{color:'#8a8577',fontSize:13,lineHeight:1.5,marginTop:2}}>Search and reload a saved draft</div>
                  </div>
                </div>
              )}
            </div>

            {/* Stats + leaderboard */}
            {dbAvailable && dashStats && (<>
              <div style={{display:'flex',gap:18,marginBottom:18}}>
                <div onMouseEnter={()=>setLetterRoll(k=>k+1)}
                  style={{flex:1,background:'#1e3a5f',borderRadius:18,padding:'24px 26px',boxShadow:'0 10px 28px rgba(26,37,64,0.3)',cursor:'default'}}>
                  <div style={{color:'#fff',fontWeight:800,fontSize:42,lineHeight:1}}><RollUp value={dashStats.total} playToken={letterRoll} format={(n)=>Math.round(n).toLocaleString('en-US')} /></div>
                  <div style={{color:'rgba(255,255,255,0.75)',fontSize:12,marginTop:8,textTransform:'uppercase',letterSpacing:0.6,fontWeight:600}}>Total Letters Generated</div>
                </div>
                <div onMouseEnter={()=>setFeeRoll(k=>k+1)}
                  style={{flex:1,background:'#6b8e23',borderRadius:18,padding:'24px 26px',boxShadow:'0 10px 28px rgba(122,140,30,0.3)',cursor:'default'}}>
                  <div style={{color:'#fff',fontWeight:800,fontSize:dashStats.total_fees>0?36:42,lineHeight:1}}><RollUp value={dashStats.total_fees} playToken={feeRoll} format={(n)=> dashStats.total_fees>0 ? '$'+Math.round(n).toLocaleString('en-US') : '—'} /></div>
                  <div style={{color:'rgba(255,255,255,0.75)',fontSize:12,marginTop:8,textTransform:'uppercase',letterSpacing:0.6,fontWeight:600}}>Total Fees Generated</div>
                </div>
              </div>

              {dashStats.by_rep?.length > 0 && (
                <div style={{background:'#fff',borderRadius:18,boxShadow:'0 4px 16px rgba(2,6,23,0.07)',overflow:'hidden',border:'1px solid rgba(255,255,255,0.8)'}}>
                  <div style={{padding:'16px 24px',borderBottom:'1px solid #f0ede5',display:'flex',alignItems:'center',gap:9}}>
                    <span style={{fontSize:19}}>&#127942;</span>
                    <span style={{color:'#182230',fontWeight:700,fontSize:16}}>Rep Leaderboard</span>
                  </div>
                  {dashStats.by_rep.map((row, i) => (
                    <div key={row.rep_name} style={{display:'flex',alignItems:'center',padding:'15px 24px',borderBottom:i===dashStats.by_rep.length-1?'none':'1px solid #f0ede5',gap:14}}>
                      <div style={{width:32,height:32,borderRadius:'50%',background:rankColors[i]||'#efece4',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:13,color:i<3?'#1a2540':'#a09a8c',flexShrink:0,boxShadow:i<3?'0 2px 8px rgba(0,0,0,0.12)':'none'}}>
                        {i+1}
                      </div>
                      <div style={{flex:1,fontWeight:600,color:'#182230',fontSize:16}}>{row.rep_name}</div>
                      <div style={{fontWeight:800,color:'#6b8e23',fontSize:17}}>{row.count}</div>
                      <div style={{color:'#a09a8c',fontSize:13}}>{row.count === 1 ? 'letter' : 'letters'}</div>
                    </div>
                  ))}
                </div>
              )}
            </>)}

            {/* ── Proposals & Addendums ── */}
            <div style={{fontSize:13,fontWeight:800,color:'#4a5462',letterSpacing:0.6,textTransform:'uppercase',marginTop:34,marginBottom:14}}>Proposals &amp; Addendums</div>
            <div style={{display:'flex',gap:18,marginBottom:18}}>
              <div onClick={()=>{ setForm({...defaultForm, npsaSigningDate: new Date().toISOString().split('T')[0]}); setDocTab('proposal'); setCurrentLetterId(null); setSavedLetterOverride(null); setAppView('generator'); }}
                style={{flex:1,background:'#fff',borderRadius:18,padding:'20px',cursor:'pointer',boxShadow:'0 4px 16px rgba(2,6,23,0.07)',transition:'transform 0.15s, box-shadow 0.15s',display:'flex',alignItems:'center',gap:16,border:'1px solid rgba(255,255,255,0.8)'}}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow='0 12px 32px rgba(26,37,64,0.22)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow='0 4px 16px rgba(2,6,23,0.07)';}}>
                <div style={{width:56,height:56,borderRadius:15,background:'#1e3a5f',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:'0 6px 16px rgba(26,37,64,0.4)'}}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m12 18-1.5-3-3-1.5 3-1.5L12 9l1.5 3 3 1.5-3 1.5z"/></svg>
                </div>
                <div>
                  <div style={{color:'#182230',fontWeight:700,fontSize:17}}>New Proposal</div>
                  <div style={{color:'#8a8577',fontSize:13,lineHeight:1.5,marginTop:2}}>One-page leadership summary of scope &amp; price</div>
                </div>
              </div>
              <div onClick={()=>{ setForm({...defaultForm, npsaSigningDate: new Date().toISOString().split('T')[0]}); setDocTab('addendum'); setCurrentLetterId(null); setSavedLetterOverride(null); setAppView('generator'); }}
                style={{flex:1,background:'#fff',borderRadius:18,padding:'20px',cursor:'pointer',boxShadow:'0 4px 16px rgba(2,6,23,0.07)',transition:'transform 0.15s, box-shadow 0.15s',display:'flex',alignItems:'center',gap:16,border:'1px solid rgba(255,255,255,0.8)'}}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow='0 12px 32px rgba(122,140,30,0.25)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow='0 4px 16px rgba(2,6,23,0.07)';}}>
                <div style={{width:56,height:56,borderRadius:15,background:'#6b8e23',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:'0 6px 16px rgba(122,140,30,0.4)'}}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M10.5 13.5a2.121 2.121 0 0 1 3 3L11 19l-2 .5.5-2Z"/></svg>
                </div>
                <div>
                  <div style={{color:'#182230',fontWeight:700,fontSize:17}}>New Addendum</div>
                  <div style={{color:'#8a8577',fontSize:13,lineHeight:1.5,marginTop:2}}>Remove Implementation Period services from a signed letter</div>
                </div>
              </div>
            </div>

            {/* ── Tools ── */}
            <div style={{fontSize:13,fontWeight:800,color:'#4a5462',letterSpacing:0.6,textTransform:'uppercase',marginTop:26,marginBottom:14}}>Tools</div>
            <div onClick={()=>{ setPreCallInput(''); setPreCallOutput(''); setPreCallMeta(null); setPreCallError(''); setPreCallForm({...defaultPreCallForm}); setPreCallCalendlyText(''); setPreCallViewMode('preview'); setAppView('precall'); }}
              style={{background:'#fff',borderRadius:18,padding:'20px',cursor:'pointer',boxShadow:'0 4px 16px rgba(2,6,23,0.07)',transition:'transform 0.15s, box-shadow 0.15s',display:'flex',alignItems:'center',gap:16,border:'1px solid rgba(255,255,255,0.8)'}}
              onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow='0 12px 32px rgba(26,37,64,0.22)';}}
              onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow='0 4px 16px rgba(2,6,23,0.07)';}}>
              <div style={{width:56,height:56,borderRadius:15,background:'#1e3a5f',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:'0 6px 16px rgba(58,44,110,0.4)'}}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.74a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/></svg>
              </div>
              <div>
                <div style={{color:'#182230',fontWeight:700,fontSize:17,display:'flex',alignItems:'center',gap:8}}>Pre-Call Notes Generator<span style={{fontSize:10,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase',color:'#3a2c6e',background:'#ece8f7',border:'1px solid #d6cdf0',borderRadius:20,padding:'2px 9px'}}>In Beta</span></div>
                <div style={{color:'#8a8577',fontSize:13,lineHeight:1.5,marginTop:2}}>Paste a Calendly invite and generate AI-powered prep notes</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PRE-CALL NOTES ── */}
      {appView === 'precall' && (
  <div style={{minHeight:'100vh',background:'#fbfaf8',fontFamily:'var(--font-sans)'}}>
    <div style={{padding:'24px 32px 0',display:'flex',alignItems:'center',gap:14}}>
      <button onClick={goBack}
        style={{background:'#fff',border:'1px solid #e7e2d6',borderRadius:10,padding:'9px 16px',color:'#4a5462',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:7,boxShadow:'0 2px 8px rgba(2,6,23,0.05)'}}>
        &#8592; Dashboard
      </button>
      <div style={{color:'#182230',fontWeight:800,fontSize:22}}>Pre-Call Notes Generator</div>
      <span style={{fontSize:10,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase',color:'#3a2c6e',background:'#ece8f7',border:'1px solid #d6cdf0',borderRadius:20,padding:'2px 9px'}}>In Beta</span>
    </div>

    <div style={{maxWidth:900,margin:'28px auto',padding:'0 24px 60px',display:'flex',gap:28,alignItems:'flex-start',flexWrap:'wrap'}}>

      {/* ── LEFT: Form ── */}
      <div style={{flex:'1 1 380px',display:'flex',flexDirection:'column',gap:16}}>

        {/* Import from Calendly */}
        <div style={{background:'#fff',borderRadius:14,boxShadow:'0 2px 12px rgba(2,6,23,0.06)',border:'1px solid #f0ede5',padding:'16px 20px 18px'}}>
          <div style={{fontWeight:700,fontSize:14,color:'#182230',marginBottom:8}}>&#128248; Import from Calendly Invite</div>
          <div style={{fontSize:12,color:'#8a8577',marginBottom:8}}>Paste your Calendly notification email and click Parse — it will fill the form below automatically.</div>
          <textarea value={preCallCalendlyText} onChange={e=>setPreCallCalendlyText(e.target.value)}
            placeholder="Paste full Calendly invite email here..."
            style={{width:'100%',minHeight:140,border:'1px solid #d9d5cc',borderRadius:8,padding:'10px 12px',fontSize:13,outline:'none',boxSizing:'border-box',resize:'vertical',fontFamily:'var(--font-sans)',lineHeight:1.5}}/>
          <button onClick={async()=>{
            if(!preCallCalendlyText.trim()) return;
            setPreCallParsing(true);
            try {
              const r = await fetch('/api/precall/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({calendlyText:preCallCalendlyText})});
              const d = await r.json();
              if(d.org_name) setPCF('orgName', d.org_name);
              if(d.org_type) setPCF('orgType', d.org_type);
              if(d.org_state) setPCF('orgState', d.org_state);
              if(d.website_url) setPCF('websiteUrl', d.website_url);
              if(d.meeting_date) setPCF('meetingDate', d.meeting_date);
              if(d.meeting_time) setPCF('meetingTime', d.meeting_time);
              if(d.meeting_timezone) setPCF('meetingTimezone', d.meeting_timezone);
              if(d.zoom_url) setPCF('zoomUrl', d.zoom_url);
              if(d.zoom_id) setPCF('zoomId', d.zoom_id);
              if(d.zoom_password) setPCF('zoomPassword', d.zoom_password);
              if(d.attendees?.length) setPCF('attendees', d.attendees.filter(a=>a.name).map(a=>({name:a.name||'',email:a.email||'',phone:a.phone||''})));
            } catch(e){ setPreCallError('Could not parse invite: '+e.message); }
            setPreCallParsing(false);
          }} disabled={preCallParsing}
            style={{marginTop:10,background:preCallParsing?'#a09a8c':'#1a2540',color:'#fff',border:'none',borderRadius:8,padding:'9px 20px',fontSize:13,fontWeight:700,cursor:preCallParsing?'default':'pointer'}}>
            {preCallParsing?'Parsing…':'Parse & Fill Form'}
          </button>
        </div>

        {/* Organization */}
        <div style={{background:'#fff',borderRadius:14,boxShadow:'0 2px 12px rgba(2,6,23,0.06)',border:'1px solid #f0ede5',padding:'18px 20px'}}>
          <div style={{fontWeight:700,fontSize:14,color:'#182230',marginBottom:14}}>Organization</div>
          <div style={{display:'flex',gap:10,marginBottom:10}}>
            <div style={{flex:2}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Organization Name *</label>
              <input value={preCallForm.orgName} onChange={e=>setPCF('orgName',e.target.value)} placeholder="e.g. iThrive Christian Church"
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>State</label>
              <input value={preCallForm.orgState} onChange={e=>setPCF('orgState',e.target.value)} placeholder="GA"
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
          </div>
          <div style={{display:'flex',gap:10,marginBottom:10}}>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Type</label>
              <select value={preCallForm.orgType} onChange={e=>setPCF('orgType',e.target.value)}
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',background:'#fff'}}>
                <option value="church">Church</option>
                <option value="school">School</option>
                <option value="other">Other Nonprofit</option>
              </select>
            </div>
          </div>
          <div>
            <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Website URL <span style={{color:'#6b8e23',fontWeight:600}}>(recommended — AI uses this to find titles &amp; addresses)</span></label>
            <input value={preCallForm.websiteUrl} onChange={e=>setPCF('websiteUrl',e.target.value)} placeholder="https://ithrivecc.org"
              style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            <div style={{fontSize:11,color:'#a09a8c',marginTop:4}}>Leave blank and the AI will try to find the site automatically from the org name.</div>
          </div>
        </div>

        {/* Meeting Details */}
        <div style={{background:'#fff',borderRadius:14,boxShadow:'0 2px 12px rgba(2,6,23,0.06)',border:'1px solid #f0ede5',padding:'18px 20px'}}>
          <div style={{fontWeight:700,fontSize:14,color:'#182230',marginBottom:14}}>Meeting Details</div>
          <div style={{display:'flex',gap:10,marginBottom:10}}>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Date</label>
              <input type="date" value={preCallForm.meetingDate} onChange={e=>setPCF('meetingDate',e.target.value)}
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Time (CST)</label>
              <input type="time" value={preCallForm.meetingTime} onChange={e=>setPCF('meetingTime',e.target.value)}
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
          </div>
          <div style={{marginBottom:10}}>
            <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Video Conference Link</label>
            <input value={preCallForm.zoomUrl} onChange={e=>setPCF('zoomUrl',e.target.value)} placeholder="https://zoom.us/j/... or teams.microsoft.com/..."
              style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
          </div>
          <div style={{display:'flex',gap:10}}>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Meeting ID</label>
              <input value={preCallForm.zoomId} onChange={e=>setPCF('zoomId',e.target.value)} placeholder="815-052-42724"
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:11,color:'#8a8577',display:'block',marginBottom:3}}>Passcode</label>
              <input value={preCallForm.zoomPassword} onChange={e=>setPCF('zoomPassword',e.target.value)} placeholder="408098"
                style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
            </div>
          </div>
        </div>

        {/* Attendees */}
        <div style={{background:'#fff',borderRadius:14,boxShadow:'0 2px 12px rgba(2,6,23,0.06)',border:'1px solid #f0ede5',padding:'18px 20px'}}>
          <div style={{fontWeight:700,fontSize:14,color:'#182230',marginBottom:4}}>Organization Attendees</div>
          <div style={{fontSize:12,color:'#8a8577',marginBottom:12}}>The AI will look up their titles from the website.</div>
          {(preCallForm.attendees||[]).map((att,idx)=>(
            <div key={idx} style={{display:'flex',gap:8,marginBottom:8,alignItems:'flex-start'}}>
              <div style={{flex:2}}>
                {idx===0&&<label style={{fontSize:10,color:'#a09a8c',display:'block',marginBottom:2}}>Name</label>}
                <input value={att.name} onChange={e=>{const a=[...preCallForm.attendees];a[idx]={...a[idx],name:e.target.value};setPCF('attendees',a);}} placeholder="Full Name"
                  style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'7px 10px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
              </div>
              <div style={{flex:2}}>
                {idx===0&&<label style={{fontSize:10,color:'#a09a8c',display:'block',marginBottom:2}}>Email</label>}
                <input value={att.email} onChange={e=>{const a=[...preCallForm.attendees];a[idx]={...a[idx],email:e.target.value};setPCF('attendees',a);}} placeholder="email@org.org"
                  style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'7px 10px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
              </div>
              <div style={{flex:2}}>
                {idx===0&&<label style={{fontSize:10,color:'#a09a8c',display:'block',marginBottom:2}}>Phone</label>}
                <input value={att.phone} onChange={e=>{const a=[...preCallForm.attendees];a[idx]={...a[idx],phone:e.target.value};setPCF('attendees',a);}} placeholder="404-555-0000"
                  style={{width:'100%',border:'1px solid #d9d5cc',borderRadius:8,padding:'7px 10px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
              </div>
              {(preCallForm.attendees||[]).length>1&&(
                <button onClick={()=>setPCF('attendees',(preCallForm.attendees||[]).filter((_,i)=>i!==idx))}
                  style={{background:'none',border:'1px solid #d9a99c',borderRadius:8,color:'#a3341f',cursor:'pointer',padding:'7px 10px',fontSize:12,marginTop:idx===0?16:0}}>✕</button>
              )}
            </div>
          ))}
          <button onClick={()=>setPCF('attendees',[...(preCallForm.attendees||[]),{name:'',email:'',phone:''}])}
            style={{background:'none',border:'1px dashed #8796aa',borderRadius:8,padding:'7px 16px',fontSize:12,color:'#4a5462',cursor:'pointer',marginTop:4}}>+ Add Attendee</button>
        </div>

        {/* Additional Context */}
        <div style={{background:'#fff',borderRadius:14,boxShadow:'0 2px 12px rgba(2,6,23,0.06)',border:'1px solid #f0ede5',padding:'18px 20px'}}>
          <div style={{fontWeight:700,fontSize:14,color:'#182230',marginBottom:4}}>Additional Context <span style={{fontWeight:400,color:'#a09a8c',fontSize:12}}>(optional)</span></div>
          <div style={{fontSize:12,color:'#8a8577',marginBottom:8}}>Anything the rep already knows about the org or meeting that the AI should factor in.</div>
          <textarea value={preCallForm.extraNotes} onChange={e=>setPCF('extraNotes',e.target.value)}
            placeholder="e.g. They were referred by First Baptist Rockford. The pastor mentioned they had a break-in last year..."
            style={{width:'100%',minHeight:80,border:'1px solid #d9d5cc',borderRadius:8,padding:'10px 12px',fontSize:13,outline:'none',boxSizing:'border-box',resize:'vertical',fontFamily:'var(--font-sans)',lineHeight:1.5}}/>
        </div>

        {/* Generate Button */}
        {preCallError&&<div style={{color:'#a3341f',background:'#fff5f5',border:'1px solid #f5c6c6',borderRadius:8,padding:'10px 14px',fontSize:13}}>{preCallError}</div>}
        <button onClick={async()=>{
          if(!preCallForm.orgName.trim()){ setPreCallError('Enter an organization name.'); return; }
          setPreCallError(''); setPreCallLoading(true); setPreCallOutput(''); setPreCallMeta(null);
          try {
            const r = await fetch('/api/precall',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({formData:preCallForm})});
            if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Generation failed'); }
            const d = await r.json();
            setPreCallOutput(d.notes||'');
            setPreCallViewMode('preview');
            setPreCallMeta({website:d.website, websiteFetched:d.websiteFetched});
          } catch(err){ setPreCallError(err.message||'Generation failed'); }
          setPreCallLoading(false);
        }} disabled={preCallLoading}
          style={{background:preCallLoading?'#a09a8c':'#1e3a5f',color:'#fff',border:'none',borderRadius:12,padding:'14px',fontSize:15,fontWeight:700,cursor:preCallLoading?'default':'pointer',boxShadow:'0 4px 14px rgba(58,44,110,0.3)',width:'100%'}}>
          {preCallLoading?'Researching organization & generating notes…':'Generate Pre-Call Notes'}
        </button>
        {preCallMeta&&(
          <div style={{fontSize:12,color:'#8a8577',textAlign:'center'}}>
            {preCallMeta.websiteFetched?`✓ Website research completed: ${preCallMeta.website}`:`⚠ Could not fetch ${preCallMeta.website||'website'} — some fields may be TBD`}
          </div>
        )}
      </div>

      {/* ── RIGHT: Output ── */}
      {preCallOutput&&(
        <div style={{flex:'1 1 420px'}}>
          {/* Toolbar row */}
          <div style={{display:'flex',gap:10,marginBottom:12,alignItems:'center',flexWrap:'wrap'}}>
            <div style={{fontWeight:700,fontSize:15,color:'#182230',flex:1}}>Pre-Call Notes</div>
            {/* Preview / Edit toggle */}
            <div style={{display:'flex',background:'#f0ede5',borderRadius:8,padding:2}}>
              <button onClick={()=>setPreCallViewMode('preview')}
                style={{background:preCallViewMode==='preview'?'#fff':'transparent',color:preCallViewMode==='preview'?'#1a2540':'#8a8577',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12.5,fontWeight:700,cursor:'pointer',boxShadow:preCallViewMode==='preview'?'0 1px 4px rgba(2,6,23,0.1)':'none'}}>
                Preview
              </button>
              <button onClick={()=>setPreCallViewMode('edit')}
                style={{background:preCallViewMode==='edit'?'#fff':'transparent',color:preCallViewMode==='edit'?'#1a2540':'#8a8577',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12.5,fontWeight:700,cursor:'pointer',boxShadow:preCallViewMode==='edit'?'0 1px 4px rgba(2,6,23,0.1)':'none'}}>
                Edit
              </button>
            </div>
            <button onClick={async()=>{
              const orgName=preCallForm.orgName||'NPSA';
              const html=`<html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif}h1{font-size:18pt;color:#182230}h2{font-size:11pt;color:#1e3a5f;border-bottom:1pt solid #c8dce8;padding-bottom:4pt;margin-top:16pt;text-transform:uppercase}h3{font-size:11pt;color:#182230}p,li{font-size:11pt;color:#26334d;line-height:1.5}strong{color:#182230}a{color:#1e3a5f}</style></head><body>${marked(preCallOutput)}</body></html>`;
              setPreCallDownloading(true);
              try {
                const r=await fetch('/api/precall/docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({html,filename:`Pre-Call Notes - ${orgName}`})});
                if(!r.ok) throw new Error('Server error');
                const blob=await r.blob();
                const url=URL.createObjectURL(blob);
                const a=document.createElement('a');
                a.href=url; a.download=`Pre-Call Notes - ${orgName}.docx`;
                document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
              } catch(e){ alert('Download failed: '+e.message); }
              setPreCallDownloading(false);
            }} disabled={preCallDownloading}
              style={{background:preCallDownloading?'#a09a8c':'#fff',color:preCallDownloading?'#fff':'#1e3a5f',border:'1px solid #1e3a5f',borderRadius:8,padding:'8px 16px',fontSize:13,fontWeight:700,cursor:preCallDownloading?'default':'pointer'}}>
              {preCallDownloading?'Generating…':'⬇ Download .docx'}
            </button>
          </div>

          {/* Notes preview / edit */}
          {preCallViewMode==='preview' ? (
            <div style={{background:'#fff',border:'1px solid #f0ede5',borderRadius:14,padding:'30px 34px',minHeight:700,boxShadow:'0 4px 16px rgba(2,6,23,0.06)'}}
              dangerouslySetInnerHTML={{__html: renderPreCallHtml(preCallOutput)}}/>
          ) : (
            <>
              <div style={{fontSize:11.5,color:'#a09a8c',marginBottom:6}}>Markdown — use <code>##</code> for sections, <code>-</code> for bullets, <code>**bold**</code>. Switch to Preview to see it formatted.</div>
              <textarea value={preCallOutput} onChange={e=>setPreCallOutput(e.target.value)}
                style={{width:'100%',minHeight:700,border:'1px solid #f0ede5',borderRadius:14,padding:'22px 26px',fontSize:13,lineHeight:1.65,color:'#182230',fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',boxSizing:'border-box',boxShadow:'0 4px 16px rgba(2,6,23,0.06)',outline:'none',resize:'vertical'}}/>
            </>
          )}

          {/* ── Post-Call Action Buttons ── */}
          <div style={{marginTop:20,display:'flex',gap:12,flexWrap:'wrap'}}>
            {/* Start Engagement Letter */}
            <button onClick={()=>{
              const f=preCallForm;
              const a0=f.attendees&&f.attendees[0]||{};
              const clientTypeMap={church:'Church',school:'School',other:'Other'};
              const today=new Date().toISOString().split('T')[0];
              setForm(prev=>({
                ...prev,
                clientName: f.orgName||'',
                clientType: clientTypeMap[f.orgType]||'Other',
                contactName: a0.name||'',
                contactEmail: a0.email||'',
                contactPhone: a0.phone||'',
                npsaSigningDate: today,
              }));
              setDocTab('inh');
              setCurrentLetterId(null);
              setSavedLetterOverride(null);
              setAppView('generator');
            }}
              style={{flex:1,minWidth:180,background:'#1e3a5f',color:'#fff',border:'none',borderRadius:10,padding:'13px 20px',fontSize:13.5,fontWeight:700,cursor:'pointer',boxShadow:'0 3px 10px rgba(26,74,110,0.25)',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:16}}>&#128196;</span> Start Engagement Letter
            </button>

            {/* Draft Follow-up Email */}
            <button onClick={async()=>{
              setPreCallFollowUpLoading(true);
              setPreCallFollowUpEmail('');
              try {
                const r=await fetch('/api/precall/followup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({formData:preCallForm,notes:preCallOutput})});
                const d=await r.json();
                if(d.email) setPreCallFollowUpEmail(d.email);
                else throw new Error(d.error||'No email returned');
              } catch(e){ alert('Could not generate email: '+e.message); }
              setPreCallFollowUpLoading(false);
            }} disabled={preCallFollowUpLoading}
              style={{flex:1,minWidth:180,background:preCallFollowUpLoading?'#a09a8c':'#6b8e23',color:'#fff',border:'none',borderRadius:10,padding:'13px 20px',fontSize:13.5,fontWeight:700,cursor:preCallFollowUpLoading?'default':'pointer',boxShadow:'0 3px 10px rgba(45,122,79,0.22)',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:16}}>&#9993;</span> {preCallFollowUpLoading?'Drafting…':'Draft Follow-up Email'}
            </button>
          </div>

          {/* ── Follow-up Email Panel ── */}
          {preCallFollowUpEmail&&(
            <div style={{marginTop:18,background:'#f7fbf9',border:'1px solid #c3e8d2',borderRadius:14,padding:'22px 26px',boxShadow:'0 2px 10px rgba(45,122,79,0.06)'}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
                <div style={{fontWeight:700,fontSize:14,color:'#1a3d2b',flex:1}}>&#9993; Follow-up Email Draft</div>
                <button onClick={async()=>{
                  try {
                    await navigator.clipboard.writeText(preCallFollowUpEmail);
                  } catch {
                    const ta=document.createElement('textarea');
                    ta.value=preCallFollowUpEmail; ta.style.position='fixed'; ta.style.opacity='0';
                    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                  }
                  setPreCallFollowUpCopied(true);
                  setTimeout(()=>setPreCallFollowUpCopied(false),2500);
                }}
                  style={{background:preCallFollowUpCopied?'#6b8e23':'#fff',color:preCallFollowUpCopied?'#fff':'#6b8e23',border:'1px solid #6b8e23',borderRadius:8,padding:'6px 14px',fontSize:12.5,fontWeight:700,cursor:'pointer',transition:'all .2s'}}>
                  {preCallFollowUpCopied?'✓ Copied!':'Copy Email'}
                </button>
              </div>
              <pre style={{margin:0,whiteSpace:'pre-wrap',fontFamily:'var(--font-sans)',fontSize:13,lineHeight:1.65,color:'#1a3d2b'}}>{preCallFollowUpEmail}</pre>
            </div>
          )}
        </div>
      )}

    </div>
  </div>
)}

      {/* ── SETTINGS ── */}
      {appView === 'settings' && (
        <div style={{minHeight:'100vh',background:'#fbfaf8',fontFamily:'var(--font-sans)'}}>
          <div style={{padding:'24px 32px 0',display:'flex',alignItems:'center',gap:14}}>
            <button onClick={goBack}
              style={{background:'#fff',border:'1px solid #e7e2d6',borderRadius:10,padding:'9px 16px',color:'#4a5462',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:7,boxShadow:'0 2px 8px rgba(2,6,23,0.05)'}}>
              &#8592; Dashboard
            </button>
            <div style={{color:'#182230',fontWeight:800,fontSize:22}}>Settings</div>
          </div>
          <div style={{maxWidth:540,margin:'32px auto',padding:'0 24px'}}>
            <div style={{background:'#fff',borderRadius:18,boxShadow:'0 6px 24px rgba(2,6,23,0.06)',overflow:'hidden',border:'1px solid #f0ede5'}}>
              <div style={{padding:'18px 26px',borderBottom:'1px solid #f0ede5',display:'flex',alignItems:'center',gap:9}}>
                <span style={{fontSize:18}}>&#128101;</span>
                <span style={{color:'#182230',fontWeight:700,fontSize:16}}>Sales Reps</span>
              </div>
              <div style={{padding:'22px 26px'}}>
                {reps.length === 0 && (
                  <div style={{color:'#a09a8c',fontSize:14,marginBottom:18}}>No reps added yet. Add your first rep below.</div>
                )}
                {reps.map(rep => (
                  <div key={rep.id} style={{display:'flex',alignItems:'center',padding:'12px 0',borderBottom:'1px solid #f0ede5',gap:8}}>
                    <div style={{flex:1,fontSize:15,color:'#182230',fontWeight:600}}>{rep.name}</div>
                    <button onClick={()=>deleteRep(rep.id)}
                      style={{background:'none',border:'1px solid #d9a99c',color:'#a3341f',borderRadius:8,padding:'6px 14px',fontSize:12.5,cursor:'pointer',fontWeight:600}}>
                      Remove
                    </button>
                  </div>
                ))}
                <div style={{display:'flex',gap:10,marginTop:22}}>
                  <input value={newRepName} onChange={e=>setNewRepName(e.target.value)}
                    onKeyDown={e=>e.key==='Enter'&&addRep()}
                    placeholder="Rep name..."
                    style={{flex:1,border:'1px solid #d9d5cc',borderRadius:10,padding:'10px 14px',fontSize:14,outline:'none'}}/>
                  <button onClick={addRep}
                    style={{background:'#1e3a5f',color:'#fff',border:'none',borderRadius:10,padding:'10px 22px',fontSize:14,fontWeight:700,cursor:'pointer',boxShadow:'0 4px 14px rgba(26,37,64,0.3)'}}>
                    Add Rep
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── GENERATOR ── */}
      {appView === 'generator' && (
    <div style={{display:"flex",height:"100vh",fontFamily:'var(--font-sans)',background:"#fbfaf8"}}>
      {/* ── SIDEBAR ── */}
      <div style={{width:320,background:"#16202e",color:"#e8edf4",overflowY:"auto",padding:"20px 16px",flexShrink:0}}>
        <button onClick={goBack}
          style={{background:'none',border:'none',color:'#8796aa',fontSize:12,cursor:'pointer',padding:'0 0 14px',display:'flex',alignItems:'center',gap:5,fontFamily:'var(--font-sans)'}}>
          &#8592; Dashboard
        </button>
        {SHARED_FIELDS.map((f2,i)=>{
          if(f2.section) return <div key={i} style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>{f2.section}</div>;
          return (
            <div key={f2.key} style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>{f2.label}</label>
              <input value={form[f2.key]||""} onChange={e=>setF(f2.key, f2.formatFn ? f2.formatFn(e.target.value) : e.target.value)} placeholder={f2.placeholder||""}
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          );
        })}
        {/* Locations — shared across letter/proposal tabs (not GW or addendum) */}
        {(!isGw&&!isAddendum)&&<>
        <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Locations</div>
        {(form.locations||[]).map((loc,idx)=>(
          <div key={idx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 6px",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <span style={{fontSize:11,color:"#8796aa",fontWeight:700}}>Location {idx+1}{idx===0?" (Primary)":""}</span>
              {idx>0&&<button onClick={()=>setF("locations",(form.locations||[]).filter((_,i)=>i!==idx))}
                style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>}
            </div>
            {[{k:"name",ph:"Location / Site Name (optional)"},{k:"address",ph:"Street Address"},{k:"city",ph:"City"},{k:"state",ph:"State"},{k:"zip",ph:"ZIP"}].map(f2=>(
              <div key={f2.k} style={{marginBottom:6}}>
                <input value={loc[f2.k]||""} placeholder={f2.ph}
                  onChange={e=>{
                    const updated=[...(form.locations||[])];
                    updated[idx]={...updated[idx],[f2.k]:e.target.value};
                    setF("locations",updated);
                  }}
                  style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
              </div>
            ))}
            {(isPre||isInh||isProposal)&&(form.programs||[]).length>0&&<>
              <div style={{fontSize:10,color:"#8796aa",marginTop:6,marginBottom:4}}>Applies to:</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:4}}>
                {(form.programs||[]).map(pg=>{
                  const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
                  const checked=(loc.programs||["federal"]).includes(pg.key);
                  return (
                    <button key={pg.key} onClick={()=>{
                      const updated=[...(form.locations||[])];
                      const cur=updated[idx].programs||["federal"];
                      updated[idx]={...updated[idx],programs:checked?cur.filter(k=>k!==pg.key):[...cur,pg.key]};
                      setF("locations",updated);
                    }} style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:"1px solid",cursor:"pointer",
                      background:checked?"#1e3a5f":"#1f2a3a",
                      borderColor:checked?"#4a8bc4":"#2b3a4d",
                      color:checked?"#fff":"#8796aa"}}>
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </>}
          </div>
        ))}
        <button onClick={()=>setF("locations",[...(form.locations||[]),{name:"",address:"",city:"",state:"",zip:"",programs:(form.programs||[]).map(p=>p.key)}])}
          style={{width:"100%",background:"#1f2a3a",border:"1px dashed #33415a",borderRadius:6,padding:"7px 0",fontSize:11,color:"#4a8bc4",cursor:"pointer",marginBottom:14}}>
          + Add Location
        </button>
        </>}
        {/* Engagement Variant selector — In-House (inh) = NPSA writes; Third Party (pre) = outside writer */}
        {(isPre||isInh)&&<>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Engagement Variant</div>
          <select value={docTab} onChange={e=>setDocTab(e.target.value)}
            style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,marginBottom:6,outline:"none"}}>
            <option value="inh">In-House Grant Writing</option>
            <option value="pre">Third Party Grant Writing</option>
          </select>
          <div style={{fontSize:10,color:"#8796aa",marginBottom:10,lineHeight:1.5}}>{isInh?"NPSA manages grant writing, application preparation & submission.":"An outside grant writer prepares the applications; NPSA provides advisory & compliance support."}</div>
        </>}
        {/* Pre-award specific — shared by Proposal (proposal is a view of pre-award data) */}
        {(isPre||isProposal)&&<>
          {isProposal&&<>
            <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Proposal Options</div>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Service Model</label>
            <select value={form.proposalServiceModel||"inhouse"} onChange={e=>setF("proposalServiceModel",e.target.value)}
              style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,marginBottom:6,outline:"none"}}>
              <option value="inhouse">Grant Writing — Pre-Award &amp; Compliance</option>
              <option value="full">Full-Service — Pre-Award, Compliance &amp; Implementation</option>
            </select>
            <div style={{fontSize:10,color:"#8796aa",marginBottom:10,lineHeight:1.5}}>{form.proposalServiceModel==="full"?"Includes Award Implementation, billed as a percentage-based fee post-award.":"Implementation is presented as optional, under a separate agreement."}</div>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:4}}>Grant Writing Model</label>
            <div style={{display:"flex",gap:6,marginBottom:4}}>
              {[{val:"inh",label:"In-House Grant Writer"},{val:"pre",label:"Third-Party Grant Writer"}].map(opt=>(
                <button key={opt.val} onClick={()=>setF("proposalFeeModel",opt.val)}
                  style={{flex:1,padding:"7px 4px",borderRadius:6,border:"1px solid",fontSize:11,fontWeight:700,cursor:"pointer",
                    background:form.proposalFeeModel===opt.val?"#1e3a5f":"#1f2a3a",
                    borderColor:form.proposalFeeModel===opt.val?"#4a8bc4":"#2b3a4d",
                    color:form.proposalFeeModel===opt.val?"#fff":"#8796aa"}}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{fontSize:10,color:"#8796aa",marginBottom:10,lineHeight:1.5}}>
              {form.proposalFeeModel==="inh"?"NPSA manages grant writing, application preparation &amp; submission. (~$11K/location)":"An independent grant writer prepares the applications; NPSA provides advisory &amp; compliance support. (~$4K/location)"}
            </div>
          </>}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Grant Programs</div>
          {(form.programs||[]).map((pg,pgIdx)=>{
            const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
            return (
              <div key={pgIdx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 8px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:11,color:"#4a8bc4",fontWeight:700}}>{cfg.label}</span>
                  {(form.programs||[]).length>1&&<button onClick={()=>setF("programs",(form.programs||[]).filter((_,i)=>i!==pgIdx))}
                    style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>}
                </div>
                <div style={{marginBottom:6}}>
                  <label style={{fontSize:10,color:"#8796aa",display:"block",marginBottom:2}}>Grant Year</label>
                  <input value={pg.year||"2026"} onChange={e=>{
                    const updated=[...(form.programs||[])];
                    updated[pgIdx]={...updated[pgIdx],year:e.target.value};
                    setF("programs",updated);
                  }} placeholder="2026"
                    style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
                </div>
                <div style={{fontSize:10,color:"#8796aa",marginBottom:3}}>Max Award: <span style={{color:"#6b8e23"}}>${cfg.maxAward}</span></div>
                <div style={{fontSize:10,color:"#8796aa"}}>Applications: <span style={{color:"#fff",fontWeight:700}}>{(form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length}</span></div>
              </div>
            );
          })}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
            {Object.entries(PROGRAMS).filter(([k])=>!(form.programs||[]).some(p=>p.key===k)).map(([k,cfg])=>(
              <button key={k} onClick={()=>{
                setF("programs",[...(form.programs||[]),{key:k,year:form.grantYear||"2026"}]);
              }} style={{fontSize:10,padding:"4px 10px",borderRadius:5,border:"1px dashed #33415a",background:"#1f2a3a",color:"#4a8bc4",cursor:"pointer"}}>
                + {cfg.label}
              </button>
            ))}
          </div>
          {/* Fee Calculator — switches between regular and in-house model for proposals */}
          {isProposal&&form.proposalFeeModel==="inh" ? <>
            <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Fee Calculator (In-House Model)</div>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:10,cursor:"pointer"}}>
              <input type="checkbox" checked={form.inhEngagementModel==="inh-partial-contingency"} onChange={e=>setF("inhEngagementModel",e.target.checked?"inh-partial-contingency":"inh-pre-only")} style={{accentColor:"#6b8e23"}}/>
              Partial Contingency
            </label>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Pricing Tier</label>
            <select value={form.inhPricingTier} onChange={e=>setF("inhPricingTier",e.target.value)}
              style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,marginBottom:10,outline:"none"}}>
              {Object.entries(TIER_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
            {form.inhPricingTier==="custom"&&(
              <div style={{marginBottom:10,marginTop:-4}}>
                <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Custom Fee Amount ($)</label>
                <input value={form.inhCustomFee||""} onChange={e=>setF("inhCustomFee",e.target.value)} placeholder="e.g. 11,000"
                  style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
            )}
            {form.inhEngagementModel==="inh-partial-contingency"&&(
              <div style={{marginBottom:10,marginTop:-4}}>
                <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Contingency Fee ($)</label>
                <input value={form.inhCustomContingencyFee||""} onChange={e=>setF("inhCustomContingencyFee",e.target.value)} placeholder="e.g. 3,500"
                  style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
            )}
            <div style={{background:"#111a24",border:"1px solid #2b3a4d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#4a8bc4",marginBottom:8}}>Fee Summary</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                <span>Upfront Fee</span><span style={{color:"#fff",fontWeight:600}}>{form.inhPricingTier==="discounted"&&inhFees.discount>0?<><span style={{textDecoration:"line-through",color:"#666",marginRight:6}}>{fmt(inhFees.baseUpfront)}</span>{fmt(inhFees.upfront)}</>:fmt(inhFees.upfront)}</span>
              </div>
              {form.inhPricingTier==="discounted"&&inhFees.discount>0&&(
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#e8bd6d",marginBottom:4}}>
                  <span>Early Signing Discount</span><span style={{fontWeight:600}}>−{fmt(inhFees.discount)}</span>
                </div>
              )}
              {inhFees.contingent!==null&&(
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                  <span>Contingent Fee (on award)</span><span style={{color:"#fff",fontWeight:600}}>{fmt(inhFees.contingent)}</span>
                </div>
              )}
              <div style={{borderTop:"1px solid #2b3a4d",marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
                <span style={{color:"#6b8e23"}}>Total</span><span style={{color:"#6b8e23"}}>{fmt(inhFees.total)}</span>
              </div>
            </div>
            {form.inhPricingTier==="discounted"&&(
              <div style={{background:"#33260a",border:"1px solid #e8bd6d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#e8bd6d",marginBottom:10}}>Early Signing Discount</div>
                <div style={{marginBottom:8}}>
                  <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Sign-By Date</label>
                  <input value={form.inhEarlySigningDate} onChange={e=>setF("inhEarlySigningDate",e.target.value)} placeholder="March 15, 2026"
                    style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Discount Amount ($)</label>
                  <input value={form.inhEarlySigningAmount} onChange={e=>setF("inhEarlySigningAmount",e.target.value)} placeholder="1,500"
                    style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                </div>
                {inhFees.discount>0&&<div style={{fontSize:11,color:"#e8bd6d",marginTop:8,fontWeight:700}}>Discounted fee: {fmt(inhFees.upfront)} (saves {fmt(inhFees.discount)})</div>}
              </div>
            )}
          </> : <>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Fee Calculator</div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:10,cursor:"pointer"}}>
            <input type="checkbox" checked={form.engagementModel==="partial-contingency"} onChange={e=>setF("engagementModel",e.target.checked?"partial-contingency":"pre-only")} style={{accentColor:"#6b8e23"}}/>
            Partial Contingency
          </label>
          <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Pricing Tier</label>
          <select value={form.pricingTier} onChange={e=>setF("pricingTier",e.target.value)}
            style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,marginBottom:10,outline:"none"}}>
            {Object.entries(TIER_LABELS).filter(([k])=>k!=="max").map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          {form.pricingTier==="custom"&&(
            <div style={{marginBottom:10,marginTop:-4,paddingLeft:0}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Custom Fee Amount ($)</label>
              <input value={form.customFee||""} onChange={e=>setF("customFee",e.target.value)} placeholder="e.g. 5,000"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          {form.engagementModel==="partial-contingency"&&(
            <div style={{marginBottom:10,marginTop:-4}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Contingency Fee ($)</label>
              <input value={form.customContingencyFee||""} onChange={e=>setF("customContingencyFee",e.target.value)} placeholder="e.g. 3,500"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          {/* Fee summary card */}
          <div style={{background:"#111a24",border:"1px solid #2b3a4d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#4a8bc4",marginBottom:8}}>Fee Summary</div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
              <span>Upfront Fee</span><span style={{color:"#fff",fontWeight:600}}>{form.pricingTier==="discounted"&&fees.discount>0?<><span style={{textDecoration:"line-through",color:"#666",marginRight:6}}>{fmt(fees.baseUpfront)}</span>{fmt(fees.upfront)}</>:fmt(fees.upfront)}</span>
            </div>
            {form.pricingTier==="discounted"&&fees.discount>0&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#e8bd6d",marginBottom:4}}>
                <span>Early Signing Discount</span><span style={{fontWeight:600}}>−{fmt(fees.discount)}</span>
              </div>
            )}
            {fees.contingent!==null&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                <span>Contingent Fee (on award)</span><span style={{color:"#fff",fontWeight:600}}>{fmt(fees.contingent)}</span>
              </div>
            )}
            {form.optPostAwardScope&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                <span>Compliance Consulting Fee{numLocs>1?` ×${numLocs}`:""}</span><span style={{color:"#fff",fontWeight:600}}>{fmt(fees.postAward)}</span>
              </div>
            )}
            <div style={{borderTop:"1px solid #2b3a4d",marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
              <span style={{color:"#6b8e23"}}>Total</span><span style={{color:"#6b8e23"}}>{fmt(fees.total)}</span>
            </div>
          </div>
          {form.pricingTier==="discounted"&&(
            <div style={{background:"#33260a",border:"1px solid #e8bd6d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#e8bd6d",marginBottom:10}}>Early Signing Discount</div>
              <div style={{marginBottom:8}}>
                <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Sign-By Date</label>
                <input value={form.earlySigningDate} onChange={e=>setF("earlySigningDate",e.target.value)} placeholder="March 15, 2026"
                  style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Discount Amount ($)</label>
                <input value={form.earlySigningAmount} onChange={e=>setF("earlySigningAmount",e.target.value)} placeholder="500"
                  style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
              {fees.discount>0&&<div style={{fontSize:11,color:"#e8bd6d",marginTop:8,fontWeight:700}}>Discounted fee: {fmt(fees.upfront)} (saves {fmt(fees.discount)})</div>}
            </div>
          )}
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:form.optPostAwardScope?4:10,cursor:"pointer"}}>
            <input type="checkbox" checked={form.optPostAwardScope} onChange={e=>setF("optPostAwardScope",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Compliance Consulting
          </label>
          {form.optPostAwardScope&&(
            <div style={{marginBottom:10,marginTop:0,paddingLeft:22}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Compliance Consulting Fee ($)</label>
              <input value={form.postAwardFee||""} onChange={e=>setF("postAwardFee",e.target.value)} placeholder="0"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:form.installments?10:14,cursor:"pointer"}}>
            <input type="checkbox" checked={form.installments} onChange={e=>setF("installments",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Allow installment payments
          </label>
          {form.installments&&(
            <div style={{background:"#111a24",border:"1px solid #2b3a4d",borderRadius:8,padding:"12px 14px",marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#6b8e23",marginBottom:10}}>Installment Schedule</div>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:4}}>Number of Payments</label>
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                {[2,3].map(n=>(
                  <button key={n} onClick={()=>setF("installmentCount",n)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:"1px solid",fontSize:12,fontWeight:700,cursor:"pointer",
                      background:form.installmentCount===n?"#1e3a5f":"#1f2a3a",
                      borderColor:form.installmentCount===n?"#4a8bc4":"#2b3a4d",
                      color:form.installmentCount===n?"#fff":"#8796aa"}}>
                    {n} Payments
                  </button>
                ))}
              </div>
              {[
                {pctKey:"installment1Pct",labelKey:"installment1Label",num:1},
                {pctKey:"installment2Pct",labelKey:"installment2Label",num:2},
                {pctKey:"installment3Pct",labelKey:"installment3Label",num:3,cond:form.installmentCount>=3},
              ].filter(r=>r.cond!==false).map(row=>{
                const pct = parseFloat(form[row.pctKey]) || 0;
                const amt = Math.round(fees.upfront * pct / 100);
                return (
                  <div key={row.num} style={{marginBottom:10,paddingBottom:10,borderBottom:"1px solid #1e3050"}}>
                    <div style={{fontSize:10,color:"#4a8bc4",fontWeight:700,marginBottom:5}}>Payment {row.num}</div>
                    <div style={{display:"flex",gap:6,marginBottom:5}}>
                      <div style={{flex:"0 0 70px"}}>
                        <label style={{fontSize:10,color:"#a09a8c",display:"block",marginBottom:2}}>%</label>
                        <input value={form[row.pctKey]} onChange={e=>setF(row.pctKey,e.target.value)} placeholder="50"
                          style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                      </div>
                      <div style={{flex:1}}>
                        <label style={{fontSize:10,color:"#a09a8c",display:"block",marginBottom:2}}>Due When</label>
                        <input value={form[row.labelKey]} onChange={e=>setF(row.labelKey,e.target.value)} placeholder="upon execution"
                          style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                      </div>
                    </div>
                    {fees.upfront>0&&pct>0&&<div style={{fontSize:10,color:"#a8c860"}}>= {fmt(amt)}</div>}
                  </div>
                );
              })}
              {fees.upfront>0&&(()=>{
                const total = [form.installment1Pct,form.installment2Pct,form.installmentCount>=3?form.installment3Pct:"0"].slice(0,form.installmentCount).reduce((s,v)=>s+(parseFloat(v)||0),0);
                const ok = Math.abs(total-100)<0.01;
                return <div style={{fontSize:11,fontWeight:700,color:ok?"#a8c860":"#f0a08c",marginTop:4}}>{ok?"Percentages total 100%":`Total: ${total}% (must equal 100%)`}</div>;
              })()}
            </div>
          )}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Optional Guarantees</div>
          {[{key:"optNofo",label:"No NOFO"},{key:"optStateSwitch",label:"State NSGP Switch Option"}].map(o=>(
            <label key={o.key} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:9,cursor:"pointer"}}>
              <input type="checkbox" checked={form[o.key]} onChange={e=>setF(o.key,e.target.checked)} style={{accentColor:"#6b8e23"}}/>
              {o.label}
            </label>
          ))}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Optional Clauses</div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:9,cursor:"pointer"}}>
            <input type="checkbox" checked={form.optShortNotice} onChange={e=>setF("optShortNotice",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Short-notice application
          </label>
          </>}
        </>}
        {/* In-House Pre-Award specific */}
        {isInh&&<>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Grant Programs</div>
          {(form.programs||[]).map((pg,pgIdx)=>{
            const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
            return (
              <div key={pgIdx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 8px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:11,color:"#4a8bc4",fontWeight:700}}>{cfg.label}</span>
                  {(form.programs||[]).length>1&&<button onClick={()=>setF("programs",(form.programs||[]).filter((_,i)=>i!==pgIdx))}
                    style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>}
                </div>
                <div style={{marginBottom:6}}>
                  <label style={{fontSize:10,color:"#8796aa",display:"block",marginBottom:2}}>Grant Year</label>
                  <input value={pg.year||"2026"} onChange={e=>{
                    const updated=[...(form.programs||[])];
                    updated[pgIdx]={...updated[pgIdx],year:e.target.value};
                    setF("programs",updated);
                  }} placeholder="2026"
                    style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
                </div>
                <div style={{fontSize:10,color:"#8796aa",marginBottom:3}}>Max Award: <span style={{color:"#6b8e23"}}>${cfg.maxAward}</span></div>
                <div style={{fontSize:10,color:"#8796aa"}}>Applications: <span style={{color:"#fff",fontWeight:700}}>{(form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length}</span></div>
              </div>
            );
          })}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
            {Object.entries(PROGRAMS).filter(([k])=>!(form.programs||[]).some(p=>p.key===k)).map(([k,cfg])=>(
              <button key={k} onClick={()=>setF("programs",[...(form.programs||[]),{key:k,year:form.grantYear||"2026"}])}
                style={{fontSize:10,padding:"4px 10px",borderRadius:5,border:"1px dashed #33415a",background:"#1f2a3a",color:"#4a8bc4",cursor:"pointer"}}>
                + {cfg.label}
              </button>
            ))}
          </div>
          {/* In-House Fee Calculator */}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Fee Calculator</div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:10,cursor:"pointer"}}>
            <input type="checkbox" checked={form.inhEngagementModel==="inh-partial-contingency"} onChange={e=>setF("inhEngagementModel",e.target.checked?"inh-partial-contingency":"inh-pre-only")} style={{accentColor:"#6b8e23"}}/>
            Partial Contingency
          </label>
          <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Pricing Tier</label>
          <select value={form.inhPricingTier} onChange={e=>setF("inhPricingTier",e.target.value)}
            style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,marginBottom:10,outline:"none"}}>
            {Object.entries(TIER_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          {form.inhPricingTier==="custom"&&(
            <div style={{marginBottom:10,marginTop:-4}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Custom Fee Amount ($)</label>
              <input value={form.inhCustomFee||""} onChange={e=>setF("inhCustomFee",e.target.value)} placeholder="e.g. 5,000"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          {form.inhEngagementModel==="inh-partial-contingency"&&(
            <div style={{marginBottom:10,marginTop:-4}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Contingency Fee ($)</label>
              <input value={form.inhCustomContingencyFee||""} onChange={e=>setF("inhCustomContingencyFee",e.target.value)} placeholder="e.g. 3,500"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #4a8bc4",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          {/* In-House Fee summary card */}
          <div style={{background:"#111a24",border:"1px solid #2b3a4d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#4a8bc4",marginBottom:8}}>Fee Summary</div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
              <span>Upfront Fee</span><span style={{color:"#fff",fontWeight:600}}>{form.inhPricingTier==="discounted"&&inhFees.discount>0?<><span style={{textDecoration:"line-through",color:"#666",marginRight:6}}>{fmt(inhFees.baseUpfront)}</span>{fmt(inhFees.upfront)}</>:fmt(inhFees.upfront)}</span>
            </div>
            {form.inhPricingTier==="discounted"&&inhFees.discount>0&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#e8bd6d",marginBottom:4}}>
                <span>Early Signing Discount</span><span style={{fontWeight:600}}>−{fmt(inhFees.discount)}</span>
              </div>
            )}
            {inhFees.contingent!==null&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                <span>Contingent Fee (on award)</span><span style={{color:"#fff",fontWeight:600}}>{fmt(inhFees.contingent)}</span>
              </div>
            )}
            {form.inhOptPostAwardScope&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a7b4c6",marginBottom:4}}>
                <span>Compliance Consulting Fee{numLocs>1?` ×${numLocs}`:""}</span><span style={{color:"#fff",fontWeight:600}}>{fmt(inhFees.postAward)}</span>
              </div>
            )}
            <div style={{borderTop:"1px solid #2b3a4d",marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
              <span style={{color:"#6b8e23"}}>Total</span><span style={{color:"#6b8e23"}}>{fmt(inhFees.total)}</span>
            </div>
          </div>
          {form.inhPricingTier==="discounted"&&(
            <div style={{background:"#33260a",border:"1px solid #e8bd6d",borderRadius:8,padding:"12px 14px",marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#e8bd6d",marginBottom:10}}>Early Signing Discount</div>
              <div style={{marginBottom:8}}>
                <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Sign-By Date</label>
                <input value={form.inhEarlySigningDate} onChange={e=>setF("inhEarlySigningDate",e.target.value)} placeholder="March 15, 2026"
                  style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"#c9a227",display:"block",marginBottom:2}}>Discount Amount ($)</label>
                <input value={form.inhEarlySigningAmount} onChange={e=>setF("inhEarlySigningAmount",e.target.value)} placeholder="1,500"
                  style={{width:"100%",background:"#33260a",border:"1px solid #e8bd6d",borderRadius:6,padding:"6px 10px",color:"#fbf3e2",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              </div>
              {inhFees.discount>0&&<div style={{fontSize:11,color:"#e8bd6d",marginTop:8,fontWeight:700}}>Discounted fee: {fmt(inhFees.upfront)} (saves {fmt(inhFees.discount)})</div>}
            </div>
          )}
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:form.inhOptPostAwardScope?4:10,cursor:"pointer"}}>
            <input type="checkbox" checked={form.inhOptPostAwardScope} onChange={e=>setF("inhOptPostAwardScope",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Compliance Consulting
          </label>
          {form.inhOptPostAwardScope&&(
            <div style={{marginBottom:10,marginTop:0,paddingLeft:22}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Compliance Consulting Fee ($)</label>
              <input value={form.inhPostAwardFee||""} onChange={e=>setF("inhPostAwardFee",e.target.value)} placeholder="0"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:form.inhInstallments?10:14,cursor:"pointer"}}>
            <input type="checkbox" checked={form.inhInstallments} onChange={e=>setF("inhInstallments",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Allow installment payments
          </label>
          {form.inhInstallments&&(
            <div style={{background:"#111a24",border:"1px solid #2b3a4d",borderRadius:8,padding:"12px 14px",marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#6b8e23",marginBottom:10}}>Installment Schedule</div>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:4}}>Number of Payments</label>
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                {[2,3].map(n=>(
                  <button key={n} onClick={()=>setF("inhInstallmentCount",n)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:"1px solid",fontSize:12,fontWeight:700,cursor:"pointer",
                      background:form.inhInstallmentCount===n?"#1e3a5f":"#1f2a3a",
                      borderColor:form.inhInstallmentCount===n?"#4a8bc4":"#2b3a4d",
                      color:form.inhInstallmentCount===n?"#fff":"#8796aa"}}>
                    {n} Payments
                  </button>
                ))}
              </div>
              {[
                {pctKey:"inhInstallment1Pct",labelKey:"inhInstallment1Label",num:1},
                {pctKey:"inhInstallment2Pct",labelKey:"inhInstallment2Label",num:2},
                {pctKey:"inhInstallment3Pct",labelKey:"inhInstallment3Label",num:3,cond:form.inhInstallmentCount>=3},
              ].filter(r=>r.cond!==false).map(row=>{
                const pct = parseFloat(form[row.pctKey]) || 0;
                const amt = Math.round(inhFees.upfront * pct / 100);
                return (
                  <div key={row.num} style={{marginBottom:10,paddingBottom:10,borderBottom:"1px solid #1e3050"}}>
                    <div style={{fontSize:10,color:"#4a8bc4",fontWeight:700,marginBottom:5}}>Payment {row.num}</div>
                    <div style={{display:"flex",gap:6,marginBottom:5}}>
                      <div style={{flex:"0 0 70px"}}>
                        <label style={{fontSize:10,color:"#a09a8c",display:"block",marginBottom:2}}>%</label>
                        <input value={form[row.pctKey]} onChange={e=>setF(row.pctKey,e.target.value)} placeholder="50"
                          style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                      </div>
                      <div style={{flex:1}}>
                        <label style={{fontSize:10,color:"#a09a8c",display:"block",marginBottom:2}}>Due When</label>
                        <input value={form[row.labelKey]} onChange={e=>setF(row.labelKey,e.target.value)} placeholder="upon execution"
                          style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                      </div>
                    </div>
                    {inhFees.upfront>0&&pct>0&&<div style={{fontSize:10,color:"#a8c860"}}>= {fmt(amt)}</div>}
                  </div>
                );
              })}
              {inhFees.upfront>0&&(()=>{
                const total = [form.inhInstallment1Pct,form.inhInstallment2Pct,form.inhInstallmentCount>=3?form.inhInstallment3Pct:"0"].slice(0,form.inhInstallmentCount).reduce((s,v)=>s+(parseFloat(v)||0),0);
                const ok = Math.abs(total-100)<0.01;
                return <div style={{fontSize:11,fontWeight:700,color:ok?"#a8c860":"#f0a08c",marginTop:4}}>{ok?"Percentages total 100%":`Total: ${total}% (must equal 100%)`}</div>;
              })()}
            </div>
          )}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Optional Guarantees</div>
          {[{key:"inhOptNofo",label:"No NOFO"},{key:"inhOptStateSwitch",label:"State NSGP Switch Option"}].map(o=>(
            <label key={o.key} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:9,cursor:"pointer"}}>
              <input type="checkbox" checked={form[o.key]} onChange={e=>setF(o.key,e.target.checked)} style={{accentColor:"#6b8e23"}}/>
              {o.label}
            </label>
          ))}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Optional Clauses</div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#a7b4c6",marginBottom:9,cursor:"pointer"}}>
            <input type="checkbox" checked={form.inhOptShortNotice} onChange={e=>setF("inhOptShortNotice",e.target.checked)} style={{accentColor:"#6b8e23"}}/>
            Short-notice application
          </label>
        </>}
        {/* Post-award grant program selector */}
        {!isPre&&!isGw&&!isInh&&!isProposal&&!isAddendum&&<>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Grant Programs</div>
          {postPrograms.map((pg,pgIdx)=>{
            const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
            return (
              <div key={pgIdx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 12px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontSize:11,color:"#4a8bc4",fontWeight:700}}>{cfg.label}</span>
                  {postPrograms.length>1&&<button onClick={()=>setF("postPrograms",postPrograms.filter((_,i)=>i!==pgIdx))}
                    style={{background:"none",border:"none",color:"#e05050",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>×</button>}
                </div>
                <label style={{fontSize:10,color:"#8796aa",display:"block",marginBottom:2}}>Award Year</label>
                <input value={pg.year||String(new Date().getFullYear())} onChange={e=>{
                  const updated=[...postPrograms];
                  updated[pgIdx]={...updated[pgIdx],year:e.target.value};
                  setF("postPrograms",updated);
                }} style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:4,padding:"5px 8px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
                <div style={{fontSize:10,color:"#8796aa",marginTop:4}}>Max Award: <span style={{color:"#6b8e23"}}>${cfg.maxAward}</span></div>
              </div>
            );
          })}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:10}}>
            {Object.entries(PROGRAMS).filter(([k])=>!postPrograms.some(p=>p.key===k)).map(([k,cfg])=>(
              <button key={k} onClick={()=>setF("postPrograms",[...postPrograms,{key:k,year:postPrograms[0]?.year||String(new Date().getFullYear())}])}
                style={{fontSize:10,padding:"4px 10px",borderRadius:5,border:"1px dashed #33415a",background:"#1f2a3a",color:"#4a8bc4",cursor:"pointer"}}>
                + {cfg.label}
              </button>
            ))}
          </div>
        </>}
        {/* Post-award fields */}
        {!isPre&&!isGw&&!isInh&&!isProposal&&!isAddendum&&POST_FIELDS.map((f2,i)=>{
          if(f2.section) return <div key={i} style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>{f2.section}</div>;
          return (
            <div key={f2.key} style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>{f2.label}</label>
              {f2.type==="select"
                ? <select value={form[f2.key]||""} onChange={e=>setF(f2.key,e.target.value)}
                    style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}>
                    {f2.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                : <input type={f2.type||"text"} value={form[f2.key]||""} onChange={e=>setF(f2.key,e.target.value)} placeholder={f2.placeholder||""}
                    style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none",colorScheme:"dark"}}/>
              }
            </div>
          );
        })}
        {/* Post-award: Reimbursement Option A/B */}
        {!isPre&&!isGw&&!isInh&&!isProposal&&!isAddendum&&(
          <>
            <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Reimbursement Expectation</div>
            {!form.postReimbursementOption&&(
              <div style={{fontSize:11,color:"#f0a08c",marginBottom:8}}>⚠ Rep must select Option A or Option B</div>
            )}
            {[
              {val:"optionA", label:"Option A — Reimbursement Expected", desc:"M&A fees may be reimbursed through grant funds (timing may differ)"},
              {val:"optionB", label:"Option B — No Grant Reimbursement", desc:"M&A fees are not reimbursable through grant proceeds"},
            ].map(opt=>(
              <label key={opt.val} onClick={()=>setF("postReimbursementOption",opt.val)}
                style={{display:"flex",alignItems:"flex-start",gap:10,fontSize:12,color:form.postReimbursementOption===opt.val?"#fff":"#a7b4c6",marginBottom:8,cursor:"pointer",background:form.postReimbursementOption===opt.val?"#1e3a5f":"#1a2540",border:`1px solid ${form.postReimbursementOption===opt.val?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"8px 10px"}}>
                <input type="radio" name="postReimbursementOption" value={opt.val} checked={form.postReimbursementOption===opt.val} onChange={()=>setF("postReimbursementOption",opt.val)} style={{accentColor:"#4a8bc4",marginTop:3,flexShrink:0}}/>
                <div>
                  <div style={{fontWeight:700}}>{opt.label}</div>
                  <div style={{fontSize:10,color:"#8796aa",marginTop:2}}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </>
        )}
        {/* Grant Writer sidebar fields */}
        {isGw&&<>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:4,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Grant Writer</div>
          {[{key:"gwRecipientName",label:"Grant Writer Name",placeholder:"Name"},{key:"gwRecipientEmail",label:"Grant Writer Email",placeholder:"email@example.com"},{key:"gwOrgName",label:"Organization",placeholder:"Organization"}].map(f2=>(
            <div key={f2.key} style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>{f2.label}</label>
              <input value={form[f2.key]||""} onChange={e=>setF(f2.key,e.target.value)} placeholder={f2.placeholder}
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          ))}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Grant Program(s)</div>
          {(form.gwPrograms||[]).map((pg,pgIdx)=>{
            const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
            return (
              <div key={pgIdx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 8px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:11,color:"#4a8bc4",fontWeight:700}}>{cfg.label}</span>
                  {(form.gwPrograms||[]).length>1&&<button onClick={()=>setF("gwPrograms",(form.gwPrograms||[]).filter((_,i)=>i!==pgIdx))}
                    style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>}
                </div>
                <label style={{fontSize:10,color:"#8796aa",display:"block",marginBottom:2}}>Grant Year</label>
                <input value={pg.year||""} onChange={e=>{
                  const updated=[...(form.gwPrograms||[])];
                  updated[pgIdx]={...updated[pgIdx],year:e.target.value};
                  setF("gwPrograms",updated);
                }} placeholder="2026"
                  style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
                <div style={{fontSize:10,color:"#8796aa",marginTop:5}}>Max Award: <span style={{color:"#6b8e23"}}>${cfg.maxAward}</span></div>
              </div>
            );
          })}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
            {Object.entries(PROGRAMS).filter(([k])=>!(form.gwPrograms||[]).some(p=>p.key===k)).map(([k,cfg])=>(
              <button key={k} onClick={()=>{
                setF("gwPrograms",[...(form.gwPrograms||[]),{key:k,year:(form.gwPrograms||[])[0]?.year||"2026"}]);
              }} style={{fontSize:10,padding:"4px 10px",borderRadius:5,border:"1px dashed #33415a",background:"#1f2a3a",color:"#4a8bc4",cursor:"pointer"}}>
                + {cfg.label}
              </button>
            ))}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Requesting NPSA Consultant</div>
          <div style={{fontSize:11,color:"#a09a8c",marginBottom:6}}>Select consultant</div>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
            {[
              {name:"Brad Lynde",     email:"brad@lyndeconsulting.com",           phone:"815-255-9556"},
              {name:"Chad Burgess",   email:"chad@nonprofitsecurityadvisors.com",  phone:"815-287-9339"},
              {name:"Josh Ullrich",   email:"josh@nonprofitsecurityadvisors.com",  phone:"815-608-3131"},
              {name:"Steven Timlick", email:"steven@nonprofitsecurityadvisors.com",phone:"815-255-9141"},
              {name:"Stuart Reese",   email:"stuart@nonprofitsecurityadvisors.com",phone:"815-550-5222"},
            ].map(rep=>{
              const active = form.npsa1Name===rep.name;
              return (
                <button key={rep.name} onClick={()=>{
                  setF("npsa1Name", rep.name);
                  setF("npsa1Email", rep.email);
                  setF("npsa1Phone", rep.phone);
                }}
                  style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
                  <span style={{fontWeight:active?700:400}}>{rep.name}</span>
                </button>
              );
            })}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>CC Contacts</div>
          {(form.gwCcContacts||[]).map((cc,idx)=>(
            <div key={idx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 6px",marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:11,color:"#8796aa",fontWeight:700}}>Contact {idx+1}</span>
                <button onClick={()=>setF("gwCcContacts",(form.gwCcContacts||[]).filter((_,i)=>i!==idx))}
                  style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>
              </div>
              {[{k:"name",ph:"Name"},{k:"title",ph:"Title"},{k:"phone",ph:"Phone"},{k:"email",ph:"Email"}].map(f2=>(
                <div key={f2.k} style={{marginBottom:6}}>
                  <input value={cc[f2.k]||""} placeholder={f2.ph}
                    onChange={e=>{
                      const updated=[...(form.gwCcContacts||[])];
                      updated[idx]={...updated[idx],[f2.k]:e.target.value};
                      setF("gwCcContacts",updated);
                    }}
                    style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
                </div>
              ))}
            </div>
          ))}
          <button onClick={()=>setF("gwCcContacts",[...(form.gwCcContacts||[]),{name:"",title:"",phone:"",email:""}])}
            style={{width:"100%",background:"#1f2a3a",border:"1px dashed #33415a",borderRadius:6,padding:"7px 0",fontSize:11,color:"#4a8bc4",cursor:"pointer",marginBottom:14}}>
            + Add CC Contact
          </button>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Additional Meeting Attendees</div>
          <div style={{fontSize:11,color:"#8796aa",marginBottom:8,lineHeight:1.5}}>
            Organization contacts are auto-populated from above (primary contact + all CC contacts).
          </div>
          {(()=>{
            const orgAttendees = [
              form.contactName ? {name:form.contactName, email:form.contactEmail} : null,
              ...(form.gwCcContacts||[]).filter(c=>c.name).map(c=>({name:c.name,email:c.email})),
            ].filter(Boolean);
            if(!orgAttendees.length) return <div style={{fontSize:11,color:"#8796aa",fontStyle:"italic",marginBottom:10}}>Fill in client info above to see attendees here.</div>;
            return <div style={{background:"#111d33",borderRadius:6,padding:"8px 10px",marginBottom:10}}>
              {orgAttendees.map((a,i)=>(
                <div key={i} style={{fontSize:11,color:"#a7b4c6",marginBottom:3}}>• {a.name}{a.email?` — ${a.email}`:""}</div>
              ))}
            </div>;
          })()}
          <div style={{fontSize:11,color:"#a09a8c",marginBottom:6}}>Add Steven and/or Stuart to the meeting</div>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:14}}>
            {[
              {name:"Steven Timlick", email:"steven@nonprofitsecurityadvisors.com", phone:"815-255-9141"},
              {name:"Stuart Reese",   email:"stuart@nonprofitsecurityadvisors.com",  phone:"815-550-5222"},
            ].map(rep=>{
              const isPrimary = form.npsa1Name===rep.name;
              if(isPrimary) return null;
              const selected = (form.npsa2Selected||[]).some(r=>r.name===rep.name);
              return (
                <button key={rep.name} onClick={()=>{
                  const cur = form.npsa2Selected||[];
                  if(selected){ setF("npsa2Selected", cur.filter(r=>r.name!==rep.name)); }
                  else { setF("npsa2Selected", [...cur, {name:rep.name,email:rep.email,phone:rep.phone}]); }
                }}
                  style={{textAlign:"left",background:selected?"#1e3a5f":"#1f2a3a",border:`1px solid ${selected?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:selected?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
                  <span style={{fontWeight:selected?700:400}}>{selected?"[x] ":""}{rep.name}</span>
                </button>
              );
            })}
          </div>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Contract Terms</div>
          {[{key:"gwProfFee",label:"Professional Fee ($)",placeholder:"$$$"},{key:"gwPaymentTerms",label:"Payment Terms",placeholder:"Net 30"}].map(f2=>(
            <div key={f2.key} style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>{f2.label}</label>
              <input value={form[f2.key]||""} onChange={e=>setF(f2.key,e.target.value)} placeholder={f2.placeholder}
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
              {f2.key==="gwProfFee"&&(
                <div style={{background:"#111d33",border:"1px solid #26313f",borderRadius:6,padding:"8px 10px",marginTop:6}}>
                  <div style={{fontSize:10,color:"#8796aa",marginBottom:4}}>Reference — grant writer fee (NPSA pricing sheet):</div>
                  <div style={{fontSize:10,color:"#a7b4c6",lineHeight:1.6}}>
                    <div>Undiscounted: 1 loc $7,000 · 2 loc $10,000 · 3 loc $13,000</div>
                    <div>Discounted: 1 loc $6,000 · 2 loc $8,000 · 3 loc $10,000</div>
                  </div>
                  <div style={{fontSize:9,color:"#8796aa",marginTop:4,fontStyle:"italic"}}>Final fee is set by the grant writer's independent contract.</div>
                </div>
              )}
            </div>
          ))}
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:12,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Guarantee Structure</div>
          {[
            {key:"gwGuar1", label:"1. One additional application at no additional fee if not awarded", locked:false, note:null},
            {key:"gwGuar2", label:"2. If no NOFO: apply work or refund within 10 business days",      locked:false, note:form.optNofo?"Auto-selected: No NOFO is on":null},
            {key:"gwGuar3", label:"3. If no NOFO: apply work to next available opportunity",           locked:false, note:form.optNofo?"Deselected: No NOFO is on":null},
            {key:"gwGuar4", label:"4. Commercially reasonable efforts to meet deadline",               locked:false, note:form.optShortNotice?"Auto-selected: Short-notice is on":null},
          ].map(o=>(
            <label key={o.key} style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:12,color:o.locked?"#4a8bc4":"#a7b4c6",marginBottom:8,cursor:o.locked?"default":"pointer",lineHeight:1.4,opacity:o.locked?0.8:1}}>
              <input type="checkbox" checked={form[o.key]} onChange={e=>!o.locked&&setF(o.key,e.target.checked)} disabled={o.locked} style={{accentColor:"#6b8e23",marginTop:2,flexShrink:0}}/>
              <span>
                {o.label}
                {o.locked&&<span style={{fontSize:10,color:"#4a8bc4",marginLeft:6,fontStyle:"italic"}}>(always on)</span>}
                {o.note&&<span style={{fontSize:10,color:"#e8bd6d",display:"block",marginTop:1}}>{o.note}</span>}
              </span>
            </label>
          ))}
          {form.gwGuar4&&(
            <div style={{marginBottom:10,marginTop:-4,paddingLeft:20}}>
              <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Deadline</label>
              <input value={form.gwGuar4Deadline||""} onChange={e=>setF("gwGuar4Deadline",e.target.value)} placeholder="e.g. March 15, 2026"
                style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            </div>
          )}
          <div style={{fontSize:10,color:"#8796aa",fontStyle:"italic",marginTop:2,marginBottom:10,lineHeight:1.5}}>Note: Options 2 and 3 are mutually exclusive. Option 4 cannot be selected with 2 or 3.</div>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Additional Notes for Grant Writer</div>
          <textarea value={form.gwNotes||""} onChange={e=>setF("gwNotes",e.target.value)}
            placeholder="e.g. Background, site details, upsell notes, context from sales rep..."
            rows={5}
            style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"7px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",resize:"vertical",outline:"none",lineHeight:1.6}}/>
        </>}
        {/* Addendum sidebar */}
        {isAddendum&&<>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Addendum Details</div>
          <div style={{fontSize:11,color:"#8796aa",marginBottom:10,lineHeight:1.5}}>
            Removes premature Implementation Period (post-award M&amp;A) services from a previously signed engagement letter.
          </div>
          <div style={{marginBottom:10}}>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Client Name (on original agreement)</label>
            <input value={form.addendumClientName||""} onChange={e=>setF("addendumClientName",e.target.value)} placeholder={form.clientName||"e.g. Cornerstone Family Church"}
              style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            <div style={{fontSize:10,color:"#8796aa",marginTop:3}}>Leave blank to use the Organization Name above.</div>
          </div>
          <div style={{marginBottom:10}}>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Original Agreement Date</label>
            <input type="date" value={form.addendumOriginalDate||""} onChange={e=>setF("addendumOriginalDate",e.target.value)}
              style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
          </div>
          <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>Programs Affected</div>
          <div style={{fontSize:11,color:"#8796aa",marginBottom:8,lineHeight:1.5}}>Which program(s) does this removal apply to?</div>
          {(form.addendumPrograms||[]).map((pg,pgIdx)=>{
            const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
            return (
              <div key={pgIdx} style={{background:"#16202e",border:"1px solid #2b3a4d",borderRadius:6,padding:"10px 10px 8px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:11,color:"#4a8bc4",fontWeight:700}}>{cfg.label}</span>
                  {(form.addendumPrograms||[]).length>1&&<button onClick={()=>setF("addendumPrograms",(form.addendumPrograms||[]).filter((_,i)=>i!==pgIdx))}
                    style={{background:"none",border:"none",color:"#f0a08c",fontSize:13,cursor:"pointer",padding:"0 2px",lineHeight:1}}>x</button>}
                </div>
                <label style={{fontSize:10,color:"#8796aa",display:"block",marginBottom:2}}>Grant Year</label>
                <input value={pg.year||""} onChange={e=>{
                  const updated=[...(form.addendumPrograms||[])];
                  updated[pgIdx]={...updated[pgIdx],year:e.target.value};
                  setF("addendumPrograms",updated);
                }} placeholder={String(new Date().getFullYear())}
                  style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"5px 8px",color:"#e8edf4",fontSize:11,boxSizing:"border-box",outline:"none"}}/>
              </div>
            );
          })}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
            {Object.entries(PROGRAMS).filter(([k])=>!(form.addendumPrograms||[]).some(p=>p.key===k)).map(([k,cfg])=>(
              <button key={k} onClick={()=>{
                setF("addendumPrograms",[...(form.addendumPrograms||[]),{key:k,year:String(new Date().getFullYear())}]);
              }} style={{fontSize:10,padding:"4px 10px",borderRadius:5,border:"1px dashed #33415a",background:"#1f2a3a",color:"#4a8bc4",cursor:"pointer"}}>
                + {cfg.label}
              </button>
            ))}
          </div>
        </>}
        {/* AI Clause + NPSA signer — hidden on Grant Writer and Proposal tabs */}
        {!isGw&&!isProposal&&<>
        {/* AI Custom Clause — letters only (not addendum) */}
        {!isAddendum&&<>
        <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>AI Custom Clause</div>
        <textarea value={isPre?form.customClause:form.postCustomClause} onChange={e=>setF(isPre?"customClause":"postCustomClause",e.target.value)}
          placeholder="Describe a clause in plain language..." rows={3}
          style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"7px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",resize:"vertical",outline:"none"}}/>
        <button onClick={()=>polish(isPre?form.customClause:form.postCustomClause,r=>setF(isPre?"polishedClause":"postPolishedClause",r))}
          disabled={loading||(isPre?!form.customClause.trim():!form.postCustomClause.trim())}
          style={{marginTop:7,width:"100%",background:loading?"#2b3a4d":"#1e3a5f",color:"#fff",border:"none",borderRadius:6,padding:"7px 0",fontSize:12,fontWeight:600,cursor:loading?"default":"pointer"}}>
          {loading?"Polishing...":"Polish with AI"}
        </button>
        {(isPre?form.polishedClause:form.postPolishedClause)&&(
          <div style={{marginTop:9,background:"#1e3a2f",border:"1px solid #2d5c42",borderRadius:6,padding:10,fontSize:11,color:"#a8c860",lineHeight:1.6}}>
            <div style={{fontSize:10,color:"#4caf7d",marginBottom:3,fontWeight:700}}>POLISHED CLAUSE — PENDING APPROVAL</div>
            {isPre?form.polishedClause:form.postPolishedClause}
            <button onClick={()=>setMgmtApprovalModal(true)}
              style={{marginTop:10,width:"100%",background:"#1a4a2e",color:"#a8c860",border:"1px solid #2d5c42",borderRadius:6,padding:"7px 0",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              Insert into Document
            </button>
          </div>
        )}
        </>}
        <div style={{fontSize:10,fontWeight:700,color:"#8796aa",letterSpacing:1,textTransform:"uppercase",marginTop:16,marginBottom:7,borderBottom:"1px solid #26313f",paddingBottom:5}}>NPSA Authorized Signer</div>
        <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
          {(()=>{
            const active = form.npsaSignerName==="Brad Lynde";
            return <button key="Brad Lynde" onClick={()=>{setF("npsaSignerName","Brad Lynde");setF("npsaSignerTitle","Managing Partner");}}
              style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
              <span style={{fontWeight:active?700:400}}>Brad Lynde</span>
              <span style={{fontSize:10,color:active?"#a7b4c6":"#8796aa",marginLeft:6}}>Managing Partner</span>
            </button>;
          })()}
          {(()=>{
            const active = form.npsaSignerName==="Chad Burgess";
            return <button key="Chad Burgess" onClick={()=>setSignerApprovalModal({name:"Chad Burgess",title:"Associate | Business Development & Consulting"})}
              style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
              <span style={{fontWeight:active?700:400}}>Chad Burgess</span>
              <span style={{fontSize:10,color:active?"#a7b4c6":"#8796aa",marginLeft:6}}>Associate | Business Development & Consulting</span>
            </button>;
          })()}
          {(()=>{
            const active = form.npsaSignerName==="Josh Ullrich";
            return <button key="Josh Ullrich" onClick={()=>setSignerApprovalModal({name:"Josh Ullrich",title:"Business Development Partner"})}
              style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
              <span style={{fontWeight:active?700:400}}>Josh Ullrich</span>
              <span style={{fontSize:10,color:active?"#a7b4c6":"#8796aa",marginLeft:6}}>Business Development Partner</span>
            </button>;
          })()}
          {(()=>{
            const active = form.npsaSignerName==="Steven Timlick";
            return <button key="Steven Timlick" onClick={()=>setSignerApprovalModal({name:"Steven Timlick",title:"Associate | Project Mgmt. & Operations"})}
              style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
              <span style={{fontWeight:active?700:400}}>Steven Timlick</span>
              <span style={{fontSize:10,color:active?"#a7b4c6":"#8796aa",marginLeft:6}}>Associate | Project Mgmt. & Operations</span>
            </button>;
          })()}
          {(()=>{
            const active = form.npsaSignerName==="Stuart Reese";
            return <button key="Stuart Reese" onClick={()=>setSignerApprovalModal({name:"Stuart Reese",title:"Director of Grants | Co-Director of Operations"})}
              style={{textAlign:"left",background:active?"#1e3a5f":"#1f2a3a",border:`1px solid ${active?"#4a8bc4":"#2b3a4d"}`,borderRadius:6,padding:"7px 10px",color:active?"#fff":"#a7b4c6",fontSize:12,cursor:"pointer"}}>
              <span style={{fontWeight:active?700:400}}>Stuart Reese</span>
              <span style={{fontSize:10,color:active?"#a7b4c6":"#8796aa",marginLeft:6}}>Director of Grants | Co-Director of Operations</span>
            </button>;
          })()}
        </div>
        <div style={{marginBottom:10}}>
          <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Signing Date</label>
          <input type="date" value={form.npsaSigningDate||""} onChange={e=>setF("npsaSigningDate",e.target.value)}
            style={{width:"100%",background:"#1f2a3a",border:"1px solid #2b3a4d",borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
        </div>
        {!isAddendum&&(
          <div style={{marginBottom:10}}>
            <label style={{fontSize:11,color:"#a09a8c",display:"block",marginBottom:2}}>Expiration Date <span style={{color:"#f0a08c"}}>*</span></label>
            <input type="date" value={form.expirationDate||""} onChange={e=>setF("expirationDate",e.target.value)}
              style={{width:"100%",background:"#1f2a3a",border:`1px solid ${form.expirationDate?"#2b3a4d":"#7a3a3a"}`,borderRadius:6,padding:"6px 10px",color:"#e8edf4",fontSize:12,boxSizing:"border-box",outline:"none"}}/>
            {!form.expirationDate&&<div style={{fontSize:10,color:"#f0a08c",marginTop:3}}>Required to download or print.</div>}
          </div>
        )}
        </>}
        {/* Management Approval Modal */}
        {mgmtApprovalModal&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
            <div style={{background:"#16202e",border:"1px solid #f0a08c",borderRadius:12,padding:"28px 32px",maxWidth:380,width:"90%",boxShadow:"0 8px 40px rgba(0,0,0,0.6)"}}>
              <div style={{fontSize:18,fontWeight:700,color:"#fff",marginBottom:8,textAlign:"center"}}>Management Approval Required</div>
              <div style={{fontSize:13,color:"#a7b4c6",marginBottom:24,textAlign:"center",lineHeight:1.6}}>Has this AI-generated clause been reviewed and confirmed by management before inserting it into the contract?</div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>{
                  setMgmtApprovalModal(false);
                  setF(isPre?"polishedClause":"postPolishedClause","");
                  setF(isPre?"customClause":"postCustomClause","");
                }} style={{flex:1,padding:"10px 0",borderRadius:8,border:"1px solid #555",background:"#26313f",color:"#a09a8c",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  No — Discard
                </button>
                <button onClick={()=>setMgmtApprovalModal(false)}
                  style={{flex:1,padding:"10px 0",borderRadius:8,border:"none",background:"#1a6e3a",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  Yes — Approved
                </button>
              </div>
            </div>
          </div>
        )}
        {(()=>{ const blocked = !isAddendum && !form.expirationDate; return (
        <button onClick={handlePrint} disabled={blocked} title={blocked?"Set an Expiration Date first":""}
          style={{marginTop:20,width:"100%",background:blocked?"#4a5340":"#6b8e23",color:blocked?"#aeb59a":"#fff",border:"none",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:blocked?"not-allowed":"pointer"}}>
          {isGw ? "Print / Save as PDF" : "Download PDF"}
        </button>
        );})()}
        {!isGw && (
          <button onClick={()=>{
            const bodyHtml = previewRef.current ? previewRef.current.innerHTML : "";
            setReviewHtml(bodyHtml);
            setSavedLetterOverride(null);
            setReviewMode(true);
          }} style={{marginTop:8,width:"100%",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer"}}>
            Review &amp; Edit Letter
          </button>
        )}
        {isGw && (
          <button onClick={()=>{
            setEmailFields({
              to: form.gwRecipientEmail||"",
              subject: `NPSA New Client: ${form.clientName||"Client"}`,
              message: `Hi ${form.gwRecipientName||"there"},
Please find attached the new client information for ${form.clientName||"our client"}. Let us know if you have any questions.
Thank you,
${form.npsa1Name||"NPSA"}`
            });
            setEmailModal(true);
          }} style={{marginTop:8,width:"100%",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer"}}>
            Email to Grant Writer
          </button>
        )}
        {dbAvailable && (
          <div style={{marginTop:16,borderTop:"1px solid #26313f",paddingTop:14}}>
            <button onClick={()=>setShowSaveModal(true)}
              style={{width:"100%",background:"#2b3a4d",color:"#e8edf4",border:"1px solid #3d5080",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer"}}>
              {currentLetterId ? "Update Letter" : "Save Letter"}
            </button>
            {currentLetterId && (
              <div style={{fontSize:11,color:"#8796aa",marginTop:6,textAlign:"center"}}>
                Saved as: {form.clientName||"Untitled"}
              </div>
            )}
          </div>
        )}
      </div>
      {/* ── REVIEW & EDIT MODE ── */}
      {reviewMode && (
        <div style={{flex:1,display:"flex",flexDirection:"column",background:"#e7e2d6"}}>
          {/* Toolbar */}
          <div style={{background:"#1e3a5f",color:"#fff",padding:"12px 32px",display:"flex",alignItems:"center",gap:16,flexShrink:0,boxShadow:"0 2px 8px rgba(0,0,0,0.2)"}}>
            <span style={{fontWeight:700,fontSize:14}}>Review &amp; Edit Mode</span>
            <span style={{opacity:0.75,fontSize:12}}>Click anywhere in the document to edit. Click "Save to Letter" to apply your changes.</span>
            <div style={{marginLeft:"auto",display:"flex",gap:10}}>
              <button onClick={()=>{
                if(reviewIframeRef.current){
                  const doc = reviewIframeRef.current.contentDocument;
                  if(doc) { const orig = previewRef.current ? previewRef.current.innerHTML : ""; doc.getElementById("editable-body").innerHTML = orig; }
                }
              }} style={{background:"#555",color:"#fff",border:"none",padding:"7px 16px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:600}}>Reset Edits</button>
              <button onClick={()=>{
                if(reviewIframeRef.current){
                  const doc = reviewIframeRef.current.contentDocument;
                  if(doc){
                    const bodyContent = doc.getElementById("editable-body").innerHTML;
                    setSavedLetterOverride(bodyContent);
                    setReviewMode(false);
                  }
                }
              }} style={{background:"#2e7d32",color:"#fff",border:"none",padding:"7px 16px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:600}}>Save to Letter</button>
              <button onClick={()=>setReviewMode(false)} style={{background:"#b71c1c",color:"#fff",border:"none",padding:"7px 16px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:600}}>Back to Generator</button>
            </div>
          </div>
          {/* Editable iframe */}
          <iframe ref={reviewIframeRef} style={{flex:1,border:"none",background:"#e7e2d6"}}
            srcDoc={`<!DOCTYPE html><html><head><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Ms+Madi&display=swap" rel="stylesheet"><style>
              body{margin:0;padding:40px;background:#e7e2d6;font-family:Georgia,serif;}
              #editable-body{max-width:800px;margin:0 auto;background:#fff;padding:64px 72px;box-shadow:0 4px 32px rgba(0,0,0,0.13);outline:none;font-size:13px;line-height:1.75;color:#1a1a1a;}
              #editable-body:focus{outline:none;}
              @media print{body{margin:0;padding:0;background:#fff;}#editable-body{box-shadow:none;padding:72pt;max-width:100%;}}
            </style></head><body>
              <div id="editable-body" contenteditable="true">${reviewHtml}</div>
            </body></html>`}
          />
        </div>
      )}
      {/* ── PREVIEW ── */}
      <div style={{flex:1,overflowY:"auto",padding:"0 40px 40px",background:"#e7e2d6",display:reviewMode?"none":"flex",flexDirection:"column"}}>
        {/* Tabs */}
        <div style={{position:"sticky",top:0,zIndex:10,background:"#e7e2d6",paddingTop:28}}><div style={{maxWidth:800,margin:"0 auto",display:"flex",overflowX:"auto"}}>
          {[{id:"pre",label:"Pre-Award",match:["pre","inh"],defaultTab:"inh"},{id:"post",label:"Award Implementation"},{id:"gw",label:"3rd Party Grant Writer"},{id:"proposal",label:"Proposal"},{id:"addendum",label:"Addendum"}].map((t,i,arr)=>{
            const active = t.match ? t.match.includes(docTab) : docTab===t.id;
            return (
            <button key={t.id} onClick={()=>setDocTab(active&&t.match?docTab:(t.defaultTab||t.id))}
              style={{padding:"10px 18px",fontSize:12,fontWeight:700,border:"none",whiteSpace:"nowrap",flexShrink:0,
                borderRadius:i===0?"8px 0 0 0":i===arr.length-1?"0 8px 0 0":"0",
                cursor:"pointer",
                background:active?"#fff":"#c8cdd8",
                color:active?"#1e3a5f":"#666",
                boxShadow:active?"0 -2px 0 #1e3a5f inset":""}}>
              {t.label}
            </button>
          );})}
        </div></div>
        <div style={{maxWidth:800,margin:"0 auto",background:"#fff",boxShadow:"0 4px 32px rgba(0,0,0,0.13)",padding:"64px 72px"}} ref={previewRef}>
          {savedLetterOverride ? <div dangerouslySetInnerHTML={{__html: savedLetterOverride}} /> : isProposal ? (()=>{
            const pgYear = proposalProgs[0]?.year || form.grantYear;
            const isDisc = form.pricingTier==="discounted" && fees.discount>0;
            const complianceIncluded = !form.optPostAwardScope || (fees.postAward||0)===0;
            const isFull = form.proposalServiceModel === "full";
            const isThirdParty = form.proposalFeeModel === "pre";
            const execSummaryText = isFull
              ? (isThirdParty ? (proposalTpl.execSummaryFullThirdParty || proposalTpl.execSummaryFull) : proposalTpl.execSummaryFull) || proposalTpl.execSummary
              : (isThirdParty ? (proposalTpl.execSummaryThirdParty || proposalTpl.execSummary) : proposalTpl.execSummary);
            const phase1 = isThirdParty ? (proposalTpl.phaseThirdParty || (proposalTpl.phases||[])[0]) : (proposalTpl.phases||[])[0];
            const phasesToShow = [
              phase1,
              (proposalTpl.phases||[])[1],
              isFull ? (proposalTpl.phaseImplementationFull || (proposalTpl.phases||[])[2]) : (proposalTpl.phases||[])[2],
            ].filter(Boolean);
            const summaryFees = form.proposalFeeModel === "inh" ? inhFees : fees;
            const summaryRows = [
              ["SERVICES", isFull ? "Full-Service — Pre-Award, Compliance & Implementation" : (isThirdParty ? "Grant Consulting — Pre-Award & Compliance" : "Grant Writing — Pre-Award & Compliance")],
              ["PROJECT", (() => {
                const distinctLocs = (form.locations||[]).length || 1;
                if (totalApps > distinctLocs) {
                  return `${pgYear} ${proposalAcronyms} Application${totalApps>1?"s":""} (${distinctLocs} Location${distinctLocs>1?"s":""}, ${totalApps} Application${totalApps>1?"s":""})`;
                }
                return `${pgYear} ${proposalAcronyms} Application${totalApps>1?"s":""} (${totalApps} Location${totalApps>1?"s":""})`;
              })()],
              ["POTENTIAL FUNDING", `Up to ${fmt(proposalMaxFunding)}`],
              ["PROFESSIONAL FEE", fmt(summaryFees.upfront)],
            ];
            return <>
              {/* Logo */}
              <div style={{textAlign:"center",borderBottom:"2.5px solid #1e3a5f",paddingBottom:10,marginBottom:12}}>
                <img src={LOGO_SRC} alt="Nonprofit Security Advisors" style={{display:"block",margin:"0 auto",maxHeight:80,maxWidth:340}}/>
                <div style={{fontSize:10,color:"#888",marginTop:6,letterSpacing:0.5}}>Lynde Consulting LLC, DBA Nonprofit Security Advisors</div>
              </div>
              {/* Title */}
              <div style={{textAlign:"center",margin:"12px 0 4px"}}>
                <div style={{fontSize:17,fontWeight:700,letterSpacing:4,textTransform:"uppercase",color:"#1a1a1a",fontFamily:"Georgia,serif"}}>Proposal</div>
                <div style={{fontSize:13,fontStyle:"italic",color:"#444",marginTop:4}}>{proposalProgramList}</div>
                <div style={{fontSize:11,color:"#666",marginTop:5}}>{today}</div>
              </div>
              {/* Parties */}
              <div style={{border:"1px solid #8796aa",borderRadius:4,padding:"14px 20px",marginBottom:20,marginTop:20,background:"#f6f4ee",display:"flex",gap:40}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Client</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{form.clientName||"[CLIENT NAME]"}</div>
                  {clientAddr&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{clientAddr}</div>}
                  {form.contactName&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{form.contactName}</div>}
                  {form.contactTitle&&<div style={{fontSize:11,color:"#666"}}>{form.contactTitle}</div>}
                  {form.contactEmail&&<div style={{fontSize:11,color:"#666"}}>{form.contactEmail}</div>}
                  {form.contactPhone&&<div style={{fontSize:11,color:"#666"}}>{form.contactPhone}</div>}
                </div>
                <div style={{width:1,background:"#8796aa"}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Consultant</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>Nonprofit Security Advisors</div>
                  <div style={{fontSize:12,color:"#555"}}>Lynde Consulting LLC</div>
                  <div style={{fontSize:11,color:"#666",marginTop:2}}>Winnebago County, Illinois</div>
                </div>
              </div>
              {/* Summary box */}
              <div style={{border:"1px solid #1e3a5f",borderRadius:4,overflow:"hidden",marginBottom:24}}>
                {summaryRows.map(([k,v],i)=>(
                  <div key={k} style={{display:"flex",borderTop:i===0?"none":"1px solid #a7b4c6"}}>
                    <div style={{width:180,flexShrink:0,background:"#fbfaf8",padding:"9px 14px",fontSize:11,fontWeight:700,letterSpacing:0.5,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{k}</div>
                    <div style={{flex:1,padding:"9px 14px",fontSize:13,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{v}</div>
                  </div>
                ))}
              </div>
              {/* Executive Summary */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginBottom:10}}>Executive Summary</div>
              <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,marginBottom:20}}>{interpolateProposal(execSummaryText)}</p>
              {/* Project Locations */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginBottom:10}}>Project Locations</div>
              <div style={{marginBottom:20}}>
                {(form.locations||[]).filter(l=>l.address||l.city||l.name).length>0
                  ? (form.locations||[]).filter(l=>l.address||l.city||l.name).map((loc,i)=>{
                      const parts=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
                      return <div key={i} style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,marginBottom:3}}>&#8226; {loc.name?`${loc.name} — `:""}{parts||"[Address TBD]"}</div>;
                    })
                  : <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#888",fontStyle:"italic"}}>Add locations in the sidebar to list project campuses here.</div>}
              </div>
              {/* Three Phase Approach */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginBottom:10}}>Three Phase Approach</div>
              {phasesToShow.map((ph,i)=>(
                <div key={i} style={{marginBottom:16}}>
                  <div style={{fontSize:12.5,fontWeight:700,fontFamily:"Georgia,serif",color:"#1a1a1a",marginBottom:4}}>{ph.title}</div>
                  <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:0}}>{interpolateProposal(ph.body)}</p>
                  {ph.deliverable&&<p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:"6px 0 0",fontStyle:"italic",color:"#333"}}><strong>Deliverable:</strong> {interpolateProposal(ph.deliverable)}</p>}
                </div>
              ))}
              {/* Eligible Project Types */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:20,marginBottom:10}}>Eligible Project Types</div>
              <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.8,marginBottom:20}}>{proposalTpl.eligible}</p>
              {/* Investment & Payment Terms */}
              {(()=>{
                const useInh = form.proposalFeeModel === "inh";
                const pFees = useInh ? inhFees : fees;
                const pDisc = useInh ? form.inhPricingTier==="discounted" : form.pricingTier==="discounted";
                const pDiscDate = useInh ? form.inhEarlySigningDate : form.earlySigningDate;
                return <>
                  <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginBottom:10}}>Investment &amp; Payment Terms</div>
                  <div style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.8,marginBottom:8}}>
                    <div><strong>Professional Fee:</strong> {fmt(pFees.upfront)}</div>
                    {pDisc&&pFees.discount>0&&<div>Includes a {fmt(pFees.discount)} early-signing discount from the standard {fmt(pFees.baseUpfront)} fee.</div>}
                    <div>Invoice issued upon execution of the Engagement Letter.</div>
                    {pFees.contingent!==null&&pFees.contingent>0&&<div>A contingent fee of {fmt(pFees.contingent)} is due upon notification of a grant award.</div>}
                    <div>The fee includes all Pre-Award{form.optPostAwardScope?" and Compliance Period":""} services described herein.</div>
                    {complianceIncluded
                      ? <div>Compliance support following award notification is included at no additional charge.</div>
                      : !useInh&&<div>A Compliance Period fee of {fmt(fees.postAward)} is due within thirty (30) days of award notification.</div>}
                    {isFull&&<div>Award Implementation services are billed as a percentage-based fee, due upon notification of a grant award and formally engaged following State authorization to proceed, as set forth in the governing Engagement Letter.</div>}
                  </div>
                  {pDisc&&pDiscDate&&(
                    <div style={{border:"1px solid #1e3a5f",borderRadius:4,background:"#fbfaf8",padding:"12px 16px",margin:"6px 0 20px",fontSize:13,fontFamily:"Georgia,serif",color:"#1e3a5f",fontWeight:700}}>
                      To lock the discounted fee, execute the Engagement Letter by {pDiscDate}.
                    </div>
                  )}
                </>;
              })()}
              {/* Important Note */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginBottom:10}}>Important Note</div>
              <p style={{fontSize:12.5,fontFamily:"Georgia,serif",lineHeight:1.7,marginBottom:20,fontStyle:"italic",color:"#333"}}>{proposalTpl.note}</p>
              {fmtExpiry&&<p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,fontStyle:"italic",fontWeight:700,color:"#1e3a5f",marginBottom:20}}>This proposal expires on {fmtExpiry}.</p>}
              <div style={{marginTop:30,paddingTop:10,borderTop:"1px solid #ddd",textAlign:"center",fontSize:10,color:"#aaa"}}>
                Prepared for the leadership of {form.clientName||"[CLIENT NAME]"} &nbsp;&#8226;&nbsp; Nonprofit Security Advisors &nbsp;&#8226;&nbsp; Lynde Consulting LLC
              </div>
            </>;
          })() : isAddendum ? (()=>{
            const addClient = form.addendumClientName || form.clientName || "[CLIENT NAME]";
            const origDate = (()=>{ const v=form.addendumOriginalDate; if(!v) return "[Original Agreement Date]"; const d=new Date(v+"T12:00:00"); return d.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}); })();
            const npsaDate = (()=>{ const v=form.npsaSigningDate||""; if(!v) return ""; const [y,m,d]=v.split("-"); return `${m}-${d}-${y}`; })();
            return <>
              {/* Letterhead */}
              <div style={{textAlign:"center",borderBottom:"2.5px solid #1e3a5f",paddingBottom:10,marginBottom:12}}>
                <img src={LOGO_SRC} alt="Nonprofit Security Advisors" style={{display:"block",margin:"0 auto",maxHeight:80,maxWidth:340}}/>
                <div style={{fontSize:10,color:"#888",marginTop:6,letterSpacing:0.5}}>Lynde Consulting LLC, DBA Nonprofit Security Advisors</div>
              </div>
              <div style={{textAlign:"center",margin:"12px 0 4px"}}>
                <div style={{fontSize:17,fontWeight:700,letterSpacing:4,textTransform:"uppercase",color:"#1a1a1a",fontFamily:"Georgia,serif"}}>Addendum to Engagement Letter</div>
                <div style={{fontSize:13,fontStyle:"italic",color:"#444",marginTop:4}}>Dated {origDate}</div>
                <div style={{fontSize:11,color:"#666",marginTop:5}}>{today}</div>
              </div>
              {/* Parties */}
              <div style={{border:"1px solid #8796aa",borderRadius:4,padding:"14px 20px",marginBottom:20,marginTop:20,background:"#f6f4ee",display:"flex",gap:40}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Client</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{addClient}</div>
                  {clientAddr&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{clientAddr}</div>}
                  {form.contactName&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{form.contactName}</div>}
                  {form.contactTitle&&<div style={{fontSize:11,color:"#666"}}>{form.contactTitle}</div>}
                  {form.contactEmail&&<div style={{fontSize:11,color:"#666"}}>{form.contactEmail}</div>}
                  {form.contactPhone&&<div style={{fontSize:11,color:"#666"}}>{form.contactPhone}</div>}
                </div>
                <div style={{width:1,background:"#8796aa"}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Consultant</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>Nonprofit Security Advisors</div>
                  <div style={{fontSize:12,color:"#555"}}>Lynde Consulting LLC</div>
                  <div style={{fontSize:11,color:"#666",marginTop:2}}>Winnebago County, Illinois</div>
                </div>
              </div>
              <div style={{marginTop:18}}>
                {(addendumTpl.sections||[]).map(sec=>(
                  <div key={sec.id} style={{marginBottom:16}}>
                    <div style={{fontSize:13,fontWeight:700,fontFamily:"Georgia,serif",color:"#1a1a1a",marginBottom:6}}>{sec.heading}</div>
                    {renderLines(interpolateAddendum(sec.content))}
                  </div>
                ))}
              </div>
              {/* Signature block */}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:26,marginBottom:14}}>Acknowledged and Agreed</div>
              <div style={{display:"flex",gap:48}}>
                {[
                  {party:addClient,sub:null,isNpsa:false,fields:[["Signature",""],["Printed Name",form.contactName||""],["Title",form.contactTitle||""],["Date",""]]},
                  {party:"Lynde Consulting, LLC",sub:"DBA Nonprofit Security Advisors",isNpsa:true,fields:[["Signature",form.npsaSignerName||""],["Printed Name",form.npsaSignerName||""],["Title",form.npsaSignerTitle||""],["Date",npsaDate]]},
                ].map((p,i)=>(
                  <div key={i} style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,fontFamily:"Georgia,serif",marginBottom:2}}>{p.party}</div>
                    <div style={{fontSize:11,color:"#555",marginBottom:18,minHeight:16}}>{p.sub||" "}</div>
                    {p.fields.map(([lbl,val])=>{
                      const isSigRow = lbl==="Signature";
                      const sigStyle = p.isNpsa && isSigRow && val ? NPSA_SIGNATURES[val] : null;
                      return (
                        <div key={lbl} style={{marginBottom:20}}>
                          <div style={{borderBottom:"1px solid #333",minHeight:sigStyle?40:24,paddingBottom:2,
                            fontSize:sigStyle?sigStyle.size:"13px",
                            color:val?(sigStyle?sigStyle.color:"#111"):"transparent",
                            fontFamily:sigStyle?sigStyle.font:"Georgia,serif",
                            lineHeight:sigStyle?"1":"inherit"}}>
                            {val||"."}
                          </div>
                          <div style={{fontSize:10,color:"#666",textTransform:"uppercase",letterSpacing:0.5,marginTop:3}}>{lbl}</div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div style={{marginTop:30,paddingTop:10,borderTop:"1px solid #ddd",textAlign:"center",fontSize:10,color:"#aaa"}}>
                Nonprofit Security Advisors &nbsp;&#8226;&nbsp; Lynde Consulting LLC &nbsp;&#8226;&nbsp; Winnebago County, Illinois &nbsp;&#8226;&nbsp; Confidential
              </div>
            </>;
          })() : <>
          {/* Logo */}
          <div style={{textAlign:"center",borderBottom:"2.5px solid #1e3a5f",paddingBottom:10,marginBottom:12}}>
            <img src={LOGO_SRC} alt="Nonprofit Security Advisors" style={{display:"block",margin:"0 auto",maxHeight:80,maxWidth:340}}/>
            <div style={{fontSize:10,color:"#888",marginTop:6,letterSpacing:0.5}}>Lynde Consulting LLC, DBA Nonprofit Security Advisors</div>
          </div>
          {/* Title */}
          <div style={{textAlign:"center",margin:"12px 0 4px"}}>
            <div style={{fontSize:17,fontWeight:700,letterSpacing:4,textTransform:"uppercase",color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{isGw?"New Client Form":"Engagement Letter"}</div>
            <div style={{fontSize:13,fontStyle:"italic",color:"#444",marginTop:4}}>
              {(()=>{
                const preProgLabel = (form.programs||[{key:"federal"}]).map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join(" / ");
                const postProgLabel = postPrograms.map(pg=>(PROGRAMS[pg.key]||PROGRAMS.federal).acronym).join(" / ");
                return isGw?"3rd Party Grant Writer Engagement"
                  :isInh?`Pre-Award ${preProgLabel} Consulting Services: Pre-Award & Compliance Periods`
                  :isPre?`Pre-Award ${preProgLabel} Consulting Services: Pre-Award & Compliance Periods`
                  :`Award Implementation ${postProgLabel} Consulting Services`;
              })()}
            </div>
            <div style={{fontSize:11,color:"#666",marginTop:5}}>{today}</div>
          </div>
          {/* Parties — pre/post only */}
          {!isGw&&<div style={{border:"1px solid #8796aa",borderRadius:4,padding:"14px 20px",marginBottom:20,marginTop:20,background:"#f6f4ee",display:"flex",gap:40}}>
            <div style={{flex:1}}>
              <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Client</div>
              <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{form.clientName||"[CLIENT NAME]"}</div>
              {clientAddr&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{clientAddr}</div>}
              {form.contactName&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{form.contactName}</div>}
              {form.contactTitle&&<div style={{fontSize:11,color:"#666"}}>{form.contactTitle}</div>}
              {form.contactEmail&&<div style={{fontSize:11,color:"#666"}}>{form.contactEmail}</div>}
              {form.contactPhone&&<div style={{fontSize:11,color:"#666"}}>{form.contactPhone}</div>}
            </div>
            <div style={{width:1,background:"#8796aa"}}/>
            <div style={{flex:1}}>
              <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>Consultant</div>
              <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>Nonprofit Security Advisors</div>
              <div style={{fontSize:12,color:"#555"}}>Lynde Consulting LLC</div>
              <div style={{fontSize:11,color:"#666",marginTop:2}}>Winnebago County, Illinois</div>
            </div>
          </div>}
          {/* Pre-Award Fee Summary Box */}
          {isPre&&(
            <div style={{border:"1px solid #1e3a5f",borderRadius:4,padding:"12px 18px",marginBottom:20,background:"#fbfaf8"}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>
                Fee Summary — Pre-Award{form.optPostAwardScope?" & Compliance":""} · {totalApps} Application{totalApps>1?"s":""}
              </div>
              <div style={{display:"flex",gap:0,flexWrap:"wrap"}}>
                {form.installments ? (
                  [
                    {pct:form.installment1Pct, label:form.installment1Label, num:1},
                    {pct:form.installment2Pct, label:form.installment2Label, num:2},
                    ...(form.installmentCount>=3?[{pct:form.installment3Pct, label:form.installment3Label, num:3}]:[]),
                  ].map((p,i,arr)=>{
                    const pct = parseFloat(p.pct)||0;
                    const amt = Math.round(fees.upfront * pct / 100);
                    return (
                      <div key={p.num} style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16,minWidth:80}}>
                        <div style={{fontSize:10,color:"#888",marginBottom:2}}>Payment {p.num}{pct>0?` (${pct}%)`:""}</div>
                        <div style={{fontSize:16,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{pct>0?fmt(amt):"—"}</div>
                        <div style={{fontSize:10,color:"#888",marginTop:2}}>{p.label||"—"}</div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Upfront Fee</div>
                    {fees.discount>0
                      ? <><div style={{fontSize:15,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif",textDecoration:"line-through",opacity:0.5}}>{fmt(fees.baseUpfront)}</div>
                          <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(fees.upfront)}</div>
                          <div style={{fontSize:10,color:"#e07030",marginTop:1,fontWeight:600}}>− {fmt(fees.discount)} early signing discount</div></>
                      : <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(fees.upfront)}</div>
                    }
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due at signing</div>
                  </div>
                )}
                {fees.contingent!==null&&(
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Contingent Fee</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(fees.contingent)}</div>
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due after award notification</div>
                  </div>
                )}
                {form.optPostAwardScope&&(
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Compliance Consulting Fee{numLocs>1?` (×${numLocs})`:""}</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(fees.postAward)}</div>
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due after award notification</div>
                  </div>
                )}
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#888",marginBottom:2}}>Total</div>
                  <div style={{fontSize:18,fontWeight:700,color:"#6b8e23",fontFamily:"Georgia,serif"}}>{fmt(fees.total)}</div>
                  <div style={{fontSize:10,color:"#888",marginTop:2}}>Max grant: {fmt((form.programs||[{key:"federal"}]).reduce((s,pg)=>{const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;const n=(form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length||0;return s+n*(parseFloat(cfg.maxAward.replace(/,/g,""))||200000);},0))}</div>
                </div>
              </div>
            </div>
          )}
          {/* In-House Pre-Award Fee Summary Box */}
          {isInh&&(
            <div style={{border:"1px solid #1e3a5f",borderRadius:4,padding:"12px 18px",marginBottom:20,background:"#fbfaf8"}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>
                Fee Summary — Pre-Award{form.inhOptPostAwardScope?" & Compliance":""} · {totalApps} Application{totalApps>1?"s":""}
              </div>
              <div style={{display:"flex",gap:0,flexWrap:"wrap"}}>
                {form.inhInstallments ? (
                  [
                    {pct:form.inhInstallment1Pct, label:form.inhInstallment1Label, num:1},
                    {pct:form.inhInstallment2Pct, label:form.inhInstallment2Label, num:2},
                    ...(form.inhInstallmentCount>=3?[{pct:form.inhInstallment3Pct, label:form.inhInstallment3Label, num:3}]:[]),
                  ].map((p)=>{
                    const pct = parseFloat(p.pct)||0;
                    const amt = Math.round(inhFees.upfront * pct / 100);
                    return (
                      <div key={p.num} style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16,minWidth:80}}>
                        <div style={{fontSize:10,color:"#888",marginBottom:2}}>Payment {p.num}{pct>0?` (${pct}%)`:""}</div>
                        <div style={{fontSize:16,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{pct>0?fmt(amt):"—"}</div>
                        <div style={{fontSize:10,color:"#888",marginTop:2}}>{p.label||"—"}</div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Upfront Fee</div>
                    {inhFees.discount>0
                      ? <><div style={{fontSize:15,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif",textDecoration:"line-through",opacity:0.5}}>{fmt(inhFees.baseUpfront)}</div>
                          <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(inhFees.upfront)}</div>
                          <div style={{fontSize:10,color:"#e07030",marginTop:1,fontWeight:600}}>− {fmt(inhFees.discount)} early signing discount</div></>
                      : <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(inhFees.upfront)}</div>
                    }
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due at signing</div>
                  </div>
                )}
                {inhFees.contingent!==null&&(
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Contingent Fee</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(inhFees.contingent)}</div>
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due after award notification</div>
                  </div>
                )}
                {form.inhOptPostAwardScope&&(
                  <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:2}}>Compliance Consulting Fee{numLocs>1?` (×${numLocs})`:""}</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fmt(inhFees.postAward)}</div>
                    <div style={{fontSize:10,color:"#888",marginTop:2}}>Due after award notification</div>
                  </div>
                )}
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#888",marginBottom:2}}>Total</div>
                  <div style={{fontSize:18,fontWeight:700,color:"#6b8e23",fontFamily:"Georgia,serif"}}>{fmt(inhFees.total)}</div>
                  <div style={{fontSize:10,color:"#888",marginTop:2}}>Max grant: {fmt((form.programs||[{key:"federal"}]).reduce((s,pg)=>{const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;const n=(form.locations||[]).filter(l=>(l.programs||["federal"]).includes(pg.key)).length||0;return s+n*(parseFloat(cfg.maxAward.replace(/,/g,""))||200000);},0))}</div>
                </div>
              </div>
            </div>
          )}
          {/* Body sections */}
          {isPre&&<>
            <Body id="pre_intro"/>
            <SH id="pre_periods"/><Body id="pre_periods"/>
            <SH id="pre_scope"/>
            <SubH label={preSections.find(s=>s.id==="pre_scope")?.subsections?.[0]?.title||"A. Pre-Award Period Consulting"} />
            <Body id="pre_scope" subId="pre_scope_pre"/>
            <SubH label={preSections.find(s=>s.id==="pre_scope")?.subsections?.[1]?.title||"B. Compliance Period Consulting"}/>
            <Body id="pre_scope" subId="pre_scope_post"/>
            <SH id="pre_liability"/><Body id="pre_liability"/>
            <SH id="pre_conf"/><Body id="pre_conf"/>
            <SH id="pre_resp"/><Body id="pre_resp"/>
            <SH id="pre_comp"/><Body id="pre_comp"/>
            <SH id="pre_guar"/><Body id="pre_guar"/>
            {form.optStateSwitch&&(
              <div style={{border:"1px solid #c5d16a",borderRadius:4,background:"#f9fbf2",padding:"14px 18px",margin:"16px 0"}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#5a6800",marginBottom:8}}>Additional Optional Guarantees</div>
                <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:"4px 0"}}>• If CLIENT elects to transition from a Federal NSGP application to a State NSGP application, NPSA will accommodate such a change and apply all fees and services to the State NSGP opportunity.</p>
              </div>
            )}
            <SH id="pre_cancel"/><Body id="pre_cancel"/>
            <SH id="pre_other"/><Body id="pre_other"/>
            {form.optShortNotice&&(
              <>
                <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:30,marginBottom:10}}>IX. Short-Notice Application Circumstances</div>
                {renderLines(
`1. CLIENT acknowledges that this engagement is being entered into with less than desirable notice.
2. NPSA commits to make all commercially reasonable efforts to position CLIENT to submit a compliant and well-written application.
3. If the application cannot be completed due to time constraints not caused by a material breach by NPSA;
   (a) No refund shall be issued; and
   (b) Work completed shall be applied to the next available NSGP opportunity at CLIENT's election; and
   (c) No additional fee under Compensation Section 1 shall apply; and
   (d) If CLIENT later receives funding, the fees described in Compensation Section 2 shall apply.`
                )}
              </>
            )}
            {form.polishedClause&&(
              <div style={{border:"1px solid #a7b4c6",borderRadius:4,background:"#f7f9fd",padding:"14px 18px",margin:"16px 0"}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>Additional Terms</div>
                <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:0}}>{form.polishedClause}</p>
              </div>
            )}
          </>}
          {/* In-House Pre-Award body sections */}
          {isInh&&<>
            <Body id="inh_intro"/>
            <SH id="inh_periods"/><Body id="inh_periods"/>
            <SH id="inh_scope"/>
            <SubH label={inhSections.find(s=>s.id==="inh_scope")?.subsections?.[0]?.title||"A. Pre-Award Period Consulting"} />
            <Body id="inh_scope" subId="inh_scope_pre"/>
            <SubH label={inhSections.find(s=>s.id==="inh_scope")?.subsections?.[1]?.title||"B. Compliance Period Consulting"}/>
            <Body id="inh_scope" subId="inh_scope_post"/>
            <SH id="inh_liability"/><Body id="inh_liability"/>
            <SH id="inh_conf"/><Body id="inh_conf"/>
            <SH id="inh_resp"/><Body id="inh_resp"/>
            <SH id="inh_comp"/><Body id="inh_comp"/>
            <SH id="inh_guar"/><Body id="inh_guar"/>
            {form.inhOptStateSwitch&&(
              <div style={{border:"1px solid #c5d16a",borderRadius:4,background:"#f9fbf2",padding:"14px 18px",margin:"16px 0"}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#5a6800",marginBottom:8}}>Additional Optional Guarantees</div>
                <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:"4px 0"}}>• If CLIENT elects to transition from a Federal NSGP application to a State NSGP application, NPSA will accommodate such a change and apply all fees and services to the State NSGP opportunity.</p>
              </div>
            )}
            <SH id="inh_cancel"/><Body id="inh_cancel"/>
            <SH id="inh_other"/><Body id="inh_other"/>
            {form.inhOptShortNotice&&(
              <>
                <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:30,marginBottom:10}}>IX. Short-Notice Application Circumstances</div>
                {renderLines(
`1. CLIENT acknowledges that this engagement is being entered into with less than desirable notice.
2. NPSA commits to make all commercially reasonable efforts to position CLIENT to submit a compliant and well-written application.
3. If the application cannot be completed due to time constraints not caused by a material breach by NPSA;
   (a) No refund shall be issued; and
   (b) Work completed shall be applied to the next available NSGP opportunity at CLIENT's election; and
   (c) No additional fee under Compensation Section 1 shall apply; and
   (d) If CLIENT later receives funding, the fees described in Compensation Section 2 shall apply.`
                )}
              </>
            )}
            {form.inhPolishedClause&&(
              <div style={{border:"1px solid #a7b4c6",borderRadius:4,background:"#f7f9fd",padding:"14px 18px",margin:"16px 0"}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>Additional Terms</div>
                <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:0}}>{form.inhPolishedClause}</p>
              </div>
            )}
          </>}
          {!isPre&&!isGw&&!isInh&&!isProposal&&!isAddendum&&<>
            {/* Post-Award Fee Summary Box */}
            {(()=>{
              const fee = parseFloat(String(form.postFee).replace(/,/g,"")) || 0;
              const p1 = parseFloat(form.postPmt1) || 0;
              const p2 = parseFloat(form.postPmt2) || 0;
              const p3 = parseFloat(form.postPmt3) || 0;
              const pmt1 = Math.round(fee * p1 / 100);
              const pmt2 = Math.round(fee * p2 / 100);
              const pmt3 = Math.round(fee * p3 / 100);
              let pmt2Due = "Month 4 from effective date";
              let pmt3Due = "Month 8 from effective date";
              if (form.postEffectiveDate) {
                const d = new Date(form.postEffectiveDate + "T12:00:00");
                const m4 = new Date(d); m4.setMonth(m4.getMonth() + 4);
                const m8 = new Date(d); m8.setMonth(m8.getMonth() + 8);
                const fmtShort = (dt) => dt.toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
                pmt2Due = `Due ${fmtShort(m4)}`;
                pmt3Due = `Due ${fmtShort(m8)}`;
              }
              return (
                <div style={{border:"1px solid #1e3a5f",borderRadius:4,padding:"12px 18px",marginBottom:20,background:"#fbfaf8"}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>
                    Fee Summary — Award Implementation M&A · {postGrantYear}
                  </div>
                  <div style={{display:"flex",gap:0}}>
                    <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                      <div style={{fontSize:10,color:"#888",marginBottom:2}}>Payment 1 — At Signing{p1>0?` (${p1}%)`:""}</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fee>0&&p1>0?fmt(pmt1):"—"}</div>
                      <div style={{fontSize:10,color:"#888",marginTop:2}}>Due at signing</div>
                    </div>
                    <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                      <div style={{fontSize:10,color:"#888",marginBottom:2}}>Payment 2 — Month 4{p2>0?` (${p2}%)`:""}</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fee>0&&p2>0?fmt(pmt2):"—"}</div>
                      <div style={{fontSize:10,color:"#888",marginTop:2}}>{pmt2Due}</div>
                    </div>
                    <div style={{flex:1,borderRight:"1px solid #a7b4c6",paddingRight:16,marginRight:16}}>
                      <div style={{fontSize:10,color:"#888",marginBottom:2}}>Payment 3 — Month 8{p3>0?` (${p3}%)`:""}</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#1e3a5f",fontFamily:"Georgia,serif"}}>{fee>0&&p3>0?fmt(pmt3):"—"}</div>
                      <div style={{fontSize:10,color:"#888",marginTop:2}}>{pmt3Due}</div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,color:"#888",marginBottom:2}}>Total Fixed Fee</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#6b8e23",fontFamily:"Georgia,serif"}}>{fee>0?fmt(fee):"—"}</div>
                      <div style={{fontSize:10,color:"#888",marginTop:2}}>Fixed engagement fee</div>
                    </div>
                  </div>
                </div>
              );
            })()}
            <Body id="post_intro"/>
            <SH id="post_scope"/><Body id="post_scope"/>
            <SH id="post_liability"/><Body id="post_liability"/>
            <SH id="post_conf"/><Body id="post_conf"/>
            <SH id="post_resp"/><Body id="post_resp"/>
            <SH id="post_comp"/><Body id="post_comp"/>
            <SH id="post_term"/><Body id="post_term"/>
            <SH id="post_other"/><Body id="post_other"/>
            {form.postPolishedClause&&(
              <div style={{border:"1px solid #a7b4c6",borderRadius:4,background:"#f7f9fd",padding:"14px 18px",margin:"16px 0"}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",marginBottom:8}}>Additional Terms</div>
                <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,margin:0}}>{form.postPolishedClause}</p>
              </div>
            )}
          </>}
          {/* ── GRANT WRITER FORM ── */}
          {isGw&&(()=>{
            const loc0 = (form.locations||[])[0]||{};
            const clientAddr = [loc0.address,loc0.city,loc0.state,loc0.zip].filter(Boolean).join(", ");
            const F = ({label,value,placeholder}) => (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#888",marginBottom:3}}>{label}</div>
                <div style={{fontSize:13,fontFamily:"Georgia,serif",color:value?"#1a1a1a":"#bbb",borderBottom:"1px solid #ccc",paddingBottom:4,minHeight:22}}>{value||placeholder||"—"}</div>
              </div>
            );
            const Row = ({children}) => <div style={{display:"flex",gap:32,marginBottom:0}}>{children}</div>;
            const Col = ({children,flex=1}) => <div style={{flex}}>{children}</div>;
            const SectionHead = ({num,title}) => (
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#1e3a5f",borderBottom:"1.5px solid #1e3a5f",paddingBottom:4,marginTop:24,marginBottom:14}}>
                {num}. {title}
              </div>
            );
            const Check = ({checked,label}) => (
              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:10,fontFamily:"Georgia,serif",fontSize:13,lineHeight:1.5}}>
                <span style={{fontSize:15,flexShrink:0,marginTop:1}}>{checked?"[X]":"[ ]"}</span>
                <span style={{color:checked?"#1a1a1a":"#555"}}>{label}</span>
              </div>
            );
            return <>
              {/* Parties box — Grant Writer tab */}
              <div style={{border:"1px solid #8796aa",borderRadius:4,padding:"14px 20px",marginBottom:20,marginTop:20,background:"#f6f4ee",display:"flex",gap:40}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>To: Grant Writer</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{form.gwRecipientName||"[Grant Writer Name]"}</div>
                  {form.gwOrgName&&<div style={{fontSize:12,color:"#555"}}>{form.gwOrgName}</div>}
                </div>
                <div style={{width:1,background:"#8796aa"}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:"#666",marginBottom:4}}>From: Consultant</div>
                  {form.npsa1Name&&<div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",fontFamily:"Georgia,serif"}}>{form.npsa1Name}</div>}
                  <div style={{fontSize:12,color:"#555"}}>Nonprofit Security Advisors</div>
                  {form.npsa1Email&&<div style={{fontSize:11,color:"#666",marginTop:2}}>{form.npsa1Email}</div>}
                  {form.npsa1Phone&&<div style={{fontSize:11,color:"#666"}}>{form.npsa1Phone}</div>}
                </div>
              </div>
              <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#555",fontStyle:"italic",marginBottom:20,marginTop:4}}>
                {form.npsa1Name||"[Consultant Name]"} is acting solely in his/her capacity as an authorized consultant of Nonprofit Security Advisors (NPSA).
              </div>
              <SectionHead num="1" title="Client Information"/>
              <F label="Organization" value={form.clientName} placeholder="Organization Name"/>
              <F label="Billing Address" value={clientAddr} placeholder="Address"/>
              <SectionHead num="2" title="Authorized Contract Signer"/>
              <Row>
                <Col><F label="Name" value={form.contactName} placeholder="Contact Name"/></Col>
                <Col><F label="Title" value={form.contactTitle} placeholder="Title"/></Col>
              </Row>
              <Row>
                <Col><F label="Phone" value={form.contactPhone} placeholder="Phone"/></Col>
                <Col><F label="Email" value={form.contactEmail} placeholder="Email"/></Col>
              </Row>
              {(()=>{
                let n = 2; // sections 1-2 are fixed above
                const hasCc = (form.gwCcContacts||[]).filter(c=>c.name||c.email).length>0;
                const ccNum   = hasCc ? ++n : null;
                const locsNum = ++n;
                const progNum = ++n;
                const termsNum = ++n;
                const guarNum  = ++n;
                const actionsNum = ++n;
                return <>
                  {hasCc&&<>
                    <SectionHead num={ccNum} title="Contract Carbon Copy Contact(s)"/>
                    {(form.gwCcContacts||[]).filter(c=>c.name||c.email).map((cc,idx)=>(
                      <Row key={idx}>
                        <Col><F label="Name" value={cc.name} placeholder="Name"/></Col>
                        <Col><F label="Title" value={cc.title} placeholder="Title"/></Col>
                        <Col><F label="Phone" value={cc.phone} placeholder="Phone"/></Col>
                        <Col><F label="Email" value={cc.email} placeholder="Email"/></Col>
                      </Row>
                    ))}
                  </>}
                  <SectionHead num={locsNum} title={`Location${numLocs>1?"s":""} (${numLocs})`}/>
                  {(form.locations||[]).map((loc,i)=>{
                    const addr=[loc.address,loc.city,loc.state,loc.zip].filter(Boolean).join(", ");
                    return (
                      <div key={i} style={{marginBottom:10}}>
                        {loc.name&&<F label={`Location ${i+1} Name`} value={loc.name} placeholder=""/>}
                        <F label={loc.name?`Location ${i+1} Address`:`Location ${i+1}`} value={addr} placeholder="Address"/>
                      </div>
                    );
                  })}
                  {form.gwNotes && (<>
                    <SectionHead num="" title="Additional Notes"/>
                    <div style={{background:"#fbfaf8",border:"1px solid #a7b4c6",borderRadius:8,padding:"14px 18px",marginBottom:16}}>
                      <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#333",whiteSpace:"pre-wrap",lineHeight:1.7}}>{form.gwNotes}</div>
                    </div>
                  </>)}
                  {(()=>{
                    const gwProgs=(form.gwPrograms&&form.gwPrograms.length)?form.gwPrograms:[{key:"federal",year:form.grantYear||"2026"}];
                    const progLabel=(pg)=>{
                      const cfg=PROGRAMS[pg.key]||PROGRAMS.federal;
                      const yr=pg.year||form.grantYear||"";
                      return `${yr} ${pg.key==="federal"?"Federal NSGP":cfg.acronym}`.trim();
                    };
                    return <>
                      <SectionHead num={progNum} title={gwProgs.length>1?"Grant Programs":"Grant Program"}/>
                      {gwProgs.map((pg,i)=>(
                        <F key={i} label={gwProgs.length>1?`Program ${i+1}`:"Program"} value={progLabel(pg)} placeholder="2026 Federal NSGP"/>
                      ))}
                    </>;
                  })()}
                  <SectionHead num={termsNum} title={`Requested Contract Terms for ${form.gwOrgName||"Grant Writer"} Preparation`}/>
                  <Row>
                    <Col><F label="Professional Fee" value={form.gwProfFee?`$${form.gwProfFee}`:""} placeholder="$0"/></Col>
                    <Col><F label="Payment Terms" value={form.gwPaymentTerms} placeholder="Net 30"/></Col>
                  </Row>
                  <SectionHead num={guarNum} title="Guarantee Structure (Select all that apply)"/>
                  <Check checked={form.gwGuar1} label="1. One additional application at no additional fee if not awarded (materially similar scope required)."/>
                  <Check checked={form.gwGuar2} label="2. If no NOFO: (a) Apply work to next comparable opportunity; or (b) Refund within 10 business days upon written request."/>
                  <Check checked={form.gwGuar3} label="3. If no NOFO is released, apply work to next available comparable opportunity."/>
                  <div style={{fontSize:12,fontFamily:"Georgia,serif",color:"#666",fontStyle:"italic",marginBottom:10,marginLeft:26}}>Note: Options 2 and 3 are mutually exclusive.</div>
                  <Check checked={form.gwGuar4} label={`4. Commercially reasonable efforts to meet deadline: ${form.gwGuar4Deadline||"____________"}. If not completed in time, apply work to next available opportunity.`}/>
                  <div style={{fontSize:12,fontFamily:"Georgia,serif",color:"#666",fontStyle:"italic",marginBottom:10,marginLeft:26}}>Note: If Option 4 is selected, Options 2 and 3 may not be selected.</div>
                  <div style={{fontSize:12,fontFamily:"Georgia,serif",color:"#555",fontStyle:"italic",marginTop:8,borderTop:"1px solid #ddd",paddingTop:10}}>NPSA provides recommendations only. Final terms remain subject solely to the Grant Writer's independent contract.</div>
                  <SectionHead num={actionsNum} title={`Requested Actions by ${form.gwOrgName||"Grant Writer"}`}/>
                </>;
              })()}
              <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#333",marginBottom:12}}>Upon receipt of this form, the Grant Writer is requested to:</div>
              {renderLines(`1. Send its services agreement directly to the Authorized Contract Signer${(form.gwCcContacts||[]).filter(c=>c.name).length>0?` (copy: ${(form.gwCcContacts||[]).filter(c=>c.name).map(c=>c.name).join(", ")})`:""}.
2. Provide its white paper and/or informational materials directly to the client.
3. Send a meeting invitation including:`)}
              <div style={{marginLeft:24,marginTop:8}}>
                <div style={{fontSize:12,fontWeight:700,color:"#1e3a5f",marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>NPSA:</div>
                {form.npsa1Name&&<div style={{fontSize:13,fontFamily:"Georgia,serif",marginBottom:4}}>• {form.npsa1Name}{form.npsa1Email?` – ${form.npsa1Email}`:""}</div>}
                {(form.npsa2Selected||[]).map(r=>(
                  <div key={r.name} style={{fontSize:13,fontFamily:"Georgia,serif",marginBottom:4}}>• {r.name}{r.email?` – ${r.email}`:""}</div>
                ))}
                <div style={{fontSize:12,fontWeight:700,color:"#1e3a5f",marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>{form.clientName||"CLIENT"}:</div>
                {[
                  form.contactName ? {name:form.contactName, email:form.contactEmail} : null,
                  ...(form.gwCcContacts||[]).filter(c=>c.name).map(c=>({name:c.name,email:c.email})),
                ].filter(Boolean).map((a,i)=>(
                  <div key={i} style={{fontSize:13,fontFamily:"Georgia,serif",marginBottom:4}}>• {a.name}{a.email?` – ${a.email}`:""}</div>
                ))}
              </div>
              {/* Disclosures */}
              <div style={{marginTop:28,borderTop:"2px solid #1e3a5f",paddingTop:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",marginBottom:14,fontFamily:"Georgia,serif"}}>Disclosures</div>
                {(()=>{
                  const gw = form.gwOrgName||"the Grant Writer";
                  return [
                    {num:"1.", title:"Independent Entity & No Agency Disclosure", body:`NPSA and ${gw} are separate and independent entities. Neither is an agent, employee, partner, joint venturer, or representative of the other. This request does not create a partnership, joint venture, subcontracting relationship, exclusive arrangement, or agency relationship.`},
                    {num:"2.", title:"No Revenue Share / No Financial Interest Disclosure", body:`NPSA receives no commission, referral fee, revenue share, percentage of contract value, or contingent compensation related to the client's potential engagement of ${gw}. NPSA has no financial interest in whether the client retains ${gw}.`},
                    {num:"3.", title:"No Pre-Selection / Client Discretion Statement", body:`The client is under no obligation to retain ${gw} and may select any provider. This communication does not constitute vendor pre-selection, required designation, or procurement steering. Any engagement must be contracted directly between ${gw} and the client at the client's sole discretion.`},
                  ].map(d=>(
                    <div key={d.num} style={{marginBottom:16}}>
                      <div style={{fontSize:13,fontWeight:700,fontFamily:"Georgia,serif",color:"#1a1a1a",marginBottom:4}}>{d.num} {d.title}</div>
                      <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#333",lineHeight:1.7}}>{d.body}</div>
                    </div>
                  ));
                })()}
                <div style={{fontSize:13,fontFamily:"Georgia,serif",color:"#333",fontStyle:"italic",marginTop:12,borderTop:"1px solid #ddd",paddingTop:10}}>No services shall commence unless and until the Grant Writer executes a written agreement directly with the client.</div>
              </div>
            </>;
          })()}
          {/* Expiration clause — all letter variants (pre/inh/post/gw) */}
          {fmtExpiry&&<p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,fontStyle:"italic",fontWeight:700,color:"#1e3a5f",marginTop:24,marginBottom:0}}>This offer expires on {fmtExpiry}.</p>}
          {/* Signature — pre/post only */}
          {!isGw&&<>
          <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:"#1e3a5f",borderBottom:"2px solid #1e3a5f",paddingBottom:4,marginTop:30,marginBottom:14}}>Acknowledged and Agreed</div>
          <p style={{fontSize:13,fontFamily:"Georgia,serif",lineHeight:1.7,marginBottom:20}}>The undersigned parties hereby acknowledge and agree to the terms and conditions set forth in this Engagement Letter as of the date first written above.</p>
          <div style={{display:"flex",gap:48}}>
            {[
              {party:form.clientName||"CLIENT",sub:null,fields:[["Signature",""],["Date",""],["Printed Name",form.contactName||""],["Title",form.contactTitle||""]]},
              {party:"Lynde Consulting, LLC",sub:"DBA Nonprofit Security Advisors",isNpsa:true,fields:[["Signature",form.npsaSignerName||""],["Date",(()=>{ const v=form.npsaSigningDate||""; if(!v) return ""; const [y,m,d]=v.split("-"); return `${m}-${d}-${y}`; })()],["Printed Name",form.npsaSignerName||""],["Title",form.npsaSignerTitle||""]]}
            ].map((p,i)=>(
              <div key={i} style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,fontFamily:"Georgia,serif",marginBottom:2}}>{p.party}</div>
                <div style={{fontSize:11,color:"#555",marginBottom:18,minHeight:16}}>{p.sub||"\u00a0"}</div>
                {p.fields.map(([lbl,val])=>{
                  const isSigRow = lbl==="Signature";
                  const sigStyle = p.isNpsa && isSigRow && val ? NPSA_SIGNATURES[val] : null;
                  return (
                    <div key={lbl} style={{marginBottom:20}}>
                      <div style={{borderBottom:"1px solid #333",minHeight:sigStyle?40:24,paddingBottom:2,
                        fontSize:sigStyle?sigStyle.size:"13px",
                        color:val?(sigStyle?sigStyle.color:"#111"):"transparent",
                        fontFamily:sigStyle?sigStyle.font:"Georgia,serif",
                        lineHeight:sigStyle?"1":"inherit"}}>
                        {val||"."}
                      </div>
                      <div style={{fontSize:10,color:"#666",textTransform:"uppercase",letterSpacing:0.5,marginTop:3}}>{lbl}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          </>}
          <div style={{marginTop:36,paddingTop:10,borderTop:"1px solid #ddd",textAlign:"center",fontSize:10,color:"#aaa"}}>
            Nonprofit Security Advisors &nbsp;•&nbsp; Lynde Consulting LLC &nbsp;•&nbsp; Winnebago County, Illinois &nbsp;•&nbsp; Confidential
          </div>
          </>}
        </div>
      </div>
      {/* ── SIGNER APPROVAL MODAL ── */}
      {signerApprovalModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{background:"#fff",borderRadius:10,padding:"32px 36px",maxWidth:400,width:"90%",boxShadow:"0 8px 40px rgba(0,0,0,0.22)",textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:12,color:"#e8bd6d",fontWeight:700}}>(!)</div>
            <div style={{fontWeight:700,fontSize:17,color:"#182230",marginBottom:10}}>Management Approval Required</div>
            <div style={{fontSize:14,color:"#444",marginBottom:8,lineHeight:1.6}}>
              You're changing the authorized signer to <strong>{signerApprovalModal.name}</strong>.
            </div>
            <div style={{fontSize:14,color:"#444",marginBottom:24,lineHeight:1.6}}>
              Has this change been approved by management?
            </div>
            <div style={{display:"flex",gap:12,justifyContent:"center"}}>
              <button onClick={()=>setSignerApprovalModal(null)}
                style={{padding:"9px 22px",borderRadius:6,border:"1px solid #ccc",background:"#f5f5f5",fontSize:13,cursor:"pointer",fontWeight:600,color:"#555"}}>
                Cancel
              </button>
              <button onClick={()=>{setF("npsaSignerName",signerApprovalModal.name);setF("npsaSignerTitle",signerApprovalModal.title);setSignerApprovalModal(null);}}
                style={{padding:"9px 22px",borderRadius:6,border:"none",background:"#1a3a6e",fontSize:13,cursor:"pointer",fontWeight:700,color:"#fff"}}>
                Yes, Approved
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EMAIL MODAL ── */}
      {emailModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{background:"#fff",borderRadius:10,padding:"32px 36px",maxWidth:460,width:"90%",boxShadow:"0 8px 40px rgba(0,0,0,0.22)"}}>
            <div style={{fontWeight:700,fontSize:16,color:"#182230",marginBottom:4}}>Email to Grant Writer</div>
            <div style={{fontSize:12,color:"#777",marginBottom:20,lineHeight:1.5}}>Your default email client will open with these fields pre-filled. Attach the downloaded GW document before sending.</div>
            {[
              {label:"To", key:"to", placeholder:"grantwriter@example.com"},
              {label:"Subject", key:"subject", placeholder:"Subject"},
            ].map(f2=>(
              <div key={f2.key} style={{marginBottom:12}}>
                <label style={{fontSize:12,fontWeight:600,color:"#444",display:"block",marginBottom:4}}>{f2.label}</label>
                <input value={emailFields[f2.key]} onChange={e=>setEmailFields(ef=>({...ef,[f2.key]:e.target.value}))}
                  placeholder={f2.placeholder}
                  style={{width:"100%",border:"1px solid #ccc",borderRadius:6,padding:"8px 10px",fontSize:13,boxSizing:"border-box",outline:"none"}}/>
              </div>
            ))}
            <div style={{marginBottom:20}}>
              <label style={{fontSize:12,fontWeight:600,color:"#444",display:"block",marginBottom:4}}>Message</label>
              <textarea value={emailFields.message} onChange={e=>setEmailFields(ef=>({...ef,message:e.target.value}))}
                rows={5} style={{width:"100%",border:"1px solid #ccc",borderRadius:6,padding:"8px 10px",fontSize:13,boxSizing:"border-box",outline:"none",resize:"vertical",fontFamily:"inherit"}}/>
            </div>
            <div style={{background:"#fff8e8",border:"1px solid #e8c97a",borderRadius:6,padding:"10px 14px",fontSize:12,color:"#7a5a00",marginBottom:12,lineHeight:1.5}}>
              <strong>Note:</strong> Email clients cannot attach files automatically. Use <em>Download Form</em> below to save the PDF first, then attach it manually to your email.
            </div>
            <div style={{display:"flex",gap:10,flexDirection:"column"}}>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setEmailModal(false)}
                  style={{flex:1,padding:"10px 0",borderRadius:8,border:"1px solid #ccc",background:"#f5f5f5",color:"#555",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                  Cancel
                </button>
                <button onClick={()=>{
                  const mailto = `mailto:${encodeURIComponent(emailFields.to)}?subject=${encodeURIComponent(emailFields.subject)}&body=${encodeURIComponent(emailFields.message)}`;
                  window.location.href = mailto;
                  setEmailModal(false);
                }}
                  style={{flex:2,padding:"10px 0",borderRadius:8,border:"none",background:"#1e3a5f",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  Open in Email Client
                </button>
              </div>
              <button onClick={()=>{ handlePrint(); }}
                style={{width:"100%",padding:"10px 0",borderRadius:8,border:"1px solid #1e3a5f",background:"#fff",color:"#1e3a5f",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                Download Form First
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── SAVE MODAL ── */}
      {showSaveModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}>
          <div style={{background:"#fff",borderRadius:10,padding:"32px 36px",maxWidth:420,width:"90%",boxShadow:"0 8px 40px rgba(0,0,0,0.22)"}}>
            <div style={{fontWeight:700,fontSize:16,color:"#182230",marginBottom:4}}>{currentLetterId ? "Update Letter" : "Save Letter"}</div>
            <div style={{fontSize:12,color:"#777",marginBottom:pendingPrintAfterSave?12:20}}>Client: <strong>{form.clientName||"Untitled"}</strong></div>
            {pendingPrintAfterSave && (
              <div style={{background:"#eef4fb",border:"1px solid #b8cde4",borderRadius:6,padding:"10px 12px",fontSize:12,color:"#1e3a5f",marginBottom:20,lineHeight:1.5}}>
                {currentLetterId
                  ? "This letter has unsaved changes. Save the update and the download will start automatically."
                  : "Letters must be saved before they can be downloaded. Pick the rep and the download will start automatically."}
              </div>
            )}
            <div style={{marginBottom:20}}>
              <label style={{fontSize:12,fontWeight:600,color:"#444",display:"block",marginBottom:6}}>Sales Rep</label>
              {reps.length === 0 ? (
                <div style={{fontSize:12,color:"#a3341f",background:"#fff5f5",border:"1px solid #f5c6c6",borderRadius:6,padding:"10px 12px"}}>
                  No reps configured. Go to Settings to add reps first.
                </div>
              ) : (
                <select value={selectedRep} onChange={e=>setSelectedRep(e.target.value)}
                  style={{width:"100%",border:"1px solid #ccc",borderRadius:6,padding:"8px 10px",fontSize:13,outline:"none",background:"#fff"}}>
                  <option value="">— Select rep —</option>
                  {reps.map(r=><option key={r.id} value={r.name}>{r.name}</option>)}
                </select>
              )}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{ setShowSaveModal(false); setPendingPrintAfterSave(false); }}
                style={{flex:1,padding:"10px 0",borderRadius:8,border:"1px solid #ccc",background:"#f5f5f5",color:"#555",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                Cancel
              </button>
              <button onClick={saveLetter} disabled={!selectedRep}
                style={{flex:2,padding:"10px 0",borderRadius:8,border:"none",background:selectedRep?"#1a2540":"#ccc",color:"#fff",fontSize:13,fontWeight:700,cursor:selectedRep?"pointer":"not-allowed"}}>
                {pendingPrintAfterSave ? (currentLetterId ? "Update & Download" : "Save & Download") : (currentLetterId ? "Update" : "Save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      )} {/* end generator */}

      {/* ── LETTER BROWSER MODAL ── */}
      {showLetterBrowser && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",flexDirection:"column",zIndex:2000,fontFamily:'var(--font-sans)'}}>
          <div style={{background:"#fbfaf8",flex:1,display:"flex",flexDirection:"column",maxHeight:"100vh",overflow:"hidden"}}>
            {/* Header */}
            <div style={{padding:"22px 32px",display:"flex",alignItems:"center",gap:16,flexShrink:0,background:"#fff",borderBottom:"1px solid #f0ede5"}}>
              <div style={{color:"#182230",fontWeight:800,fontSize:20,flex:1}}>Saved Letters</div>
              <input value={letterSearch} onChange={e=>{ setLetterSearch(e.target.value); fetchLetters(e.target.value); }}
                placeholder="Search by client or rep..."
                style={{border:"1px solid #d9d5cc",borderRadius:10,padding:"10px 16px",fontSize:14,outline:"none",width:280}}/>
              <button onClick={()=>{ setShowLetterBrowser(false); if (enteredVia === 'letters') goBack(); }}
                style={{background:"#fbfaf8",border:"1px solid #e7e2d6",borderRadius:10,width:40,height:40,color:"#4a5462",fontSize:18,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>&#10005;</button>
            </div>
            {/* Table — centered, compact columns */}
            <div style={{flex:1,overflowY:"auto",padding:"28px 24px"}}>
              {savedLetters.length === 0 ? (
                <div style={{padding:60,textAlign:"center",color:"#a09a8c",fontSize:16}}>
                  {letterSearch ? "No letters match your search." : "No saved letters yet."}
                </div>
              ) : (
                <div style={{maxWidth:880,margin:"0 auto",background:"#fff",borderRadius:18,boxShadow:"0 6px 24px rgba(2,6,23,0.06)",border:"1px solid #f0ede5",overflow:"hidden"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #f0ede5"}}>
                        {["Client","Rep","Type","Last Updated",""].map((h,hi)=>(
                          <th key={h} style={{padding:"16px 14px",textAlign:hi===4?"right":"left",fontSize:12.5,fontWeight:700,color:"#a09a8c",textTransform:"uppercase",letterSpacing:0.5}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {savedLetters.map((l,li)=>(
                        <tr key={l.id} style={{borderBottom:li===savedLetters.length-1?"none":"1px solid #f0ede5",background:currentLetterId===l.id?"#f5f3ff":"#fff"}}>
                          <td style={{padding:"16px 14px",fontWeight:700,color:"#182230",fontSize:16}}>{l.client_name}</td>
                          <td style={{padding:"16px 14px",color:"#4a5462",fontSize:15}}>{l.rep_name}</td>
                          <td style={{padding:"16px 14px",color:"#1e3a5f",fontSize:14,fontWeight:600}}>
                            {tabLabel[l.doc_tab]||l.doc_tab}
                          </td>
                          <td style={{padding:"16px 14px",color:"#a09a8c",fontSize:14}}>{fmtDate(l.updated_at)}</td>
                          <td style={{padding:"16px 14px"}}>
                            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                              <button onClick={()=>loadLetter(l.id)}
                                style={{background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,padding:"8px 18px",fontSize:13.5,fontWeight:700,cursor:"pointer",boxShadow:"0 3px 10px rgba(26,37,64,0.3)"}}>
                                Load
                              </button>
                              <button onClick={()=>deleteLetter(l.id)}
                                style={{background:"#fff",border:"1px solid #d9a99c",color:"#a3341f",borderRadius:8,padding:"8px 14px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
