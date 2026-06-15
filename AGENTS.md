# MAILROID

Your Mail App on Steroids.

## Mission

Reduce inbox overload and meeting management overhead.

This is NOT a Gmail clone.

Every feature should answer:

"Does this save the user time compared to Gmail or Google Calendar?"

AI should improve workflows rather than exist for marketing purposes.

---

# Project Goals

Users can:

* Connect Gmail
* Connect Google Calendar
* Search emails semantically
* Send emails through chat
* Schedule meetings through chat
* View prioritized inboxes
* Generate daily briefings

---

# Hackathon Requirements

Mandatory

* Gmail Integration through Corsair
* Google Calendar Integration through Corsair

Bonus

* MCP Agent Chat
* Realtime Webhooks
* Priority Classification
* Vector Search
* Keyboard Shortcuts
* Command Palette

---

# Repository Structure

mailroid/
│
├── AGENTS.md
├── README.md
├── package.json
├── turbo.json
├── pnpm-workspace.yaml
├── .gitignore
│
├── apps/
│   │
│   ├── web/
│   │   ├── AGENTS.md
│   │   ├── public/
│   │   ├── app/
│   │   │   ├── (auth)/
│   │   │   ├── (protected)/
│   │   │   │   ├── calendar/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── inbox/
│   │   │   │   └── onboarding/
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   │   ├── calendar/
│   │   │   ├── inbox/
│   │   │   └── ui/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── providers/
│   │   ├── trpc/
│   │   └── package.json
│   │
│   └── api/
│       ├── src/
│       │   ├── scripts/
│       │   ├── trpc/
│       │   ├── server.ts
│       │   └── index.ts
│       └── package.json
│
├── packages/
│   │
│   ├── database/
│   │   ├── drizzle/
│   │   ├── models/
│   │   │   ├── auth.ts
│   │   │   ├── corsair-connections.ts
│   │   │   └── corsair.ts
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   └── package.json
│   │
│   ├── services/
│   │   ├── calendar/
│   │   ├── clients/
│   │   ├── gmail/
│   │   ├── tenant/
│   │   └── package.json
│   │
│   ├── trpc/
│   │   ├── client/
│   │   ├── server/
│   │   │   ├── routes/
│   │   │   │   ├── calendar/
│   │   │   │   ├── gmail/
│   │   │   │   ├── health/
│   │   │   │   └── tenant/
│   │   │   ├── context.ts
│   │   │   ├── schema.ts
│   │   │   └── trpc.ts
│   │   ├── services/
│   │   └── package.json
│   │
│   ├── corsair/
│   │   ├── src/
│   │   │   ├── calendar/
│   │   │   ├── gmail/
│   │   │   ├── webhooks/
│   │   │   ├── corsair.ts
│   │   │   ├── tenant.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── ai/
│   │   ├── src/
│   │   │   ├── agents/
│   │   │   ├── embeddings/
│   │   │   ├── prompts/
│   │   │   ├── tools/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── inngest/
│   │   ├── src/
│   │   │   ├── functions/
│   │   │   ├── client.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── logger/
│   │   ├── index.ts
│   │   └── package.json
│   │
│   └── shared/
│       ├── src/
│       │   ├── types/
│       │   └── index.ts
│       └── package.json
│
└── .github/
    └── workflows/
        ├── ci.yml
        └── deploy.yml

---

# Technology Decisions

Frontend

* Next.js
* React
* Tailwind
* shadcn/ui
* Framer Motion

Backend

* Express
* tRPC

Database

* PostgreSQL
* Drizzle
* pgvector

Authentication

* BetterAuth

AI

* OpenAI Responses API
* Tool Calling

Integrations

* Corsair Gmail
* Corsair Calendar
* Corsair MCP
* Corsair Webhooks

Background Jobs

* Inngest

---

# Non Negotiables

Do NOT replace:

* Express
* tRPC
* PostgreSQL
* Drizzle
* pgvector
* BetterAuth
* Corsair
* Inngest

Do NOT suggest:

* Prisma
* MongoDB
* Firebase
* Supabase
* Server Actions
* LangGraph
* CrewAI
* BullMQ
* Redis
* Pinecone

unless explicitly requested.

---

# Architecture Rules

web
-> api
-> shared

api
-> db
-> corsair
-> ai
-> inngest
-> shared

db
-> shared

corsair
-> shared

ai
-> shared

inngest
-> shared

shared
-> nothing

Avoid circular dependencies.

---

# Product Philosophy

Prioritize:

1. Workflow improvements
2. Speed
3. Simplicity
4. Reliability

Do not prioritize:

* flashy AI
* unnecessary abstraction
* multi-agent systems
* overengineering

---

# Core Features

## Gmail

Using Corsair:

* Connect account
* Read emails
* Search emails
* Send emails

## Calendar

Using Corsair:

* View events
* Create events
* Send invites

## Webhooks

Using Corsair:

New Email
→ Webhook
→ Store Email

## Vector Search

Using pgvector:

Store

* subject
* body
* sender
* embedding

Provide local semantic search.

## Priority Inbox

Email
→ LLM
→ Urgent | Important | Later

Store classification in database.

## Executive Assistant Chat

Supported actions:

* Search emails
* Send emails
* Create events
* Read events

Always use tools when available.

Never hallucinate emails or calendar events.

## Daily Briefing

Generate:

* Today's meetings
* Priority emails
* Recent context
* Suggested actions

Feature name:

Prepare Me For Today

---

# Database Tables

users

* id
* email

emails

* id
* userId
* gmailId
* sender
* subject
* body
* priority
* receivedAt
* embedding

calendar_events

* id
* userId
* eventId
* title
* startTime
* endTime

daily_briefs

* id
* userId
* date
* content

---

# Inngest Functions

gmail.initial-sync

* Fetch emails
* Store emails
* Generate embeddings

email.received

* Triggered from webhook
* Store email

email.embed

* Generate embedding
* Store vector

email.priority

* Classify priority

daily-brief.generate

* Meetings
* Priority emails
* Recent context

Generate briefing

---

# Coding Standards

* TypeScript strict mode
* Zod validation
* Prefer composition
* Thin routers
* Business logic in services
* Reusable components
* Explicit naming

Avoid:

* any
* giant files
* duplicated logic
* premature abstractions

---

# AI Instructions

Before implementing a feature:

1. Check if the feature helps the user save time.
2. Check if an existing package already owns the responsibility.
3. Reuse existing types and schemas.
4. Prefer simple solutions.
NodeNext everywhere
"type": "module" everywhere
".js" extensions everywhere
import/export everywhere
node --import tsx for development

When uncertain:

Ask for clarification, Don't make assumptions.

The goal is to ship a polished demo within 6 days.

### Corsair Learnings

- Corsair credentials are configured once at the instance level.
- Mailroid users do not run Corsair CLI commands.
- Every BetterAuth user maps to a Corsair tenant.
- OAuth credentials are stored by Corsair.
- Gmail and Calendar connections are isolated per tenant.
- Connect Link is the preferred production authentication flow.
- CLI auth commands are development helpers and should not be triggered from the application.

---

## Completed

### Day 1

#### Authentication
- BetterAuth integrated with Drizzle
- Google OAuth configured
- BetterAuth mounted on Express
- Session endpoint working
- Google sign-in working
- User creation verified
- Account creation verified
- Session creation verified
- Redirect authenticated users to frontend after login
- Protected routes implemented
- tRPC auth context implemented
- Protected procedures implemented

### Authentication
- Add session-aware layouts and route guards where required

### Corsair
- Create tenant for each Mailroid user
- Implement ensureTenant() helper
- Generate Connect Link from backend
- Build Connect Accounts flow in Settings page
- Connect Gmail account through Corsair Connect Link
- Connect Google Calendar account through Corsair Connect Link
- Store tenant metadata and connection metadata per user

### Day 2

#### Gmail Pipeline
- Built Gmail service layer using `corsair.withTenant().gmail.api`
- Implemented `getThreads`, `getThread`, `sendEmail`, `searchEmails`
- Used metadata-only fetching to optimize load times
- Created tRPC `gmailRouter` with Zod validation
- Built frontend `useThreads` hooks and minimal Inbox UI table

#### Calendar Pipeline
- Built Calendar service layer normalizing Google's payload
- Implemented `getEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`
- Added FullCalendar with month, week, and day views
- Implemented interactive UX: click-to-create, click-to-edit, drag-and-drop, and resize
- Built `EventModal` for creating and editing events with optimistic UI updates