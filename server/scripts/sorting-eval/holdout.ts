/** A second set of made-up emails, written after the sorting fix and never tuned on (see cases.ts for the labels). */
import type { Case } from './cases';

const FOOTER = '\n\nUnsubscribe from these emails · Update your preferences\n500 Howard St, San Francisco';
const inbox = (cat: string) => ['INBOX', 'UNREAD', `CATEGORY_${cat}`];

export const HOLDOUT: Case[] = [
  // Follow up
  { id: 'h-landlord', expect: 'follow-up', sender: 'grace.kim@baylandsproperty.com', name: 'Grace Kim', subject: 'Lease renewal for suite 210', text: 'Hi Morgan, your lease ends Jan 31. Would you like to renew for 12 months at the same rate? I need an answer by Dec 5.\n\nGrace', labels: inbox('PERSONAL') },
  { id: 'h-hire', expect: 'follow-up', sender: 'nina.alvarez@gmail.com', name: 'Nina Alvarez', subject: 'Re: Creator manager role', text: 'Thanks for the call! When would be a good time for the second interview? I’m free most of next week.\n\nNina', labels: inbox('PERSONAL') },
  { id: 'h-jira', expect: 'follow-up', sender: 'jira@brightkits.atlassian.net', name: 'Sam Rivera (Jira)', subject: '[JIRA] Sam Rivera assigned BK-212 to you', text: 'Sam Rivera assigned BK-212 to you: Fix the export button on media kits.\n\nGet Jira notifications on your phone. Manage notifications.', labels: inbox('UPDATES') },
  { id: 'h-approval', expect: 'follow-up', sender: 'no-reply@expensify.com', name: 'Expensify', subject: 'Action required: Sam Rivera submitted a report for approval', text: 'Sam Rivera submitted an expense report of $412.18 that needs your approval.\n\nReview report', labels: inbox('UPDATES') },
  { id: 'h-brand-brief', expect: 'follow-up', sender: 'tom@northwind.com', name: 'Tom Becker', subject: 'Brief for the January drop', text: 'Morgan — attached is the brief. Can we get 5 creator options by Wednesday? Budget is $8k.\n\nTom', labels: inbox('PERSONAL') },
  { id: 'h-meeting-move', expect: 'follow-up', sender: 'ana@brightkits.co', name: 'Ana Silva', subject: 'Move our 1:1?', text: 'Something came up Thursday. Does Friday 10am work instead?', labels: inbox('PERSONAL') },
  { id: 'h-invite-external', expect: 'follow-up', sender: 'calendar-notification@google.com', name: 'Kim Ortega', subject: 'Invitation: Lumen x BrightKits kickoff @ Mon Nov 24, 11am', text: 'Kim Ortega has invited you to Lumen x BrightKits kickoff. Going? Yes - Maybe - No', labels: inbox('PERSONAL') },
  { id: 'h-legal', expect: 'follow-up', sender: 'r.chen@chenlegal.com', name: 'Rachel Chen', subject: 'Redlines on the creator agreement', text: 'I’ve made redlines to sections 4 and 9. Please review and let me know if you accept them before I send to the other side.\n\nRachel', labels: inbox('PERSONAL') },

  // Read through
  { id: 'h-beehiiv', expect: 'read-through', sender: 'creatorweekly@mail.beehiiv.com', name: 'Creator Weekly', subject: 'Issue 87: TikTok Shop’s holiday playbook', text: 'Welcome back. This week: how brands are planning TikTok Shop for the holidays...\n\nRead online' + FOOTER, labels: inbox('UPDATES') },
  { id: 'h-colleague-notes', expect: 'read-through', sender: 'ana@brightkits.co', name: 'Ana Silva', subject: 'Notes from the Lumen call', text: 'Sharing my notes from today: they liked option B, want to start in January, budget approval expected next week. Nothing needed from you yet.\n\nAna', labels: inbox('PERSONAL') },
  { id: 'h-board-memo', expect: 'read-through', sender: 'jo@brightkits.co', name: 'Jo Bennett', subject: 'Board meeting recap', text: 'Quick recap of today’s board meeting: approved the 2027 budget, agreed to start the seed extension in Q1. Full minutes to follow.\n\nJo', labels: inbox('PERSONAL') },
  { id: 'h-stratechery', expect: 'read-through', sender: 'email@stratechery.com', name: 'Stratechery', subject: 'The creator economy’s second act', text: 'Today’s Update: why platforms are paying creators again...\n\nView in browser' + FOOTER, labels: inbox('UPDATES') },

  // Archived
  { id: 'h-uber', expect: 'archived', sender: 'noreply@uber.com', name: 'Uber Receipts', subject: 'Your Tuesday evening trip with Uber', text: 'Thanks for riding. Total $23.40.', labels: inbox('UPDATES') },
  { id: 'h-doordash-promo', expect: 'archived', sender: 'no-reply@doordash.com', name: 'DoorDash', subject: '$0 delivery fee this weekend 🍕', text: 'Get $0 delivery on orders over $15 this weekend only.' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'h-declined', expect: 'archived', sender: 'tom@northwind.com', name: 'Tom Becker', subject: 'Declined: Weekly sync @ Wed', text: 'Tom Becker has declined this invitation.', labels: inbox('PERSONAL') },
  { id: 'h-x-notif', expect: 'archived', sender: 'info@x.com', name: 'X', subject: 'Trending in your network', text: 'See what people are talking about.' + FOOTER, labels: inbox('SOCIAL') },
  { id: 'h-vercel', expect: 'archived', sender: 'notifications@vercel.com', name: 'Vercel', subject: 'Deployment ready: brightkits-web', text: 'Your deployment is ready. Visit preview.\n\nManage notification settings.', labels: inbox('UPDATES') },
  { id: 'h-cold-seo', expect: 'archived', sender: 'jake.m@rankrocket.agency', name: 'Jake Miller', subject: 'Your website traffic', text: 'Hi Morgan,\n\nI ran a quick audit of brightkits.co and found 14 issues hurting your rankings. Can I send over the report?\n\nJake' + FOOTER, labels: inbox('PERSONAL') },
  { id: 'h-okay', expect: 'archived', sender: 'tom@northwind.com', name: 'Tom Becker', subject: 'Re: Brief for the January drop', text: 'Perfect, thanks Morgan!', labels: inbox('PERSONAL') },
  { id: 'h-delivery-update', expect: 'archived', sender: 'tracking@ups.com', name: 'UPS', subject: 'UPS Update: Package scheduled for delivery Thursday', text: 'Your package is scheduled for delivery Thursday by end of day.', labels: inbox('UPDATES') },
  { id: 'h-saas-trial', expect: 'archived', sender: 'hello@canva.com', name: 'Canva', subject: 'Your Pro trial ends in 3 days', text: 'Keep designing with Pro. Upgrade now to keep your brand kit.' + FOOTER, labels: inbox('PROMOTIONS') },
  { id: 'h-google-share', expect: 'read-through', sender: 'drive-shares-dm-noreply@google.com', name: 'Ana Silva (via Google Drive)', subject: 'Document shared with you: "Lumen call notes"', text: 'Ana Silva shared a document with you. Open', labels: inbox('UPDATES') },
  { id: 'h-receipt-question', expect: 'follow-up', sender: 'accounts@brightprint.co', name: 'BrightPrint Accounts', subject: 'Invoice 9921 overdue', text: 'Hi, invoice 9921 for $1,240 is now 15 days overdue. Can you let us know when payment will be made?\n\nThanks, BrightPrint Accounts', labels: inbox('UPDATES') },
  { id: 'h-mailer-bounce', expect: 'archived', sender: 'mailer-daemon@googlemail.com', name: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)', text: 'Your message to old@acme.test couldn’t be delivered.', labels: inbox('UPDATES') },
];
