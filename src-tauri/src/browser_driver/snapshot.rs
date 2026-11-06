use super::*;

/// DOM helpers injected into the page for every snapshot and every element
/// action, so the role/name a ref points at is computed by exactly ONE piece of
/// code — the snapshot that printed the ref and the click that follows it can
/// never disagree about what "button Save" is.
pub(super) const JS_HELPERS: &str = r#"
function __cfText(el){
  var t=(el.innerText||el.textContent||'');
  t=t.replace(/\s+/g,' ').trim();
  return t.length>120?t.slice(0,120)+'…':t;
}
function __cfLabel(el){
  if(!el||!el.getAttribute) return '';
  var al=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.getAttribute('alt');
  if(al) return al.replace(/\s+/g,' ').trim();
  var tag=el.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'){
    var v=(el.value||'').replace(/\s+/g,' ').trim();
    if(v) return v.slice(0,60);
  }
  return __cfText(el);
}
function __cfRole(el){
  var r=((el.getAttribute&&el.getAttribute('role'))||'').toLowerCase();
  if(r) return r;
  var tag=el.tagName;
  if(tag==='A') return 'link';
  if(tag==='BUTTON') return 'button';
  if(tag==='INPUT') return (el.type||'input').toLowerCase();
  if(tag==='TEXTAREA') return 'textbox';
  if(tag==='SELECT') return 'combobox';
  if(tag==='SUMMARY') return 'summary';
  return tag.toLowerCase();
}
function __cfVisible(el){
  if(!el||!el.getBoundingClientRect) return false;
  var r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0) return false;
  var st=getComputedStyle(el);
  if(st.visibility==='hidden'||st.display==='none') return false;
  if(st.opacity==='0') return false;
  return true;
}
function __cfSqueeze(t){
  return (t||'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function __cfRegion(el){
  var n=el,i;
  for(i=0;n&&i<40;i++){
    if(!n.tagName) break;
    var tag=n.tagName;
    var role=((n.getAttribute&&n.getAttribute('role'))||'').toLowerCase();
    if(tag==='DIALOG'||role==='dialog'||role==='alertdialog') return 'dialog';
    if(tag==='NAV') return 'nav';
    if(tag==='HEADER') return 'header';
    if(tag==='FOOTER') return 'footer';
    if(tag==='ASIDE') return 'aside';
    if(tag==='MAIN'||tag==='ARTICLE'||role==='main') return 'main';
    n=n.parentElement;
  }
  return 'other';
}
function __cfMainText(){
  var m=document.querySelector('main,article,[role=main]');
  if(m){ var t=__cfSqueeze(m.innerText); if(t) return t.slice(0,8000); }
  var best='',bestLen=0,kids=document.body?document.body.children:[];
  for(var i=0;i<kids.length;i++){
    var el=kids[i];
    if(!__cfVisible(el)) continue;
    var full=el.innerText||''; if(full.length<40) continue;
    var links=0,a=el.getElementsByTagName('a');
    for(var j=0;j<a.length;j++){ links+=((a[j].innerText)||'').length; }
    var density=links/Math.max(1,full.replace(/\s+/g,'').length);
    if(density>0.4) continue;
    if(full.length>bestLen){ bestLen=full.length; best=full; }
  }
  return __cfSqueeze(best).slice(0,8000);
}
var __CF_SEL='a,button,input,textarea,select,summary,[role],[onclick],[contenteditable="true"],[tabindex]';
function __cfCandidates(){
  var out=[],seen={},list=document.querySelectorAll(__CF_SEL),i;
  for(i=0;i<list.length&&i<3000;i++){
    var el=list[i];
    if(!__cfVisible(el)) continue;
    var role=__cfRole(el);
    if(role==='presentation'||role==='none'||role==='generic') continue;
    var name=__cfLabel(el);
    var r=el.getBoundingClientRect();
    var key=role+'\u0000'+name+'\u0000'+Math.round(r.left)+','+Math.round(r.top);
    if(seen[key]) continue;
    seen[key]=1;
    out.push({el:el,role:role,name:name,region:__cfRegion(el),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  }
  return out;
}
function __cfMatch(role,name,nth){
  nth=nth||0;
  var list=__cfCandidates(),hits=[],i;
  for(i=0;i<list.length;i++){ if(list[i].role===role&&list[i].name===name) hits.push(list[i].el); }
  if(hits.length>nth) return hits[nth];
  hits=[];
  for(i=0;i<list.length;i++){
    if(list[i].role===role&&(list[i].name.indexOf(name)>=0||name.indexOf(list[i].name)>=0)) hits.push(list[i].el);
  }
  if(hits.length>nth) return hits[nth];
  if(hits.length) return hits[0];
  hits=[];
  for(i=0;i<list.length;i++){ if(list[i].name.indexOf(name)>=0) hits.push(list[i].el); }
  return hits.length?hits[Math.min(nth,hits.length-1)]:null;
}
"#;

/// Wraps an expression so the helpers above are in scope.
pub(super) fn js(expr: &str) -> String {
    format!("(function(){{{JS_HELPERS}\nreturn ({expr});}})()")
}

/// Snapshot expression: the interactive entries (with their page region), the
/// headings, the MAIN text and the body text.
pub(super) fn js_snapshot() -> String {
    format!(
        r#"(function(){{{JS_HELPERS}
var cands=__cfCandidates(),entries=[],i;
for(i=0;i<cands.length&&entries.length<400;i++){{
  entries.push({{role:cands[i].role,name:cands[i].name,region:cands[i].region,x:cands[i].x,y:cands[i].y}});
}}
var heads=document.querySelectorAll('h1,h2,h3,h4,h5,h6'),h=[],hc=0;
for(i=0;i<heads.length&&hc<100;i++){{
  if(!__cfVisible(heads[i])) continue;
  var t=__cfText(heads[i]);
  if(!t) continue;
  h.push({{role:heads[i].tagName.toLowerCase(),name:t}});
  hc++;
}}
var mainText=__cfMainText();
var body=document.body?((document.body.innerText||'')):'';
body=__cfSqueeze(body).slice(0,12000);
return {{url:location.href,title:document.title,entries:entries,headings:h,main_text:mainText,text:body}};
}})()"#
    )
}

/// One resolved element: what a ref points at, plus where it currently is.
#[derive(Clone, Debug)]
pub(super) struct SnapEntry {
    pub(super) role: String,
    pub(super) name: String,
    /// Which page region the element lives in (main, dialog, nav, header,
    /// footer, aside, other) — decided by its closest landmark ancestor.
    pub(super) region: String,
    /// Which occurrence of `(role, name)` this is (0-based).
    pub(super) nth: usize,
}

/// The refs one snapshot handed out. Kept per chat by version so a ref printed
/// three turns ago still resolves as long as the element is still on the page.
///
/// The TEXT is not stored — it is rendered on demand with a budget (see
/// `render_snapshot`), so the navigate summary, the default snapshot summary
/// and the full snapshot all come from ONE stored page reading and a ref shown
/// in one render points at exactly the same element in every other.
pub(super) struct Snapshot {
    pub(super) url: String,
    pub(super) title: String,
    pub(super) entries: Vec<SnapEntry>,
    /// Indices into `entries`, in DISPLAY order: main/dialog first, then
    /// other, then nav/header/footer. Refs themselves stay DOM-order (the
    /// assignment order `ref_index`/`entry_for` depend on); only the print
    /// order differs, and every line carries its own ref.
    pub(super) display_order: Vec<usize>,
    pub(super) headings: Vec<(String, String)>,
    /// Text of main/article/[role=main] (or the best non-link-dominated body
    /// child) — the summary leads with it.
    pub(super) main_text: String,
    /// Whole body text: only the full render carries it.
    pub(super) body_text: String,
    /// Ref number of `entries[0]`. Refs are MONOTONIC across snapshots and are
    /// never reset, so a printed ref is NOT an index into `entries`: the offset
    /// has to be subtracted before looking up (see `entry_for`).
    pub(super) base_ref: usize,
    /// Signature of the page when this snapshot was taken (cheap "unchanged").
    pub(super) sig: u64,
}

/// Display rank of one region: the content the model is usually there for
/// (main, dialog) first, generic content next, page furniture last. Ties keep
/// DOM order (stable sort).
pub(super) fn region_rank(region: &str) -> u8 {
    match region {
        "main" | "dialog" => 0,
        "other" => 1,
        _ => 2, // nav, header, footer, aside — and any future tag
    }
}

// ---------------------------------------------------------------------------
// CDP connection: one WebSocket, a writer task and a reader loop
// ---------------------------------------------------------------------------

/// fnv-ish signature of a snapshot payload, for the "unchanged" shortcut.
pub(super) fn signature(v: &Value) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    v["url"].as_str().unwrap_or_default().hash(&mut h);
    v["title"].as_str().unwrap_or_default().hash(&mut h);
    if let Some(list) = v["entries"].as_array() {
        for e in list {
            e["role"].as_str().unwrap_or_default().hash(&mut h);
            e["name"].as_str().unwrap_or_default().hash(&mut h);
            e["x"].as_i64().unwrap_or_default().hash(&mut h);
            e["y"].as_i64().unwrap_or_default().hash(&mut h);
        }
    }
    let text = v["text"].as_str().unwrap_or_default();
    text.len().hash(&mut h);
    v["main_text"].as_str().unwrap_or_default().len().hash(&mut h);
    h.finish()
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Render a stored snapshot at a character budget.
///
/// Fill order is the display priority: header, main text, headings, then the
/// interactive entries in `display_order` (main/dialog first, nav/footer
/// last), then — full renders only — the whole body text with what is left.
/// The main text is capped at ~45% of the budget so a wall of prose can never
/// push every ref out of the summary. Every render of the same snapshot prints
/// the same ref for the same element, so a ref the model saw in a navigate
/// summary resolves exactly in a later full snapshot.
pub(super) fn render_snapshot(snap: &Snapshot, budget: usize, full: bool) -> String {
    let mut out = format!("Page: {}\nURL: {}\n", snap.title, snap.url);
    if snap.entries.is_empty() {
        out.push_str("\n(no interactive elements found)\n");
    }

    let mut room = budget.saturating_sub(out.len());

    // Main text — the summary's headline content.
    if !snap.main_text.is_empty() && room > 80 {
        let cap = (budget * 45 / 100).max(400);
        let clip: String = snap.main_text.chars().take(cap).collect();
        let piece = if snap.main_text.chars().count() > cap {
            format!("\nMain text:\n{clip}…")
        } else {
            format!("\nMain text:\n{clip}")
        };
        out.push_str(&piece);
        room = room.saturating_sub(piece.len());
    }

    // Headings — the page's structure, one line each.
    if !snap.headings.is_empty() && room > 80 {
        let mut hs = String::from("\nHeadings:\n");
        for (role, name) in &snap.headings {
            let line = format!("- {role} \"{name}\"\n");
            if hs.len() + line.len() > room {
                break;
            }
            hs.push_str(&line);
        }
        out.push_str(&hs);
        room = room.saturating_sub(hs.len());
    }

    // Interactive entries — refs stay DOM-order (the assignment
    // `ref_index`/`entry_for` depend on); the PRINT order is display_order.
    // The region tag is shown on non-main entries only: main is where the
    // summary already started, and the bytes are better spent on names.
    // The section head and the "N more" note are reserved UP FRONT at their
    // worst-case length, so the lines that fit are what the budget actually
    // has left and the assembled text never crosses it (a clamp cutting the
    // note off would hide from the model exactly what it was told to fetch).
    if !snap.entries.is_empty() {
        let total = snap.entries.len();
        let head_max = format!("\nInteractive ({total} of {total} shown; main/dialog first):\n").len();
        let note_max = format!(
            "…[{total} more interactive elements — browser_snapshot with full=true]\n"
        )
        .len();
        room = room.saturating_sub(head_max + note_max);
        let mut list = String::new();
        let mut shown = 0usize;
        for &i in &snap.display_order {
            let e = &snap.entries[i];
            let label = if e.name.is_empty() {
                e.role.clone()
            } else {
                format!("{} \"{}\"", e.role, e.name)
            };
            let tag = if e.region == "main" {
                String::new()
            } else {
                format!(" ({})", e.region)
            };
            let line = format!("- [{}] {label}{tag}\n", snap.base_ref + i);
            if list.len() + line.len() > room {
                break;
            }
            list.push_str(&line);
            shown += 1;
        }
        if shown > 0 {
            let head = if shown < total {
                format!("\nInteractive ({shown} of {total} shown; main/dialog first):\n")
            } else {
                format!("\nInteractive ({total}):\n")
            };
            out.push_str(&head);
            out.push_str(&list);
        }
        if shown < total {
            out.push_str(&format!(
                "…[{} more interactive elements — browser_snapshot with full=true]\n",
                total - shown
            ));
        }
        room = room.saturating_sub(list.len());
    }

    // Whole body text — full renders only, with whatever budget is left, and
    // only when it adds something: a page whose body text IS its main text
    // (the common case for a <main>-bearing page) would print itself twice.
    if full && !snap.body_text.is_empty() && snap.body_text != snap.main_text && room > 80 {
        let clip: String = snap.body_text.chars().take(room - 32).collect();
        out.push_str(&format!("\nPage text:\n{clip}"));
        if clip.len() < snap.body_text.len() {
            out.push_str(&format!(
                "\n…[page text truncated — use browser_find or browser_evaluate for the rest]"
            ));
        }
    }

    if out.len() > budget {
        let kept: String = out.chars().take(budget).collect();
        out = format!(
            "{kept}\n…[snapshot truncated at {budget} chars — \
             use browser_find or browser_evaluate for the rest]"
        );
    }
    out
}

