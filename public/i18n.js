'use strict';

// Minimal i18n layer: English + Hebrew (RTL), extensible (req 3.11).
const I18N = {
  en: {
    dir: 'ltr',
    skip_to_content: 'Skip to content',
    nav_home: 'Home', nav_create: 'Create contest', nav_admin: 'Admin',
    footer_tagline: 'Community-judged competitions with live leaderboards.',
    footer_api: 'API spec',
    login: 'Log in', logout: 'Log out', register: 'Sign up', email: 'Email',
    password: 'Password', display_name: 'Display name', my_profile: 'My profile',
    search_placeholder: 'Search contests, tags, organizers…',
    all_categories: 'All categories', sort_newest: 'Newest', sort_popular: 'Most popular',
    category_photo: 'Photo', category_design: 'Design', category_code: 'Code',
    category_writing: 'Writing', category_video: 'Video', category_other: 'Other',
    featured: 'Contests', recommended: 'Recommended for you', no_contests: 'No contests found.',
    entries: 'entries', voters: 'voters', by: 'by',
    status_active: 'Active', status_finished: 'Finished', voting_open_now: 'Voting open',
    tab_details: 'Details', tab_entries: 'Entries', tab_vote: 'Vote',
    tab_leaderboard: 'Leaderboard', tab_comments: 'Comments',
    starts: 'Starts', ends: 'Ends', voting_window: 'Voting window', visibility: 'Visibility',
    public: 'Public', private: 'Private', blind_voting: 'Blind voting', on: 'on', off: 'off',
    criteria: 'Judging criteria', weight: 'weight', prizes: 'Prizes',
    follow: 'Follow', unfollow: 'Unfollow', join: 'Join contest', joined: 'Joined',
    submit_entry: 'Submit entry', entry_title: 'Entry title', description: 'Description',
    tags: 'Tags (comma separated)', content_text: 'Text / Markdown', content_code: 'Code',
    upload_file: 'Or upload a file (image, video ≤100MB, PDF)', submit: 'Submit',
    preview: 'Preview', no_entries: 'No entries yet. Be the first!',
    votes: 'votes', score: 'Score', comment: 'Comment', comments: 'Comments',
    add_comment: 'Add a comment…', post: 'Post', report: 'Report', report_reason: 'Why are you reporting this?',
    vote_for: 'Score this entry', weighted_total: 'Weighted total', confirm_vote: 'Confirm vote',
    vote_saved: 'Your vote was saved!', cannot_vote_own: 'This is your entry',
    login_to_vote: 'Log in to vote', voting_closed: 'Voting is closed',
    rank: 'Rank', entry: 'Entry', author: 'Author', pct_of_max: '% of max',
    export_csv: 'Export CSV', updated_ago: 'Updated {s}s ago', live: 'LIVE',
    score_history: 'Score history', no_votes_yet: 'No votes yet.',
    create_title: 'Create a new contest', contest_title: 'Title', category: 'Category',
    start_date: 'Start', end_date: 'End', voting_mode: 'Voting mode',
    voting_mode_open: 'Open (vote anytime)', voting_mode_closed: 'Closed (window only)',
    scale_max: 'Score scale (max points)', participant_cap: 'Participant cap (optional)',
    add_criterion: 'Add criterion', criterion_name: 'Criterion name',
    weights_sum: 'Weights must sum to 100. Current: {n}', add_prize: 'Add prize',
    prize_name: 'Prize name', prize_rank: 'For rank', create: 'Create',
    invite_code: 'Invite code', finish_contest: 'End contest & declare winners',
    created_contests: 'Created contests', joined_contests: 'Joined contests',
    wins_badges: 'Wins & badges', bio: 'Bio', save: 'Save', profile_public: 'Public profile',
    avatar_url: 'Avatar URL', export_my_data: 'Export my data',
    admin_reports: 'Moderation queue', admin_users: 'Users', admin_audit: 'Audit log',
    dismiss: 'Dismiss', remove_content: 'Remove content', ban_user: 'Ban user',
    no_reports: 'No open reports.', reported_by: 'Reported by', reason: 'Reason',
    notifications: 'Notifications', no_notifications: 'No notifications yet.',
    mark_all_read: 'Mark all read', winner: 'Winner',
    error_generic: 'Something went wrong', need_login: 'Please log in first',
    tab_timing: 'Timing', readers: 'RFID readers', add_reader: 'Add reader',
    reader_name: 'Reader name', reader_location: 'Location (e.g. finish line)',
    reader_token: 'Device token', copy: 'Copy', copied: 'Copied!',
    last_seen: 'Last seen', never: 'never', reads: 'reads', delete: 'Delete',
    live_reads: 'Live tag reads', no_reads: 'No tag reads yet. Connect the Android bridge app.',
    tag_assignments: 'Tag assignments', epc: 'EPC (tag ID)', bib: 'Bib',
    participant: 'Participant', assign: 'Assign', unassigned: 'unassigned',
    passings: 'Passings summary', passes: 'passes', first_read: 'First read',
    last_read: 'Last read', elapsed: 'Elapsed', reader_col: 'Reader',
    timing_help: 'Register a reader, then enter its device token and this server address in the VeloGrip RFID Android app. Tag reads will stream here live.',
  },
  he: {
    dir: 'rtl',
    skip_to_content: 'דלג לתוכן',
    nav_home: 'בית', nav_create: 'צור תחרות', nav_admin: 'ניהול',
    footer_tagline: 'תחרויות בשיפוט הקהילה עם טבלאות מובילים בזמן אמת.',
    footer_api: 'מפרט API',
    login: 'התחברות', logout: 'התנתקות', register: 'הרשמה', email: 'אימייל',
    password: 'סיסמה', display_name: 'שם תצוגה', my_profile: 'הפרופיל שלי',
    search_placeholder: 'חיפוש תחרויות, תגיות, מארגנים…',
    all_categories: 'כל הקטגוריות', sort_newest: 'החדשות ביותר', sort_popular: 'הפופולריות ביותר',
    category_photo: 'צילום', category_design: 'עיצוב', category_code: 'קוד',
    category_writing: 'כתיבה', category_video: 'וידאו', category_other: 'אחר',
    featured: 'תחרויות', recommended: 'מומלץ עבורך', no_contests: 'לא נמצאו תחרויות.',
    entries: 'הגשות', voters: 'מצביעים', by: 'מאת',
    status_active: 'פעילה', status_finished: 'הסתיימה', voting_open_now: 'ההצבעה פתוחה',
    tab_details: 'פרטים', tab_entries: 'הגשות', tab_vote: 'הצבעה',
    tab_leaderboard: 'טבלת מובילים', tab_comments: 'תגובות',
    starts: 'התחלה', ends: 'סיום', voting_window: 'חלון הצבעה', visibility: 'נראות',
    public: 'ציבורית', private: 'פרטית', blind_voting: 'הצבעה עיוורת', on: 'פעיל', off: 'כבוי',
    criteria: 'קריטריוני שיפוט', weight: 'משקל', prizes: 'פרסים',
    follow: 'עקוב', unfollow: 'הפסק לעקוב', join: 'הצטרף לתחרות', joined: 'הצטרפת',
    submit_entry: 'הגש עבודה', entry_title: 'כותרת ההגשה', description: 'תיאור',
    tags: 'תגיות (מופרדות בפסיק)', content_text: 'טקסט / Markdown', content_code: 'קוד',
    upload_file: 'או העלה קובץ (תמונה, וידאו ≤100MB, PDF)', submit: 'שלח',
    preview: 'תצוגה מקדימה', no_entries: 'אין הגשות עדיין. היה הראשון!',
    votes: 'קולות', score: 'ניקוד', comment: 'תגובה', comments: 'תגובות',
    add_comment: 'הוסף תגובה…', post: 'פרסם', report: 'דווח', report_reason: 'מדוע אתה מדווח על תוכן זה?',
    vote_for: 'דרג הגשה זו', weighted_total: 'ציון משוקלל', confirm_vote: 'אשר הצבעה',
    vote_saved: 'ההצבעה נשמרה!', cannot_vote_own: 'זו ההגשה שלך',
    login_to_vote: 'התחבר כדי להצביע', voting_closed: 'ההצבעה סגורה',
    rank: 'מקום', entry: 'הגשה', author: 'יוצר', pct_of_max: '% מהמקסימום',
    export_csv: 'ייצוא CSV', updated_ago: 'עודכן לפני {s} שניות', live: 'שידור חי',
    score_history: 'היסטוריית ניקוד', no_votes_yet: 'אין הצבעות עדיין.',
    create_title: 'יצירת תחרות חדשה', contest_title: 'כותרת', category: 'קטגוריה',
    start_date: 'התחלה', end_date: 'סיום', voting_mode: 'מצב הצבעה',
    voting_mode_open: 'פתוח (הצבעה בכל עת)', voting_mode_closed: 'סגור (חלון בלבד)',
    scale_max: 'סולם ניקוד (מקסימום)', participant_cap: 'מגבלת משתתפים (רשות)',
    add_criterion: 'הוסף קריטריון', criterion_name: 'שם הקריטריון',
    weights_sum: 'המשקלים חייבים להסתכם ב-100. כרגע: {n}', add_prize: 'הוסף פרס',
    prize_name: 'שם הפרס', prize_rank: 'למקום', create: 'צור',
    invite_code: 'קוד הזמנה', finish_contest: 'סיים תחרות והכרז על זוכים',
    created_contests: 'תחרויות שיצרתי', joined_contests: 'תחרויות שהצטרפתי',
    wins_badges: 'זכיות ותגים', bio: 'אודות', save: 'שמור', profile_public: 'פרופיל ציבורי',
    avatar_url: 'כתובת תמונת פרופיל', export_my_data: 'ייצוא הנתונים שלי',
    admin_reports: 'תור דיווחים', admin_users: 'משתמשים', admin_audit: 'יומן ביקורת',
    dismiss: 'דחה', remove_content: 'הסר תוכן', ban_user: 'חסום משתמש',
    no_reports: 'אין דיווחים פתוחים.', reported_by: 'דווח ע״י', reason: 'סיבה',
    notifications: 'התראות', no_notifications: 'אין התראות עדיין.',
    mark_all_read: 'סמן הכל כנקרא', winner: 'זוכה',
    error_generic: 'משהו השתבש', need_login: 'נא להתחבר תחילה',
    tab_timing: 'מדידת זמנים', readers: 'קוראי RFID', add_reader: 'הוסף קורא',
    reader_name: 'שם הקורא', reader_location: 'מיקום (למשל קו סיום)',
    reader_token: 'אסימון מכשיר', copy: 'העתק', copied: 'הועתק!',
    last_seen: 'נראה לאחרונה', never: 'אף פעם', reads: 'קריאות', delete: 'מחק',
    live_reads: 'קריאות תגים בזמן אמת', no_reads: 'אין קריאות תגים עדיין. חבר את אפליקציית הגשר לאנדרואיד.',
    tag_assignments: 'שיוך תגים', epc: 'EPC (מזהה תג)', bib: 'מספר חזה',
    participant: 'משתתף', assign: 'שייך', unassigned: 'לא משויך',
    passings: 'סיכום מעברים', passes: 'מעברים', first_read: 'קריאה ראשונה',
    last_read: 'קריאה אחרונה', elapsed: 'זמן שחלף', reader_col: 'קורא',
    timing_help: 'רשום קורא, ואז הזן את אסימון המכשיר ואת כתובת השרת באפליקציית VeloGrip RFID לאנדרואיד. קריאות התגים יוזרמו לכאן בזמן אמת.',
  },
};

let LANG = localStorage.getItem('lang') || 'en';

function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

function setLang(lang) {
  LANG = I18N[lang] ? lang : 'en';
  localStorage.setItem('lang', LANG);
  document.documentElement.lang = LANG;
  document.documentElement.dir = I18N[LANG].dir;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  const toggle = document.getElementById('lang-toggle');
  if (toggle) toggle.textContent = LANG === 'en' ? 'עברית' : 'English';
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(LANG === 'he' ? 'he-IL' : 'en-US', {
      dateStyle: 'medium', timeStyle: 'short',
    });
  } catch { return iso; }
}
