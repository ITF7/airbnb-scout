// Airbnb Scout: listing-page extractor. Run with javascript_tool on an open /rooms/<id> page.
// Returns ~1-3k tokens of facts instead of a 10-30k token page read.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\n{2,}/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  // Keep what guests said and when; drop who said it. Reviewers' names, home towns and "N years on Airbnb"
  // lines never leave the page, so Scout doesn't collect personal data.
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const DATE = new RegExp(`^(Today|Yesterday|\\d+ (days?|weeks?|months?) ago|a (week|month) ago|(${MONTHS}) \\d{4})$`, 'i');
  const anonymiseReviews = text => {
    let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const start = lines.findIndex(l => /items? showing$/i.test(l));
    if (start >= 0) lines = lines.slice(start + 1);
    const names = new Set(), out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (DATE.test(l)) {
        // the review header right before the date is: name, then "N years on Airbnb" or a home town, then "," and "·"
        while (out.length && (out[out.length - 1] === ',' || out[out.length - 1] === '·')) out.pop();
        const last = () => out[out.length - 1] || '';
        const short = s => s && s.length <= 50 && !/[.!?…]$/.test(s) && !/^Rating, \d/.test(s) && !s.startsWith('— ');
        if (/on Airbnb$/i.test(last()) || /, /.test(last()) && short(last())) {
          const tenureOrTown = out.pop();
          if (!/on Airbnb$/i.test(tenureOrTown)) names.add(tenureOrTown);
          if (short(last())) names.add(out.pop());       // the name above it
        } else if (short(last()) && !/^Rating, \d/.test(last())) {
          names.add(out.pop());                           // just a name
        }
        out.push('— ' + l + ':');
        continue;
      }
      if (/^Show more$|^Translated|^Show original$/i.test(l)) continue;
      const rated = /^(.+?) · (Rating, \d stars?)$/.exec(l);
      if (rated) { names.add(rated[1]); out.push(rated[2]); continue; }
      out.push(l);
    }
    return out.filter(l => !names.has(l)).join('\n');
  };
  // Lazy sections load on scroll.
  for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await sleep(200); }
  await sleep(1200);
  const T = id => clean(document.querySelector(`[data-section-id="${id}"]`)?.innerText);
  let d = null;
  try { d = JSON.parse(document.getElementById('data-deferred-state-0').textContent); } catch (e) {}
  const find = (o, test) => { let hit = null; (function w(x) { if (hit || !x || typeof x !== 'object') return; if (test(x)) { hit = x; return; } for (const k in x) w(x[k]); })(o); return hit; };
  const share = d ? find(d, x => x.sharingConfig)?.sharingConfig : null;
  const sections = d ? find(d, x => Array.isArray(x.sections) && x.sections[0]?.sectionComponentType)?.sections || [] : [];
  const modal = sections.find(s => s.sectionComponentType === 'PDP_DESCRIPTION_MODAL')?.section;
  const descParts = (modal?.items || []).map(it => {
    const txt = (it.html?.htmlText || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    return (it.title ? it.title + ': ' : '') + txt;
  });
  const overview = T('OVERVIEW_DEFAULT_V2');
  const description = cap(clean(descParts.join('\n')) || T('DESCRIPTION_DEFAULT'), 1800);

  // Reviews: the page shows the ~6 most relevant ones with dates. (Opening "Show all reviews" can navigate
  // away in some browsers and kill this script, so it isn't used.)
  let reviewsText = T('REVIEWS_DEFAULT');
  const subRatings = reviewsText.split('\n').filter(l => /^Rated [\d.]+ out of 5 stars for /.test(l))
    .map(l => l.replace(/Rated ([\d.]+) out of 5 stars for (.+)/, '$2 $1')).join(', ');
  const cut = reviewsText.search(/\n(Most relevant|Most recent)\n/);
  if (cut > 0) reviewsText = reviewsText.slice(cut).replace(/^\n(Most relevant|Most recent)\n/, '');
  reviewsText = anonymiseReviews(reviewsText);
  const policies = T('POLICIES_DEFAULT');
  const amen = T('AMENITIES_DEFAULT');
  const all = (overview + '\n' + policies + '\n' + amen).toLowerCase();
  const m = /(\d+) reviews?/.exec(overview);
  const priceText = T('BOOK_IT_SIDEBAR') || T('BOOK_IT_FLOATING_FOOTER') || clean(document.querySelector('[data-testid="book-it-default"]')?.innerText);
  const total = /₪|\$|€|£/.test(priceText) ? (/(?:[₪$€£])\s?([\d,]+(?:\.\d+)?)\s*total/.exec(priceText) || [])[1] : null;
  return {
    id: (location.pathname.match(/rooms\/(\d+)/) || [])[1],
    title: document.title.split(' - ')[0],
    propertyType: share?.propertyType || (/^(.+?) in /.exec(overview) || [])[1] || null,
    shareTitle: share?.title || null,
    maxGuests: share?.personCapacity ?? (+(/(\d+) guests?/.exec(overview) || [])[1] || null),
    subRatings: subRatings || null,
    rating: share?.starRating ?? (+(/Rated ([\d.]+) out of 5/.exec(overview) || [])[1] || null),
    reviews: share?.reviewCount ?? (m ? +m[1] : null),
    image: share?.imageUrl || document.querySelector('meta[property="og:image"]')?.content || null,
    overview,
    priceText: cap(priceText, 300),
    totalPrice: total ? Number(total.replace(/,/g, '')) : null,
    unavailable: /not available|those dates are not available|dates unavailable/i.test(priceText),
    selfCheckIn: /self check-?in/.test(all),
    sleeping: cap(T('SLEEPING_ARRANGEMENT_DEFAULT') || T('SLEEPING_ARRANGEMENT_WITH_IMAGES'), 400),
    highlights: cap(T('HIGHLIGHTS_DEFAULT'), 600),
    description,
    policies: cap(policies, 900),
    location: cap(T('LOCATION_DEFAULT'), 500),
    host: cap(T('MEET_YOUR_HOST').replace(/^Meet your host\n[^\n]+\n/, 'Meet your host\n').replace(/\nMessage host[\s\S]*$/, ''), 350),  // no host name
    reviewsText: cap(reviewsText, 4500)
  };
})()
