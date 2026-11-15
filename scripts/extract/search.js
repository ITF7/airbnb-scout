// Airbnb Scout: search-page extractor. Run with javascript_tool on an Airbnb /s/... results page
// (load it by URL; the embedded data is the server-rendered first page). Returns compact cards with
// coordinates, so scripts/geo.py can work out the nearest station and walk without opening listings.
(() => {
  const el = document.getElementById('data-deferred-state-0');
  if (!el) return { error: 'no embedded data; fall back to get_page_text' };
  let d; try { d = JSON.parse(el.textContent); } catch (e) { return { error: 'bad embedded data' }; }
  let f = null;
  (function w(o) { if (f || !o || typeof o !== 'object') return; if (Array.isArray(o.searchResults)) { f = o; return; } for (const k in o) w(o[k]); })(d);
  if (!f) return { error: 'no results block; fall back to get_page_text' };
  const num = s => (s == null ? null : Number(String(s).replace(/[^\d.]/g, '')) || null);
  const results = f.searchResults.map(r => {
    const L = r.demandStayListing || {};
    let id = null; try { id = atob(L.id).split(':')[1]; } catch (e) {}
    const p = r.structuredDisplayPrice?.primaryLine || {};
    const priceStr = p.discountedPrice || p.price || p.accessibilityLabel || '';
    const lines = [...(r.structuredContent?.primaryLine || []), ...(r.structuredContent?.secondaryLine || [])].map(x => x.body).filter(Boolean).join(' · ');
    const rm = /([\d.]+) out of 5[^\d]*(\d+) reviews?/.exec(r.avgRatingA11yLabel || '');
    const bm = /(\d+) beds?\b/.exec(lines);
    return {
      id,
      title: r.title,
      name: r.subtitle || r.nameLocalized?.localizedStringWithTranslationPreference || null,
      area: r.eyebrowLocation || null,
      lat: L.location?.coordinate?.latitude ?? null,
      lon: L.location?.coordinate?.longitude ?? null,
      price: priceStr,
      total: /total/i.test((p.qualifier || '') + (p.accessibilityLabel || '')) ? num(priceStr) : null,
      beds: bm ? +bm[1] : null,
      info: lines,
      rating: rm ? +rm[1] : null,
      reviews: rm ? +rm[2] : (/new/i.test(r.avgRatingLocalized || '') ? 0 : null),
      badges: (r.badges || []).map(b => b.text || b.loggingContext?.badgeType).filter(Boolean),
      image: r.contextualPictures?.[0]?.picture || null
    };
  });
  const heading = document.querySelector('h1, [data-testid="stays-page-heading"]')?.innerText || '';
  const pages = f.paginationInfo?.pageCursors?.length || 1;
  const firstId = results[0]?.id || null;
  return { count: results.length, heading, pages, page: (() => { try { return 1 + Math.round(JSON.parse(atob(new URL(location.href).searchParams.get('cursor') || '')).items_offset / 18); } catch (e) { return 1; } })(),
           firstId, note: pages > 1 ? "more pages: run scripts/extract/next-page.js with PAGE = 2, 3, 4, then search.js again" : "single page", results };
})()
