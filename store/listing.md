# Store listing (Chrome Web Store / Microsoft Edge Add-ons)

Paste these into the store's developer dashboard. Upload `dist/scout-extension-1.0.0.zip` (build it with `py -3 scripts/package_extension.py`).

## Name
Scout for Airbnb

> Note: stores can object to another company's trademark in a name if it suggests a partnership. "for Airbnb" plus the "Not affiliated with Airbnb" line is the usual safe form. If a reviewer objects, the fallback is "Scout: holiday rental finder".

## Short description (132 characters max)
Describe your stay in plain words. Scout searches Airbnb in your browser, checks the best listings and ranks them.

## Category
Travel (Chrome: Lifestyle › Travel)

## Language
English

## Detailed description
Tired of clicking through filters and reading dozens of listings? Tell Scout what you want, like you'd tell a friend:

"London, 28 Nov – 3 Dec, 2 guests, 2 beds, whole place, 10 minutes from the tube, under $1,000, landing at Gatwick at 1am"

Scout turns that into Airbnb's own filters, reads the results in a tab in your browser, checks the most promising listings (the description, house rules, check-in details and recent reviews) and gives you a ranked shortlist with the reasons:

• Prefers places with many good reviews, and flags recurring problems like dirt, noise or mould
• Spots whole flats listed as "rooms" and places that only look like a match
• Measures the walk to the nearest station, and in London the tube zone
• Compares how calm each area is (UK police data) and plans your route from the airport at your arrival time (London, TfL)
• Late arrival? Checks for self check-in and check-in times that close before you land
• Clear points for every listing, so you can see why it ranked where it did

Private by design: Scout has no account and no servers. It reads Airbnb only when you press Search, at a normal person's pace, never signs in, never books and never collects personal data (reviewers' names are removed). Results stay in your browser. Optional: turn on Chrome's built-in AI for better judging; it runs on your computer.

Free. Not affiliated with Airbnb. Bookings are always made by you on Airbnb.

## Single purpose (Chrome asks for this)
Help a guest find and compare Airbnb listings that match a plain-language trip description.

## Permission justifications
- **tabs**: open the Airbnb search and the listings being checked in a tab the user can see, and open the report.
- **scripting**: read the Airbnb search results and listing pages in that tab (price, beds, description, rules, reviews).
- **storage**: keep the user's last request, recently checked listing facts and their reports in the browser.
- **Host permission airbnb.com**: the site being searched.
- **Host permission data.police.uk**: street-crime levels around stations (UK).
- **Host permission api.tfl.gov.uk**: public-transport routes from the user's arrival point (London).
- **Host permission nominatim.openstreetmap.org**: city-centre location for "how central".

## Remote code
No. All code is in the package.

## Data usage (Chrome's privacy form)
- Collects: none of the listed user-data types. (Website content is read only to show the user their results and isn't collected or transmitted to the developer.)
- Certify: data is not sold, not used for unrelated purposes, not used for creditworthiness.

## Privacy policy URL
https://github.com/ITF7/airbnb-scout/blob/main/docs/privacy.md

## Images
- Icon: `extension/icons/icon128.png`
- Small promo tile (440×280): `store/promo-440x280.png`
- Screenshots (1280×800, at least 1): take them in Chrome after loading the extension: the search form, the shortlist and a report.
