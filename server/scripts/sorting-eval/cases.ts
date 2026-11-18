/**
 * Made-up emails for measuring how Timmy sorts mail (scripts/eval-sorting.mts). None is real mail. Each has the box a
 * busy person at work would want it in:
 *   follow-up     they have to reply or do something;
 *   read-through  worth reading, nothing to do (newsletters they subscribe to, FYIs and updates from people);
 *   archived      needs nothing (receipts, promotions, notices, cold pitches, calendar replies, thank-yous).
 * Labels are the Gmail tabs such mail usually lands in.
 */
export type Box = 'follow-up' | 'read-through' | 'archived';
export interface Case {
  id: string;
  expect: Box;
  sender: string;
  name: string;
  subject: string;
  text: string;
  labels: string[];
}

const FOOTER = '\n\nYou are receiving this email because you signed up. Unsubscribe | Manage preferences\n123 Market St, San Francisco, CA';
const inbox = (cat: string) => ['INBOX', 'UNREAD', `CATEGORY_${cat}`];

export const CASES: Case[] = [
  /* ── Follow up: someone needs something from the person ── */
  { id: 'client-quote', expect: 'follow-up', sender: 'dana@acmecorp.com', name: 'Dana Whitfield', subject: 'Revised quote for the 120 seats?', text: 'Hi Morgan,\n\nCould you send the revised quote for 120 seats by Friday? Finance needs it before they close the month.\n\nThanks,\nDana', labels: inbox('PERSONAL') },
  { id: 'colleague-review', expect: 'follow-up', sender: 'sam@brightkits.co', name: 'Sam Rivera', subject: 'Deck review before 3pm', text: 'Hey, can you take a look at the investor deck before 3pm today? Mostly slides 4-7.\n\nSam', labels: inbox('PERSONAL') },
  { id: 'investor-call', expect: 'follow-up', sender: 'lee@northpeakvc.com', name: 'Lee Park', subject: 'Catch up this week?', text: 'Morgan, are you free Thursday or Friday afternoon for 30 minutes? Want to hear how the beta is going.\n\nBest,\nLee', labels: inbox('PERSONAL') },
  { id: 'vendor-po', expect: 'follow-up', sender: 'billing.team@printhaus.co', name: 'Maria (PrintHaus)', subject: 'PO number for invoice 4471', text: 'Hi, we can’t process invoice 4471 without a PO number. Could you reply with the PO so we can release the order?\n\nMaria\nPrintHaus Accounts', labels: inbox('PERSONAL') },
  { id: 'docusign', expect: 'follow-up', sender: 'dse@docusign.net', name: 'Dana Whitfield via DocuSign', subject: 'Please DocuSign: Acme MSA 2027', text: 'Dana Whitfield sent you a document to review and sign.\n\nREVIEW DOCUMENT\n\nPlease review the MSA and sign by Nov 22.\n\nDo Not Share This Email. This email contains a secure link to DocuSign.', labels: inbox('UPDATES') },
  { id: 'gdocs-mention', expect: 'follow-up', sender: 'comments-noreply@docs.google.com', name: 'Sam Rivera (Google Docs)', subject: 'Q1 plan - @morgan can you confirm the budget numbers?', text: 'Sam Rivera mentioned you in a comment in Q1 plan:\n\n"@morgan can you confirm the budget numbers in section 3?"\n\nReply\n\nGoogle LLC. You have received this email because you are mentioned in this thread. Change what Google Docs sends you.', labels: inbox('UPDATES') },
  { id: 'calendar-invite', expect: 'follow-up', sender: 'lee@northpeakvc.com', name: 'Lee Park', subject: 'Invitation: Beta review @ Thu Nov 20, 2pm - 2:30pm (PST)', text: 'Lee Park has invited you to Beta review.\n\nThursday Nov 20 2pm – 2:30pm (Pacific Time)\n\nGoing? Yes - Maybe - No\n\nInvitation from Google Calendar', labels: inbox('PERSONAL') },
  { id: 'github-review', expect: 'follow-up', sender: 'notifications@github.com', name: 'Sam Rivera', subject: '[timmy] Add Drive editing (PR #42)', text: '@samrivera requested your review on: MorganAki/timmy#42 Add Drive editing.\n\n—\nReply to this email directly, view it on GitHub, or unsubscribe.\nYou are receiving this because your review was requested.', labels: inbox('UPDATES') },
  { id: 'customer-escalation', expect: 'follow-up', sender: 'jordan@brightlane.io', name: 'Jordan Ellis', subject: 'Our media kit links are broken', text: 'Hi team,\n\nAll the media kit links we shared with brands this week return a 404. We have a pitch tomorrow morning. Can someone look at this today?\n\nJordan', labels: inbox('PERSONAL') },
  { id: 'contract-ask', expect: 'follow-up', sender: 'priya.n@gmail.com', name: 'Priya Natarajan', subject: 'contract', text: 'hey! can you send me the signed contract when you get a sec? need it for my records\n\np', labels: inbox('PERSONAL') },
  { id: 'accountant', expect: 'follow-up', sender: 'mark@ledgerline.cpa', name: 'Mark Ostrander', subject: 'Receipts for Q4', text: 'Hi Morgan,\n\nPlease send me your Q4 receipts by November 30 so we can file on time. A shared folder is fine.\n\nMark Ostrander, CPA', labels: inbox('PERSONAL') },
  { id: 'client-via-hubspot', expect: 'follow-up', sender: 'kim.ortega@lumenbrands.com', name: 'Kim Ortega', subject: 'Re: Proposal for the spring campaign', text: 'Hi Morgan,\n\nThanks for the proposal. Can you confirm the start date and whether the 3 UGC creators are included in the price?\n\nKim Ortega\nBrand Lead, Lumen' + FOOTER, labels: inbox('PERSONAL') },
  { id: 'partner-question', expect: 'follow-up', sender: 'alex@creatorhq.co', name: 'Alex Moreau', subject: 'Quick question on the rev share', text: 'Morgan, quick one: is the 20% rev share on gross or net? Need to tell our creators by Monday.\n\nAlex', labels: inbox('PERSONAL') },

  /* ── Read through: worth reading, nothing to do ── */
  { id: 'substack', expect: 'read-through', sender: 'lenny@substack.com', name: 'Lenny’s Newsletter', subject: 'How the best founders run their first 100 customer calls', text: 'This week: a playbook for your first 100 customer conversations, with templates from 30 founders...\n\nRead in app' + FOOTER, labels: inbox('UPDATES') },
  { id: 'daily-brief', expect: 'read-through', sender: 'crew@morningbrew.com', name: 'Morning Brew', subject: '☕ Ad spend rebounds', text: 'Good morning. Ad budgets are back: brands plan to raise creator spend 18% next year...\n\nView in browser' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'colleague-fyi', expect: 'read-through', sender: 'sam@brightkits.co', name: 'Sam Rivera', subject: 'FYI: launch moved to Dec 2', text: 'FYI, the brand launch moved to Dec 2 because of the holiday freeze. No action needed on your side, just so you know.\n\nSam', labels: inbox('PERSONAL') },
  { id: 'all-hands', expect: 'read-through', sender: 'ceo@brightkits.co', name: 'Jo Bennett', subject: 'Notes from Monday’s all-hands', text: 'Team,\n\nHere are the notes from Monday: revenue is up 22% on last quarter, we are hiring two creators’ managers, and the office closes Dec 24 to Jan 2.\n\nJo', labels: inbox('PERSONAL') },
  { id: 'investor-update', expect: 'read-through', sender: 'founders@pixelpine.app', name: 'PixelPine Founders', subject: 'PixelPine investor update: October', text: 'Hi investors,\n\nOctober highlights: MRR $84k (+11%), shipped the Shopify app, burn down 8%. Asks: intros to DTC brands doing UGC.\n\nThanks for your support,\nThe PixelPine team', labels: inbox('UPDATES') },
  { id: 'industry-report', expect: 'read-through', sender: 'newsletter@creatoreconomy.so', name: 'Creator Economy Report', subject: 'The state of UGC pricing in 2026', text: 'Average UGC video rates rose to $212 this year. Here’s the breakdown by platform and niche...' + FOOTER, labels: inbox('UPDATES') },
  { id: 'team-weekly', expect: 'read-through', sender: 'ops@brightkits.co', name: 'Ops Weekly', subject: 'Ops weekly: 14 kits shipped, 2 churned', text: 'This week: 14 media kits shipped, 2 accounts churned (both seasonal), NPS 61. Full dashboard in Notion.', labels: inbox('PERSONAL') },

  /* ── Archived: needs nothing ── */
  { id: 'amazon-shipped', expect: 'archived', sender: 'shipment-tracking@amazon.com', name: 'Amazon.com', subject: 'Your Amazon.com order has shipped', text: 'Your package is on the way. Arriving Thursday.\n\nTrack package', labels: inbox('UPDATES') },
  { id: 'stripe-receipt', expect: 'archived', sender: 'receipts@stripe.com', name: 'Stripe', subject: 'Your receipt from Figma #1823-4471', text: 'Receipt from Figma. Amount paid $45.00. Date paid Nov 17, 2026.', labels: inbox('UPDATES') },
  { id: 'promo', expect: 'archived', sender: 'deals@shopbrand.com', name: 'ShopBrand', subject: 'Black Friday: 40% off everything', text: 'Our biggest sale of the year starts now. 40% off sitewide, today only. Shop now' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'linkedin', expect: 'archived', sender: 'messages-noreply@linkedin.com', name: 'LinkedIn', subject: 'You appeared in 12 searches this week', text: 'See who’s looking at your profile.' + FOOTER, labels: inbox('SOCIAL') },
  { id: 'cal-accepted', expect: 'archived', sender: 'lee@northpeakvc.com', name: 'Lee Park', subject: 'Accepted: Beta review @ Thu Nov 20, 2pm', text: 'Lee Park has accepted this invitation.', labels: inbox('PERSONAL') },
  { id: 'slack-digest', expect: 'archived', sender: 'notification@slack.com', name: 'Slack', subject: 'You have 5 unread messages in BrightKits', text: 'Catch up on what you missed in #general and #sales.\n\nOpen Slack' + FOOTER, labels: inbox('UPDATES') },
  { id: 'security-notice', expect: 'archived', sender: 'no-reply@accounts.google.com', name: 'Google', subject: 'Security alert: new sign-in on Mac', text: 'We noticed a new sign-in to your Google Account on a Mac device. If this was you, you don’t need to do anything.', labels: inbox('UPDATES') },
  { id: 'cold-outreach', expect: 'archived', sender: 'ryan.b@leadgenius.io', name: 'Ryan Brooks', subject: 'Quick question about your growth plans', text: 'Hi Morgan,\n\nI noticed BrightKits is hiring. We help agencies book 30+ meetings a month with outbound. Worth a 15 minute chat next week?\n\nRyan' + FOOTER, labels: inbox('PERSONAL') },
  { id: 'webinar', expect: 'archived', sender: 'marketing@hubspot.com', name: 'HubSpot', subject: 'Webinar: AI for agencies (Thursday)', text: 'Join us Thursday for a live session on AI workflows for agencies. Save your seat.' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'thanks', expect: 'archived', sender: 'dana@acmecorp.com', name: 'Dana Whitfield', subject: 'Re: Revised quote', text: 'Got it, thanks so much!\n\nDana', labels: inbox('PERSONAL') },
  { id: 'calendly', expect: 'archived', sender: 'notifications@calendly.com', name: 'Calendly', subject: 'New Event: Jordan Ellis - 30 Minute Meeting', text: 'A new event has been scheduled. Invitee: Jordan Ellis. Event date: Fri Nov 21, 10am. The event is on your calendar.', labels: inbox('UPDATES') },
  { id: 'zoom-recording', expect: 'archived', sender: 'no-reply@zoom.us', name: 'Zoom', subject: 'Cloud Recording - Beta review is now available', text: 'Your cloud recording is now available. Share recording.', labels: inbox('UPDATES') },
  { id: 'bank-statement', expect: 'archived', sender: 'alerts@chase.com', name: 'Chase', subject: 'Your statement is ready', text: 'Your November statement for account ending 4471 is ready to view online.', labels: inbox('UPDATES') },
  { id: 'notion-digest', expect: 'archived', sender: 'notify@mail.notion.so', name: 'Notion', subject: 'Updates in BrightKits workspace', text: '3 pages were edited this week by your team.' + FOOTER, labels: inbox('UPDATES') },
  { id: 'saas-product-update', expect: 'archived', sender: 'team@figma.com', name: 'Figma', subject: 'What’s new in Figma: November', text: 'New this month: auto layout 6, faster prototyping and more.' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'eventbrite', expect: 'archived', sender: 'noreply@event.eventbrite.com', name: 'Eventbrite', subject: 'Events near you this weekend', text: 'Popular events in San Francisco this weekend.' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'ci-success', expect: 'archived', sender: 'notifications@github.com', name: 'GitHub', subject: '[timmy] Run succeeded: CI - main', text: 'All jobs have succeeded.\n\nYou are receiving this because you are subscribed to this thread. Unsubscribe.', labels: inbox('UPDATES') },
];
