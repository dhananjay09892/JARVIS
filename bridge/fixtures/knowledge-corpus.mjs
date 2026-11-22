/**
 * A small invented set of notes for the knowledge base tests, with questions
 * written separately from the text (paraphrases, not copied phrases). Nothing
 * here is real data.
 */
export const CORPUS = {
  'work/pricing-meeting.md': `# Pricing meeting, 14 March

Sam argued that the starter plan should cost 12 dollars a month, not 9. The team agreed to raise it after the June release.
Priya will update the pricing page by 20 March.

Decision: annual billing gets a two month discount.`,
  'work/roadmap.md': `# Roadmap 2026

The mobile app beta opens in September. Voice search ships in October, behind a setting.

The offline mode is postponed to next year because the sync engine needs a rewrite.`,
  'work/onboarding.txt': `New hire checklist.

Day one: collect laptop from the front desk, set up two-factor sign in, and join the team chat.
Day two: shadow a support call. Day three: read the security handbook.`,
  'home/boiler-service.md': `Boiler service notes.

The boiler was serviced on 2 November by Hartley Heating. The engineer replaced the pressure valve and said the next service is due in November next year.
Warranty number is on the green card in the kitchen drawer.`,
  'home/car-insurance.md': `Car insurance renewal.

The policy with Northgate renews on 9 January. Annual premium is 540 pounds. The excess is 250 pounds for any claim, and a courtesy car is included.`,
  'home/recipes/lentil-soup.md': `Lentil soup.

Rinse one cup of red lentils. Fry onion and garlic, add cumin and the lentils, then cover with vegetable stock. Simmer for twenty minutes and finish with lemon juice.`,
  'travel/lisbon-trip.md': `Lisbon trip, May.

Flight lands at 9:40 on Friday. The hotel in Alfama has a free cancellation until 1 May. Book the tram 28 early because the queue gets long by 11.

Dinner on Saturday at the small fish place near the cathedral.`,
  'study/rust-ownership.md': `Rust ownership notes.

Every value has one owner. When the owner goes out of scope the value is dropped. Borrowing lets code use a value without taking ownership, and a mutable borrow must be the only borrow at that time.`,
  'study/ગુજરાતી-નોંધ.md': `ગુજરાતી નોંધ.

ઉત્તરાયણ પર પતંગ ઉડાડવા માટે સવારે વહેલા અગાસી પર જવું. દોરી માંજા વગરની લેવી.`,
  'study/हिंदी-नोट.md': `हिंदी नोट।

दिवाली की सफाई धनतेरस से पहले पूरी करनी है। रसोई और बालकनी आख़िर में रखें।`,
  'finance/receipts.md': `Receipts to file.

Laptop stand, 34 pounds, bought 3 February from the Bristol shop. Monitor arm, 58 pounds. Keep both for the expense claim.`,
  'finance/secrets.txt': `Router admin password is hunter2hunter2 and the key is sk-abcdefghijklmnopqrstuvwxyz123456.
Wifi name is HomeNet and the guests use the second network.`,
}

/** `file` is the expected file, `contains` a phrase the right passage holds. */
export const QUESTIONS = [
  { q: 'How much did Sam want the starter plan to cost?', file: 'work/pricing-meeting.md', contains: '12 dollars' },
  { q: 'What discount did we agree for annual billing?', file: 'work/pricing-meeting.md', contains: 'two month discount' },
  { q: 'Who is updating the pricing page?', file: 'work/pricing-meeting.md', contains: 'Priya' },
  { q: 'When does the mobile beta open?', file: 'work/roadmap.md', contains: 'September' },
  { q: 'Why was offline mode delayed?', file: 'work/roadmap.md', contains: 'sync engine' },
  { q: 'What do I do on my first day at the new job?', file: 'work/onboarding.txt', contains: 'laptop' },
  { q: 'Who serviced the boiler and when?', file: 'home/boiler-service.md', contains: 'Hartley Heating' },
  { q: 'Where is the boiler warranty number?', file: 'home/boiler-service.md', contains: 'kitchen drawer' },
  { q: 'When does the car insurance renew?', file: 'home/car-insurance.md', contains: '9 January' },
  { q: 'What is the excess on my car policy?', file: 'home/car-insurance.md', contains: '250 pounds' },
  { q: 'How long do I simmer the lentils?', file: 'home/recipes/lentil-soup.md', contains: 'twenty minutes' },
  { q: 'What time does the flight to Lisbon land?', file: 'travel/lisbon-trip.md', contains: '9:40' },
  { q: 'Until when can I cancel the Alfama hotel for free?', file: 'travel/lisbon-trip.md', contains: '1 May' },
  { q: 'What happens to a value when its owner goes out of scope in Rust?', file: 'study/rust-ownership.md', contains: 'dropped' },
  { q: 'Can there be two mutable borrows at once?', file: 'study/rust-ownership.md', contains: 'mutable borrow' },
  { q: 'પતંગ ઉડાડવા ક્યારે જવું?', file: 'study/ગુજરાતી-નોંધ.md', contains: 'સવારે વહેલા' },
  { q: 'दिवाली की सफाई कब तक पूरी करनी है?', file: 'study/हिंदी-नोट.md', contains: 'धनतेरस' },
  { q: 'How much was the laptop stand?', file: 'finance/receipts.md', contains: '34 pounds' },
  { q: 'What is the name of the wifi network?', file: 'finance/secrets.txt', contains: 'HomeNet' },
  { q: 'Which tram should I book early in Lisbon?', file: 'travel/lisbon-trip.md', contains: 'tram 28' },
  { q: 'Where is the wedding venue?', none: true },
  { q: "What is my dentist's phone number?", none: true },
  { q: 'Who won the football match last night?', none: true },
  { q: 'What is my blood group?', none: true },
  { q: 'xyzzy plugh', none: true },
]
