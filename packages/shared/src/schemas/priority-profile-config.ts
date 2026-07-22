// Product content for the priority profile: enum constants, UI labels, and
// curated mappings. Config, not logic — the zod schema, summary builder, and
// classification overrides only read from here, so updating a domain list or
// label never touches code. Every enum is a named const object so frontend,
// backend, prompts, and tests share the exact same values (no string
// literals scattered around).

// ── Enum constants ────────────────────────────────────────────────────

export const ROLE = {
  STUDENT: "student",
  PROFESSIONAL: "professional",
  FOUNDER: "founder",
  FREELANCER: "freelancer",
  RETIRED: "retired",
} as const;

export const CURRENT_SITUATION = {
  LOOKING_FOR_JOB: "looking_for_job",
  WORKING_FULL_TIME: "working_full_time",
  BUILDING_STARTUP: "building_startup",
  PREPARING_FOR_EXAMS: "preparing_for_exams",
  PREPARING_HIGHER_STUDIES: "preparing_higher_studies",
  CAREER_BREAK: "career_break",
  MOVING_CITIES: "moving_cities",
  RETIRED_LIFE: "retired_life",
} as const;

export const PRIORITY_MODE = {
  NEVER_MISS: "never_miss",
  BALANCED: "balanced",
  REDUCE_CLUTTER: "reduce_clutter",
  AGGRESSIVE: "aggressive",
} as const;

// The Likert answer shown in the UI ("I never want to miss important
// emails") — priorityMode itself is never exposed to users.
export const LIKERT_ANSWER = {
  STRONGLY_AGREE: "strongly_agree",
  AGREE: "agree",
  NEUTRAL: "neutral",
  FEWER_NOTIFICATIONS: "fewer_notifications",
} as const;

export const GOAL = {
  JOB_SEARCH: "job_search",
  STARTUP: "startup",
  COLLEGE: "college",
  FREELANCING: "freelancing",
  CONTENT_CREATION: "content_creation",
  INVESTING: "investing",
  HOUSE: "house",
  WEDDING: "wedding",
  NETWORKING: "networking",
  LEARNING: "learning",
  OTHER: "other",
} as const;

export const CURRENT_FOCUS = {
  RAISING_FUNDING: "raising_funding",
  APPLYING_JOBS: "applying_jobs",
  TAX_FILING: "tax_filing",
  TRAVEL: "travel",
  WEDDING_PLANNING: "wedding_planning",
  PRODUCT_LAUNCH: "product_launch",
  EXAMS: "exams",
  RELOCATION: "relocation",
  OTHER: "other",
} as const;

export const SENDER_CATEGORY = {
  RECRUITERS: "recruiters",
  BANKS: "banks",
  SHOPPING: "shopping",
  UNIVERSITIES: "universities",
  GOVERNMENT: "government",
  INSURANCE: "insurance",
  HEALTHCARE: "healthcare",
  INVESTMENTS: "investments",
} as const;

export const TOPIC = {
  JOB_SEARCH: "job_search",
  FINANCE: "finance",
  SHIPPING: "shipping",
  EDUCATION: "education",
  LEGAL: "legal",
  HEALTH: "health",
  EVENTS: "events",
  DEV_TOOLS: "dev_tools",
  TRAVEL: "travel",
  WORK: "work",
} as const;

export const TOPIC_WEIGHT = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export const EXPECTED_EMAIL_TYPE = {
  WORK: "work",
  BANKING: "banking",
  SHOPPING: "shopping",
  INVESTMENTS: "investments",
  SCHOOL: "school",
  GITHUB: "github",
  FREELANCING: "freelancing",
  TRAVEL: "travel",
  GOVERNMENT: "government",
} as const;

export const SERVICE = {
  STRIPE: "stripe",
  GITHUB: "github",
  AWS: "aws",
  VERCEL: "vercel",
  NOTION: "notion",
  LINEAR: "linear",
  JIRA: "jira",
  SLACK: "slack",
  FIGMA: "figma",
  RAZORPAY: "razorpay",
  UPWORK: "upwork",
  CANVA: "canva",
} as const;

// ── Likert → priorityMode mapping ─────────────────────────────────────

export const LIKERT_TO_PRIORITY_MODE = {
  [LIKERT_ANSWER.STRONGLY_AGREE]: PRIORITY_MODE.NEVER_MISS,
  [LIKERT_ANSWER.AGREE]: PRIORITY_MODE.BALANCED,
  [LIKERT_ANSWER.NEUTRAL]: PRIORITY_MODE.BALANCED,
  [LIKERT_ANSWER.FEWER_NOTIFICATIONS]: PRIORITY_MODE.REDUCE_CLUTTER,
} as const;

// ── UI labels ─────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<string, string> = {
  [ROLE.STUDENT]: "Student",
  [ROLE.PROFESSIONAL]: "Working professional",
  [ROLE.FOUNDER]: "Founder",
  [ROLE.FREELANCER]: "Freelancer",
  [ROLE.RETIRED]: "Retired",
};

export const CURRENT_SITUATION_LABELS: Record<string, string> = {
  [CURRENT_SITUATION.LOOKING_FOR_JOB]: "Looking for a job",
  [CURRENT_SITUATION.WORKING_FULL_TIME]: "Working full time",
  [CURRENT_SITUATION.BUILDING_STARTUP]: "Building a startup",
  [CURRENT_SITUATION.PREPARING_FOR_EXAMS]: "Preparing for exams",
  [CURRENT_SITUATION.PREPARING_HIGHER_STUDIES]: "Preparing for higher studies",
  [CURRENT_SITUATION.CAREER_BREAK]: "Taking a career break",
  [CURRENT_SITUATION.MOVING_CITIES]: "Moving cities",
  [CURRENT_SITUATION.RETIRED_LIFE]: "Enjoying retired life",
};

export const GOAL_LABELS: Record<string, string> = {
  [GOAL.JOB_SEARCH]: "Job search",
  [GOAL.STARTUP]: "Startup",
  [GOAL.COLLEGE]: "College",
  [GOAL.FREELANCING]: "Freelancing",
  [GOAL.CONTENT_CREATION]: "Content creation",
  [GOAL.INVESTING]: "Investing",
  [GOAL.HOUSE]: "Buying a house",
  [GOAL.WEDDING]: "Wedding",
  [GOAL.NETWORKING]: "Networking",
  [GOAL.LEARNING]: "Learning",
  [GOAL.OTHER]: "Other",
};

export const CURRENT_FOCUS_LABELS: Record<string, string> = {
  [CURRENT_FOCUS.RAISING_FUNDING]: "Raising funding",
  [CURRENT_FOCUS.APPLYING_JOBS]: "Applying to jobs",
  [CURRENT_FOCUS.TAX_FILING]: "Tax filing",
  [CURRENT_FOCUS.TRAVEL]: "Travel",
  [CURRENT_FOCUS.WEDDING_PLANNING]: "Wedding planning",
  [CURRENT_FOCUS.PRODUCT_LAUNCH]: "Product launch",
  [CURRENT_FOCUS.EXAMS]: "Exams",
  [CURRENT_FOCUS.RELOCATION]: "Relocation",
  [CURRENT_FOCUS.OTHER]: "Something else",
};

export const SENDER_CATEGORY_LABELS: Record<string, string> = {
  [SENDER_CATEGORY.RECRUITERS]: "Recruiters",
  [SENDER_CATEGORY.BANKS]: "Banks",
  [SENDER_CATEGORY.SHOPPING]: "Shopping",
  [SENDER_CATEGORY.UNIVERSITIES]: "Universities",
  [SENDER_CATEGORY.GOVERNMENT]: "Government",
  [SENDER_CATEGORY.INSURANCE]: "Insurance",
  [SENDER_CATEGORY.HEALTHCARE]: "Healthcare",
  [SENDER_CATEGORY.INVESTMENTS]: "Investments",
};

export const TOPIC_LABELS: Record<string, string> = {
  [TOPIC.JOB_SEARCH]: "Job search",
  [TOPIC.FINANCE]: "Finance",
  [TOPIC.SHIPPING]: "Orders & shipping",
  [TOPIC.EDUCATION]: "Education",
  [TOPIC.LEGAL]: "Legal",
  [TOPIC.HEALTH]: "Health",
  [TOPIC.EVENTS]: "Events",
  [TOPIC.DEV_TOOLS]: "Developer tools",
  [TOPIC.TRAVEL]: "Travel",
  [TOPIC.WORK]: "Work",
};

export const EXPECTED_EMAIL_TYPE_LABELS: Record<string, string> = {
  [EXPECTED_EMAIL_TYPE.WORK]: "Work",
  [EXPECTED_EMAIL_TYPE.BANKING]: "Banking",
  [EXPECTED_EMAIL_TYPE.SHOPPING]: "Shopping",
  [EXPECTED_EMAIL_TYPE.INVESTMENTS]: "Investments",
  [EXPECTED_EMAIL_TYPE.SCHOOL]: "School / University",
  [EXPECTED_EMAIL_TYPE.GITHUB]: "GitHub",
  [EXPECTED_EMAIL_TYPE.FREELANCING]: "Freelancing",
  [EXPECTED_EMAIL_TYPE.TRAVEL]: "Travel",
  [EXPECTED_EMAIL_TYPE.GOVERNMENT]: "Government",
};

export const SERVICE_LABELS: Record<string, string> = {
  [SERVICE.STRIPE]: "Stripe",
  [SERVICE.GITHUB]: "GitHub",
  [SERVICE.AWS]: "AWS",
  [SERVICE.VERCEL]: "Vercel",
  [SERVICE.NOTION]: "Notion",
  [SERVICE.LINEAR]: "Linear",
  [SERVICE.JIRA]: "Jira",
  [SERVICE.SLACK]: "Slack",
  [SERVICE.FIGMA]: "Figma",
  [SERVICE.RAZORPAY]: "Razorpay",
  [SERVICE.UPWORK]: "Upwork",
  [SERVICE.CANVA]: "Canva",
};

export const PREFERENCE_LABELS: Record<string, string> = {
  securityAlerts: "Security alerts",
  bills: "Bills",
  calendarInvites: "Calendar invites",
  packageTracking: "Package tracking",
  newsletters: "Newsletters",
  promotions: "Promotions",
  socialNotifications: "Social notifications",
  githubNotifications: "GitHub notifications",
};

// ── Curated mappings ──────────────────────────────────────────────────

// Example domains per sender category. Used two ways: rendered into the LLM
// summary as concrete examples ("recruiters (LinkedIn, Greenhouse, …)"),
// and available for future deterministic matching. Not exhaustive — the LLM
// generalizes from the category name; these just anchor it.
export const CATEGORY_DOMAIN_MAP: Record<string, string[]> = {
  [SENDER_CATEGORY.RECRUITERS]: [
    "linkedin.com",
    "greenhouse.io",
    "ashbyhq.com",
    "lever.co",
    "naukri.com",
    "indeed.com",
    "wellfound.com",
  ],
  [SENDER_CATEGORY.BANKS]: [
    "hdfcbank.net",
    "icicibank.com",
    "axisbank.com",
    "sbi.co.in",
    "kotak.com",
    "chase.com",
  ],
  [SENDER_CATEGORY.SHOPPING]: [
    "amazon.in",
    "amazon.com",
    "flipkart.com",
    "myntra.com",
    "ebay.com",
  ],
  [SENDER_CATEGORY.UNIVERSITIES]: [
    "coursera.org",
    "edx.org",
    "udemy.com",
  ],
  [SENDER_CATEGORY.GOVERNMENT]: ["gov.in", "incometax.gov.in", "uidai.gov.in"],
  [SENDER_CATEGORY.INSURANCE]: [
    "policybazaar.com",
    "licindia.in",
    "acko.com",
  ],
  [SENDER_CATEGORY.HEALTHCARE]: [
    "practo.com",
    "apollo247.com",
    "1mg.com",
  ],
  [SENDER_CATEGORY.INVESTMENTS]: [
    "zerodha.com",
    "groww.in",
    "upstox.com",
    "coinbase.com",
    "vanguard.com",
  ],
};

// One-line meaning per topic, rendered into the LLM summary so the model
// leans on its own understanding of the topic instead of a keyword dump.
export const TOPIC_IMPLIED_MEANING: Record<string, string> = {
  [TOPIC.JOB_SEARCH]:
    "interviews, recruiter outreach, coding assessments, offers, applications",
  [TOPIC.FINANCE]: "invoices, bank statements, payments, taxes, bills",
  [TOPIC.SHIPPING]: "order confirmations, delivery updates, package tracking",
  [TOPIC.EDUCATION]: "courses, exams, results, admissions, scholarships",
  [TOPIC.LEGAL]: "contracts, agreements, notices, compliance",
  [TOPIC.HEALTH]: "appointments, reports, prescriptions, insurance claims",
  [TOPIC.EVENTS]: "invitations, meetups, conferences, webinars",
  [TOPIC.DEV_TOOLS]: "CI failures, deploy alerts, PR reviews, service incidents",
  [TOPIC.TRAVEL]: "bookings, itineraries, check-ins, visa updates",
  [TOPIC.WORK]: "meetings, deadlines, reports, team updates",
};
