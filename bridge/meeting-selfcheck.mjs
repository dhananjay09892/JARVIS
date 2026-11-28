/** The minutes accuracy self-check (Q133): a labelled test call (invented, no real people): what the minutes should capture. */
export const LABELLED_CALL = Object.freeze({
  segments: [
    ['Priya', 'Thanks everyone. The launch plan needs a pricing page and a launch date.'],
    ['Sam', 'We decided to go with the monthly plan for launch.'],
    ['Sam', 'I will send the pricing page draft by Friday.'],
    ['Priya', 'Action item: Lena to book the launch room for next week.'],
    ['Lena', 'The launch date depends on the pricing page, so the pricing page comes first.'],
    ['Priya', 'We agreed to review the launch plan again on the 3rd of December.'],
    ['Lena', 'I think the room is probably free.'],
    ['Priya', 'Can you share the notes with the team afterwards?'],
  ].map(([speaker, text]) => ({ speaker, text })),
  /** Each expected action item: its owner (or null) and words its text must contain. */
  actions: [
    { owner: 'Sam', words: ['send', 'pricing page draft'] },
    { owner: 'Lena', words: ['book', 'launch room'] },
    { owner: null, words: ['share', 'notes'] },
  ],
  decisions: [['monthly plan'], ['review the launch plan']],
})
