// Airbnb Scout: open results page N of the current search. Run with javascript_tool on a search page,
// replacing PAGE below with 2, 3 or 4. The page links are base64 codes that the browser extension hides
// from the model, so this script reads them from the page and navigates by itself.
// After it returns, run search.js again (wait ~2 s and retry once if it still shows the old page).
((PAGE) => {
  const el = document.getElementById('data-deferred-state-0');
  if (!el) return { error: 'no embedded data on this page' };
  let f = null;
  try { (function w(o) { if (f || !o || typeof o !== 'object') return; if (Array.isArray(o.searchResults)) { f = o; return; } for (const k in o) w(o[k]); })(JSON.parse(el.textContent)); } catch (e) {}
  const cursors = f?.paginationInfo?.pageCursors || [];
  if (PAGE < 2 || PAGE > cursors.length) return { error: `no page ${PAGE}; this search has ${cursors.length || 1}` };
  const u = new URL(location.href);
  u.searchParams.delete('items_offset');
  u.searchParams.set('cursor', cursors[PAGE - 1]);
  setTimeout(() => { location.href = u.toString(); }, 50);
  return { loading: PAGE, of: cursors.length };
})(PAGE)
